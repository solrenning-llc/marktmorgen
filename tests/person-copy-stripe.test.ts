/**
 * 619 [SZ3] unit 5: what is kept by a payment rather than by a person, found
 * through the person's paid checkouts on the creator's own Stripe account
 * (lib/person-copy-stripe.ts): a gift bought and one received, places bought
 * for a group, a call package, a shipment, and, while the store closes, a
 * membership's last payment. If Stripe cannot give the whole list, the copy
 * fails rather than leave a part out.
 */
import { importedKey } from "@/lib/imported-purchases";
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { packagesKey } from "@/lib/call-packages";
import { paidKey } from "@/lib/closing-holds";
import { erasureScope } from "@/lib/person-erasure";
import { COPY_COMPLETE, copyPerson } from "@/lib/person-copy";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_person_copy_only";
const OWNER = "stripeowner@example.com";
const PERSON = "mia@example.com";
const OTHER = "noah@example.com";
const GIFT_BOUGHT = "gft_" + "a".repeat(24);
const GIFT_GOT = "gft_" + "b".repeat(24);
const GROUP = "grp_" + "c".repeat(24);
const SESSION = "cs_test_" + "s".repeat(24);

let more = false;
let down = false;
const sessions: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (down) return answer({ error: { message: "down" } }, 500);
  if (url.pathname === "/v1/checkout/sessions") return answer({ object: "list", data: url.searchParams.get("customer_details[email]") === PERSON ? sessions : [], has_more: more });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "stripeshop", "Stripe Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Strp00001", subscriptionId: "sub_Strp00001", active: true, period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1TestCopy", true);
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  sessions.push({ id: SESSION, status: "complete", payment_status: "paid", payment_intent: "pi_1", metadata: { store: store.handle, product: "prod000001", gift: GIFT_BOUGHT, group: GROUP } });
  sessions.push({ id: "cs_test_" + "o".repeat(24), status: "complete", payment_status: "paid", metadata: { store: "another-store", gift: "gft_" + "f".repeat(24) } });
  redis.run(["SET", `nl:gift:${GIFT_BOUGHT}`, JSON.stringify({ id: GIFT_BOUGHT, s: statsId, p: "prod000001", to: "friend@example.com", from: "Mia", message: "Enjoy", at: 1_790_000_000 })]);
  redis.run(["SET", `nl:gift:${GIFT_GOT}`, JSON.stringify({ id: GIFT_GOT, s: statsId, p: "prod000002", to: PERSON, from: "Sam", message: "For you", at: 1_790_000_000 })]);
  redis.run(["HSET", importedKey(statsId, PERSON), "prod000002", JSON.stringify({ at: 1_790_000_000, job: `gift:${GIFT_GOT}`, items: null })]);
  redis.run(["SET", `nl:grp:${GROUP}`, JSON.stringify({ id: GROUP, s: statsId, p: "prod000001", people: 5, at: 1_790_000_000 })]);
  redis.run(["SET", `nl:ship:done:${SESSION}`, JSON.stringify({ at: 1_790_000_000, tracking: "https://track.example.com/1" })]);
  redis.run(["SADD", packagesKey(statsId), "cs_test_" + "p".repeat(24), "cs_test_" + "q".repeat(24)]);
  redis.run(["SET", "nl:pkg:cs_test_" + "p".repeat(24), JSON.stringify({ s: statsId, h: store.handle, p: "call000001", e: PERSON, total: 4, at: 1_790_000_000, until: 0, token: "secret-token-1", holds: [] })]);
  redis.run(["SET", "nl:pkg:cs_test_" + "q".repeat(24), JSON.stringify({ s: statsId, h: store.handle, p: "call000001", e: OTHER, total: 4, at: 1_790_000_000, until: 0, token: "secret-token-2", holds: [] })]);
  redis.run(["HSET", paidKey(await storeFolder(storeRef(store))), "sub_1", JSON.stringify({ inv: "in_1", amt: 900, cur: "usd", ps: 1, pe: 2, e: PERSON }), "sub_2", JSON.stringify({ inv: "in_2", amt: 900, cur: "usd", ps: 1, pe: 2, e: OTHER })]);
  const scope = (await erasureScope(store, PERSON))!;

  part("Found through their payments");
  is("every module is now copied, held as marks or said to be elsewhere", COPY_COMPLETE, true);
  const copy = await copyPerson(scope);
  const records = (m: string) => copy.sections.find((s) => s.module === m)?.records ?? [];
  is("the gift they bought and the one they received", records("lib/gifts.ts").map((g) => [(g as { youBought?: boolean }).youBought ?? false, (g as { message: string }).message]), [[true, "Enjoy"], [false, "For you"]]);
  is("the places they bought for a group, as a number", records("lib/group-buy.ts"), [{ youBought: true, product: "prod000001", places: 5, at: "2026-09-21T14:13:20.000Z" }]);
  is("their call package, not the other buyer's", records("lib/call-packages.ts").length, 1);
  is("their shipment", records("lib/shipments.ts").map((r) => (r as { tracking: string }).tracking), ["https://track.example.com/1"]);
  is("their membership's last payment kept while the store closes", records("lib/closing-holds.ts").map((r) => (r as { subscription: string }).subscription), ["sub_1"]);
  const text = JSON.stringify(copy);
  is("no booking link's key, nor another store's gift, nor the other buyer", ["secret-token", "gft_" + "f".repeat(24), OTHER].map((w) => text.includes(w)), [false, false, false]);

  part("Never a copy with a part left out");
  more = true;
  let failed = false;
  try {
    await copyPerson((await erasureScope(store, PERSON))!);
  } catch {
    failed = true;
  }
  is("more payments than one read gives: the copy fails", failed, true);
  more = false;
  down = true;
  failed = false;
  try {
    await copyPerson((await erasureScope(store, PERSON))!);
  } catch {
    failed = true;
  }
  is("Stripe not answering: the copy fails", failed, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
