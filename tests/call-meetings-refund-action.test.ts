/** The meetings refund job under the owner's decision 18, from the 2nd pre-review of claude5/call-refunds-confirmed at 779bcbfc0d (its proofs C2-1 to C2-4). */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { syncMeetings } from "@/lib/call-meetings";
import { callScope, readRecord, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { MEET_STORES } from "@/lib/meet-links";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_c2";
const OWNER = "weaver@example.com";
const ACCOUNT = "acct_1TestPrerevC2x1";
const NOW = Math.floor(Date.now() / 1000);
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let sessionsDown = false;
let refunds: Record<string, unknown>[] = [];
const chargeRefunds: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (sessionsDown) return answer({ error: { message: "down" } }, 500);
    return answer({ object: "list", data: sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? [], has_more: false });
  }
  if (path === "/refunds" && url.searchParams.get("charge")) return answer({ object: "list", data: chargeRefunds[url.searchParams.get("charge")!] ?? [], has_more: false });
  if (path === "/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    let rows = refunds.filter((r) => (r.created as number) >= gte).sort((a, b) => (b.created as number) - (a.created as number));
    if (after) rows = rows.slice(rows.findIndex((r) => r.id === after) + 1);
    return answer({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (id: string, refunded: boolean, back: number) => ({ object: "charge", id, amount: 4900, amount_refunded: back, refunded });
const refund = (id: string, pi: string, status: string, chargeRow: Record<string, unknown>, amount: number, created: number) => ({ id, object: "refund", created, status, amount, payment_intent: pi, charge: chargeRow });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "loomhouse", "Loom House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00009", subscriptionId: "sub_Owner00009", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Weaving call", "", "49", null);
  if (!guide.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const callsId = "f".repeat(16);
  const callStore: Store = { ...store, callsId };
  const callStart = Date.now() + 86_400_000;
  await redis.pipeline([["ZADD", MEET_STORES, callStart, `${callsId}|loomhouse`]]);
  const scopeOf = (pi: string) => callScope(callsId, { group: false, session: `cs_test_${pi.slice(3)}`, product: guide.product.id, start: callStart });
  const meeting = (pi: string): MeetRecord => ({
    provider: "google", scope: scopeOf(pi), statsId: store.statsId!, handle: "loomhouse", callsId, product: guide.product.id, session: `cs_test_${pi.slice(3)}`, group: false,
    id: "", account: "", link: "https://marktmorgen.com/call", made: false, start: callStart, end: callStart + 3_600_000, tz: "UTC", title: "Weaving call",
    guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "",
  });
  const run = () => syncMeetings(async (handle) => (handle === "loomhouse" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  const gone = async (pi: string) => (await readRecord(scopeOf(pi)))?.gone === true;
  const call = async (pi: string) => {
    sessionsByPayment[pi] = [{ id: `cs_test_${pi.slice(3)}`, metadata: { kind: "call", store: "loomhouse", product: guide.product.id, start: String(callStart) }, customer_details: { email: "buyer@example.com" } }];
    await writeRecord(meeting(pi));
  };

  part("C2-1: realistic: a call refund pending 70 days, one run a day, then succeeded: the meeting ends");
  const pi1 = "pi_TestPrerevC2Day1";
  await call(pi1);
  const at1 = NOW - 3 * 86_400;
  await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(at1 - 60), "EX", 60 * 86_400]]);
  refunds = [refund("re_TestPrerevC2Day1", pi1, "pending", charge("ch_TestPrerevC2Day1", true, 4900), 4900, at1)];
  for (let d = 0; d < 70; d += 1) {
    advance(86_400_000);
    await run();
  }
  is("still held after 70 days pending: never read as handled", Number((await redis.pipeline([["SISMEMBER", `nl:meet:rf:${callsId}:seen`, "re_TestPrerevC2Day1"]]))[0]), 0);
  // The meeting's record outlives a call months away in production; the stand-in's clock moved 70 days, so write it again.
  await writeRecord(meeting(pi1));
  refunds[0] = refund("re_TestPrerevC2Day1", pi1, "succeeded", charge("ch_TestPrerevC2Day1", true, 4900), 4900, at1);
  await run();
  is("C2-1: ends once it succeeded", await gone(pi1), true);

  part("C2-2: the first checkout lookup of a pending call refund fails: not marked, looked up again, ends once it succeeds");
  const pi2 = "pi_TestPrerevC2Fail";
  await call(pi2);
  const at2 = NOW - 3600;
  refunds = [refund("re_TestPrerevC2Fail", pi2, "pending", charge("ch_TestPrerevC2Fail", true, 4900), 4900, at2)];
  sessionsDown = true;
  await run();
  sessionsDown = false;
  const marked = Number((await redis.pipeline([["SISMEMBER", `nl:meet:rf:${callsId}:seen`, "call:re_TestPrerevC2Fail"]]))[0]);
  const read = Number((await redis.pipeline([["SISMEMBER", `nl:meet:rf:${callsId}:seen`, "re_TestPrerevC2Fail"]]))[0]);
  is("after the failed lookup: neither read nor marked", [read, marked], [0, 0]);
  await run();
  refunds[0] = refund("re_TestPrerevC2Fail", pi2, "succeeded", charge("ch_TestPrerevC2Fail", true, 4900), 4900, at2);
  await run();
  is("C2-2: ends once it succeeded", await gone(pi2), true);

  part("C2-3: a whole-charge refund waiting on an action that Stripe does NOT yet count in amount_refunded (charge.refunded false), then succeeded");
  const pi3 = "pi_TestPrerevC2Ract";
  await call(pi3);
  const at3 = NOW - 3300;
  refunds = [refund("re_TestPrerevC2Ract", pi3, "requires_action", charge("ch_TestPrerevC2Ract", false, 0), 4900, at3)];
  await run();
  // A newer refund of another sale comes in; the anchor moves past the first one.
  refunds.push(refund("re_TestPrerevC2Othr", "pi_TestPrerevC2Othr", "succeeded", charge("ch_TestPrerevC2Othr", false, 100), 100, at3 + 1000));
  await run();
  const anchor3 = Number((await redis.pipeline([["GET", `nl:meet:rf:${callsId}:since`]]))[0]);
  is("C2-3: the anchor stays at or below the refund waiting on an action", anchor3 <= at3, true);
  refunds[0] = refund("re_TestPrerevC2Ract", pi3, "succeeded", charge("ch_TestPrerevC2Ract", true, 4900), 4900, at3);
  for (let i = 0; i < 3; i += 1) await run();
  is("C2-3: the meeting ends once it succeeded", await gone(pi3), true);

  part("C2-4: two halves: the first half pending on a charge not yet full, the second half created later makes it full; the first then succeeds");
  const pi4 = "pi_TestPrerevC2Half";
  await call(pi4);
  const at4 = NOW - 1500;
  refunds = [refund("re_TestPrerevC2HlfA", pi4, "pending", charge("ch_TestPrerevC2Half", false, 2450), 2450, at4)];
  await run();
  const b = refund("re_TestPrerevC2HlfB", pi4, "succeeded", charge("ch_TestPrerevC2Half", true, 4900), 2450, at4 + 60);
  refunds = [refund("re_TestPrerevC2HlfA", pi4, "pending", charge("ch_TestPrerevC2Half", true, 4900), 2450, at4), b];
  // Rule 23 (junction with lib/refunds.ts settleParts): each row carries its time, as Stripe lists every refund.
  chargeRefunds.ch_TestPrerevC2Half = [
    { id: "re_TestPrerevC2HlfB", object: "refund", status: "succeeded", amount: 2450, created: at4 + 60, charge: "ch_TestPrerevC2Half" },
    { id: "re_TestPrerevC2HlfA", object: "refund", status: "pending", amount: 2450, created: at4, charge: "ch_TestPrerevC2Half" },
  ];
  await run();
  is("held while half is pending", await gone(pi4), false);
  chargeRefunds.ch_TestPrerevC2Half[1].status = "succeeded";
  refunds[0] = refund("re_TestPrerevC2HlfA", pi4, "succeeded", charge("ch_TestPrerevC2Half", true, 4900), 2450, at4);
  for (let i = 0; i < 3; i += 1) await run();
  is("C2-4: ends once both halves succeeded", await gone(pi4), true);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
