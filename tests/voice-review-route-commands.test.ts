/**
 * Claude 2 MDs16's LOW on #5375 @750367879c (comment 7103750438): the review deletion's DEL of the customer summary's
 * reader lock became a script (VOICE_FORGET), so the review route's delete and rewrite pay its calls. Measured here
 * end to end through app/api/store/review, every command billed as Upstash bills it (a script: 1, and 1 for each
 * redis.call in its text, an upper bound), at the worst: a summary being read (its lock held, so VOICE_FORGET marks
 * it) and a summary kept for every month a deletion reads.
 *
 *   - VOICE_FORGET runs once a request and adds exactly what its text bills over the DEL it replaced:
 *     VOICE_FORGET_COMMANDS - 1 (3), on the rewrite and on the deletion;
 *   - the route's whole totals are shown beside a public request's room (tests/traffic-cost.ts, COMMANDS.laterPage +
 *     COMMANDS.laterCount), at which the line "public-requests" of tests/plan-cost-registry.ts prices a review. The
 *     route was above that room before this change (the DEL path: the total less VOICE_FORGET_COMMANDS - 1); that
 *     gap is older than VOICE_FORGET and is its own board row, not hidden here.
 *
 * Synthetic store, buyer and words; in-memory Redis; no network.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST } from "@/app/api/store/review/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readReview, reviewId } from "@/lib/reviews";
import { VOICE_FORGET, VOICE_FORGET_COMMANDS, keptMonths } from "@/lib/customer-voice";
import { COMMANDS } from "./traffic-cost";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_voice_route_commands_only";

const OWNER = "voice-route-commands@example.com";
const HANDLE = "voice-route-commands";
const ACCOUNT = "acct_1TestVoiceCmds01";
const SESSION = "cs_test_voiceroutecommands001";
const BUYER = "buyer-voice-commands@example.com";

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
      payment_intent: { id: "pi_VoiceRouteCmds01", latest_charge: { refunded: false, amount_refunded: 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

/** Commands as Upstash bills them: a script is 1 and 1 for each redis.call in its text. */
const billed = (command: (string | number)[]) => (command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1);
let counting = false;
let total = 0;
let forgetBilled = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (counting) {
    for (const command of commands) {
      total += billed(command);
      if (command[0] === "EVAL" && command[1] === VOICE_FORGET) forgetBilled += billed(command);
    }
  }
  return real(commands);
}) as typeof redis.pipeline;

async function send(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, session_id: SESSION, back: "review", ...fields })) form.set(k, v);
  return POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
}
const statusOf = (res: Response) => {
  const where = new URL(res.headers.get("location") ?? "https://x/");
  return where.searchParams.get("status") ?? where.searchParams.get("review");
};

/** The route's commands for one request, the work it leaves for after its answer included. */
async function measured(fields: Record<string, string>): Promise<{ status: string | null; commands: number; forget: number }> {
  afterTasks.length = 0;
  total = 0;
  forgetBilled = 0;
  counting = true;
  const res = await send(fields);
  for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  counting = false;
  return { status: statusOf(res), commands: total, forget: forgetBilled };
}

/** The worst a deletion meets: a summary being read (its lock held) and one kept for every month it reads. */
async function worst(statsId: string, words: string): Promise<void> {
  const now = Date.now();
  const summary = (month: string) => JSON.stringify({ at: Math.floor(now / 1000), month, read: { review: 1 }, themes: [{ title: "t", count: 1, sources: { review: 1 }, examples: [{ source: "review", text: words, n: 1, stars: 4 }] }], other: 0 });
  await real([["SET", `nl:voice:lock:${statsId}`, "11111111-2222-3333-4444-555555555555", "EX", 120], ...keptMonths(now).map((month) => ["SET", `nl:voice:${statsId}:${month}`, summary(month), "EX", 3600])]);
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Voice Route Commands", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Sourdough course", "Bread in a week.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;
  await setSubscription(OWNER, { customerId: "cus_VoiceRouteCmds", subscriptionId: "sub_VoiceRouteCmds", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  const id = reviewId(statsId, productId, BUYER);
  const months = keptMonths(Date.now()).length;
  // A public request's room, and what the summaries add on top of it: one GET a month kept and their one DEL.
  const room = COMMANDS.laterPage + COMMANDS.laterCount;
  const extra = VOICE_FORGET_COMMANDS - 1;

  is("set-up: the review is written", statusOf(await send({ rating: "4", text: "Good loaves, first words." })), "saved");

  part("The script that replaced the DEL bills exactly what its text says");
  is(`VOICE_FORGET_COMMANDS is 1 and its ${VOICE_FORGET_COMMANDS - 1} calls`, VOICE_FORGET_COMMANDS, billed(["EVAL", VOICE_FORGET]));

  part("A rewrite of the words, at its worst");
  await worst(statsId, "Good loaves, first words.");
  const rewrite = await measured({ rating: "4", text: "Good loaves, second words." });
  is("rewritten", [rewrite.status, (await readReview(statsId, productId, id))?.text], ["updated", "Good loaves, second words."]);
  is(`the summary's reader marked once, billed ${VOICE_FORGET_COMMANDS} (${extra} over the DEL it replaced)`, rewrite.forget, VOICE_FORGET_COMMANDS);
  part(`Shown, not held here: the rewrite's whole route is ${rewrite.commands} commands, ${rewrite.commands - extra} with the DEL; a public request's room is ${room}; ${months} months read`);

  part("A deletion, at its worst");
  await worst(statsId, "Good loaves, second words.");
  const removal = await measured({ action: "delete", confirm: "yes" });
  is("deleted", [removal.status, await readReview(statsId, productId, id)], ["deleted", null]);
  is(`the summary's reader marked once, billed ${VOICE_FORGET_COMMANDS} (${extra} over the DEL it replaced)`, removal.forget, VOICE_FORGET_COMMANDS);
  part(`Shown, not held here: the deletion's whole route is ${removal.commands} commands, ${removal.commands - extra} with the DEL; a public request's room is ${room}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
