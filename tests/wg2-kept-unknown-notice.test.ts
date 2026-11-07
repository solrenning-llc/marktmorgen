/**
 * 642 [WG2], Claude 4's MÉDIO on #2685 (6708162537, F1; rule 24 / VR item 2):
 * an invitation whose "kept" cannot be read is refused, as before, but it is
 * never told to the member as "You already moved this membership here". That
 * would show an unknown state as done, and a member might let the old
 * platform's membership lapse with none here. It has its own reason
 * ("unknown") and its own notice, in every language; "done" stays for a kept
 * time only. Stripe and the email sender are played by a stand-in for `fetch`.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMembers, noteKept, openMove, readInvite } from "@/lib/move-members";
import { moveWords } from "@/lib/buyer-words/move";
import MovePage from "@/app/[handle]/move/[product]/page";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "kept-unknown@example.com";
const DAY = 86_400;
const nowS = Math.floor(Date.now() / 1000);
let checkouts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && (init?.method ?? "GET") === "POST") {
    checkouts += 1;
    return new Response(JSON.stringify({ id: `cs_test_${"k".repeat(20)}${checkouts}`, url: `https://checkout.stripe.com/c/pay/test${checkouts}` }));
  }
  if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

const escaped = (text: string) => text.replace(/'/g, "&#x27;");
const movePage = async (handle: string, product: string, query: Record<string, string>) =>
  renderToStaticMarkup(await MovePage({ params: Promise.resolve({ handle: `@${handle}`, product }), searchParams: Promise.resolve(query) }));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_kept_unknown_only";
  redis.clear();
  const made = await claimHandle(OWNER, "keptunknown", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestKeptUnk1", true);
  await setSubscription(OWNER, { customerId: "cus_KeptUnk01", subscriptionId: "sub_KeptUnk01", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  const id = club.product.id;
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const [adaField, benField] = await inviteMembers(store, "job_keptunknown", [
    { email: "ada@example.com", productId: id, option: "", renews: nowS + 20 * DAY },
    { email: "ben@example.com", productId: id, option: "", renews: nowS + 20 * DAY },
  ]);
  if (!adaField || !benField) throw new Error("not invited");
  const ada = (await readInvite(statsId, adaField))!;
  const ben = (await readInvite(statsId, benField))!;
  const en = moveWords("en").notices;

  part("\"kept\" unreadable: refused, and said as unknown, never as moved");
  const record = JSON.parse(redis.run(["HGET", `nl:mv:${statsId}`, benField]) as string) as Record<string, unknown>;
  for (const odd of ["x", {}, null, -1, 1.5]) {
    redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify({ ...record, kept: odd })]);
    const before = checkouts;
    const tried = await openMove(store, id, ben.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
    is(`kept ${JSON.stringify(odd)}: nothing opened, and the reason is "unknown", not "done"`, [tried.ok ? "opened" : tried.reason, checkouts - before], ["unknown", 0]);
  }
  redis.run(["HSET", `nl:mv:${statsId}`, benField, JSON.stringify({ ...record, kept: "x" })]);
  const unknownPage = await movePage("keptunknown", id, { k: ben.t });
  is("its page says the state could not be confirmed, never that it moved, with no button to press", [unknownPage.includes(escaped(en.unknown.title)), unknownPage.includes(escaped(en.done.title)), unknownPage.includes(moveWords("en").keep)], [true, false, false]);
  const sent = await movePage("keptunknown", id, { k: ben.t, notice: "unknown" });
  is("the open route's answer, sent back to the page, shows the same notice", sent.includes(escaped(en.unknown.title)), true);

  part("Every language has its own words for it, apart from \"moved\"");
  for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
    const n = moveWords(language).notices;
    is(`${language}: a title and a body, not the "done" ones`, [n.unknown.title.length > 0 && n.unknown.body.length > 0, n.unknown.title === n.done.title], [true, false]);
  }
  is("it says nothing was charged and who to ask", /Nothing was charged/.test(en.unknown.body) && /store's owner/.test(en.unknown.body), true);

  part("Controls: what is known decides as before");
  await noteKept(store, "ada@example.com", id);
  const kept = await openMove(store, id, ada.t, "https://marktmorgen.com", Date.now(), TEST_CONSENT);
  is("a kept time: \"done\"", kept.ok ? "opened" : kept.reason, "done");
  const keptPage = await movePage("keptunknown", id, { k: ada.t });
  is("and its page says it moved", [keptPage.includes(escaped(en.done.title)), keptPage.includes(escaped(en.unknown.title))], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
