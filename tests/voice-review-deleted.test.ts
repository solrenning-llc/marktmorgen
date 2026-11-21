/**
 * "What customers are saying" (lib/customer-voice.ts) after a buyer deletes their own review (Claude 7's reviews
 * hunt, 14 November 2026; synthetic only: store, buyer, order and model are stand-ins). The month's summary may quote
 * a review's words, without the name, for about two months; only a person's erasure removed it. A buyer who deleted
 * their review (perhaps because it held something personal) still had their words quoted in the studio's summary,
 * after the review had left the product page, the store's quotes and the AI summary. Now the delete removes every
 * summary that quotes those words, and so does rewriting them; a summary that cannot be read is removed rather than kept.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/review/route";
import { keptMonths, readVoice, type VoiceSummary } from "@/lib/customer-voice";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReview, reviewId } from "@/lib/reviews";
import { TAKE_COMMANDS } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_voice_review_deleted_only";

const OWNER = "voice-del@example.com";
const HANDLE = "voice-del-shop";
const ACCOUNT = "acct_1TestVoiceDel01";
const SESSION = "cs_test_voicereviewdeleted0001";
const BUYER = "buyer-voice@example.com";
const WORDS = "Lovely course, but my teacher Ana kept calling me at home";

let productId = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com" && url.pathname === `/v1/checkout/sessions/${SESSION}`) {
    return Response.json({
      id: SESSION,
      status: "complete",
      payment_status: "paid",
      amount_total: 1000,
      created: Math.floor(Date.now() / 1000) - 3600,
      mode: "payment",
      metadata: { store: HANDLE, product: productId },
      customer_details: { email: BUYER },
      payment_intent: { id: "pi_VoiceReviewDel001", latest_charge: { refunded: false, amount_refunded: 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

async function send(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, session_id: SESSION, back: "review", ...fields })) form.set(k, v);
  return POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
}
const statusOf = (res: Response) => {
  const where = new URL(res.headers.get("location") ?? "https://x/");
  return where.searchParams.get("status") ?? where.searchParams.get("review");
};

function summaryQuoting(text: string, month: string): VoiceSummary {
  const theme = (title: string) => ({ title, count: 2, sources: { review: 2 }, examples: [{ source: "review" as const, text, n: 1, stars: 4 }, { source: "review" as const, text: "Clear lessons", n: 1, stars: 5 }] });
  return { at: Math.floor(Date.now() / 1000), month, read: { review: 9 }, themes: [theme("Teacher contact")], reviewThemes: [theme("Teacher contact")], other: 0 };
}
const quotes = (summary: VoiceSummary | null, text: string) =>
  [...(summary?.themes ?? []), ...(summary?.reviewThemes ?? [])].some((t) => t.examples.some((e) => e.text === text));

let counting = false;
let commands = 0;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (sent: (string | number)[][]) => {
  if (counting) commands += sent.length;
  return original(sent);
}) as typeof redis.pipeline;

async function main() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Voice Shop", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Pottery course", "Clay in a week.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;
  await setSubscription(OWNER, { customerId: "cus_VoiceDel000001", subscriptionId: "sub_VoiceDel000001", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;

  is("set-up: the review is written", statusOf(await send({ rating: "4", text: WORDS })), "saved");
  const now = Date.now();
  const [month, last] = keptMonths(now);
  await original([
    ["SET", `nl:voice:${statsId}:${month}`, JSON.stringify(summaryQuoting(WORDS, month)), "EX", 3600],
    ["SET", `nl:voice:${statsId}:${last}`, JSON.stringify(summaryQuoting(WORDS, last)), "EX", 3600],
  ]);
  is("set-up: the month's summary quotes the review", quotes(await readVoice(store, now), WORDS), true);

  part("The buyer deletes their review: the summary no longer quotes it");
  counting = true;
  is("the review is deleted", statusOf(await send({ action: "delete", confirm: "yes" })), "deleted");
  counting = false;
  is("it is gone at its source", await readReview(statsId, productId, reviewId(statsId, productId, BUYER)), null);
  is("no summary kept for the store still quotes the words", quotes(await readVoice(store, now), WORDS), false);
  const [older] = await original([["GET", `nl:voice:${statsId}:${last}`]]);
  is("nor last month's", typeof older === "string" && older.includes(WORDS), false);
  is(`the delete stays inside a buyer action's commands (${commands} sent)`, commands <= 100 + TAKE_COMMANDS, true);

  part("The buyer rewrites their review: the summary no longer quotes the old words");
  is("set-up: written again", statusOf(await send({ rating: "4", text: WORDS })), "saved");
  await original([["SET", `nl:voice:${statsId}:${month}`, JSON.stringify(summaryQuoting(WORDS, month)), "EX", 3600]]);
  counting = true;
  commands = 0;
  is("the words are rewritten", statusOf(await send({ rating: "4", text: "Lovely course" })), "updated");
  counting = false;
  is("the summary no longer quotes the old words", quotes(await readVoice(store, now), WORDS), false);
  is(`the rewrite stays inside a buyer action's commands (${commands} sent)`, commands <= 100 + TAKE_COMMANDS, true);
  await original([["SET", `nl:voice:${statsId}:${month}`, JSON.stringify(summaryQuoting("Lovely course", month)), "EX", 3600]]);
  is("the same words saved again", statusOf(await send({ rating: "5", text: "Lovely course" })), "updated");
  is("a summary quoting words that did not change stays", quotes(await readVoice(store, now), "Lovely course"), true);
  is("set-up: deleted", statusOf(await send({ action: "delete", confirm: "yes" })), "deleted");

  part("A summary that does not quote the deleted words is kept");
  is("set-up: written again", statusOf(await send({ rating: "5", text: "Short and kind" })), "saved");
  await original([["SET", `nl:voice:${statsId}:${month}`, JSON.stringify(summaryQuoting("Someone else's words", month)), "EX", 3600]]);
  is("deleted again", statusOf(await send({ action: "delete", confirm: "yes" })), "deleted");
  is("the summary quoting other words stays", quotes(await readVoice(store, now), "Someone else's words"), true);
  done();
}
void main();
