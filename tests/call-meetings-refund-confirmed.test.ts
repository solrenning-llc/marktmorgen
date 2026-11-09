/**
 * The meetings' refund job ends a paid call's meeting only once its money went back for good (the owner's decision
 * 18, 9 November 2026, C1-20261109-1029-C5-52): a full refund that succeeded, or a dispute lost. Checked against a
 * stand-in for the creator's Stripe account:
 *
 *   - a full refund still pending, or waiting on an action, keeps the meeting, is not taken as read, and keeps the
 *     job's anchor at its time, so the next run reads it again; once it succeeded, the meeting ends;
 *   - a refund that failed or was canceled keeps the meeting;
 *   - a full refund made of parts ends the meeting only once the parts that succeeded add up to the charge: while
 *     another part is on its way, or when the charge's refunds cannot be read, the meeting stays;
 *   - a refund on its way for more than seven days is said in the log, and still keeps the meeting.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { syncMeetings } from "@/lib/call-meetings";
import { callScope, readRecord, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { MEET_STORES } from "@/lib/meet-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_call_refund_confirmed_only";

const OWNER = "weaver@example.com";
const ACCOUNT = "acct_1TestCallRefnd01";
const NOW = Math.floor(Date.now() / 1000);

const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
/** The window's refunds, as GET /refunds lists them (newest first). */
let refunds: Record<string, unknown>[] = [];
/** Every refund of a charge, as GET /refunds?charge= lists them; a charge set to "down" answers 500. */
const chargeRefunds: Record<string, Record<string, unknown>[] | "down"> = {};
let chargeReads = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", url: "/v1/list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return list(sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? []);
  if (path === "/refunds") {
    const charge = url.searchParams.get("charge");
    if (charge) {
      chargeReads += 1;
      const rows = chargeRefunds[charge];
      if (rows === "down") return answer({ error: { message: "try again" } }, 500);
      return list(rows ?? []);
    }
    return list(refunds);
  }
  return list([]);
}) as typeof fetch;

const charge = (id: string, refunded: boolean, back = refunded ? 4900 : 0) => ({ object: "charge", id, amount: 4900, amount_refunded: back, refunded });
const refund = (id: string, pi: string, status: string, chargeRow: Record<string, unknown>, amount = 4900, created = NOW - 30) => ({
  id, object: "refund", created, status, amount, payment_intent: pi, charge: chargeRow,
});

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "loomhouse", "Loom House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
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
  const booked = async (pi: string) => {
    sessionsByPayment[pi] = [{ id: `cs_test_${pi.slice(3)}`, metadata: { kind: "call", store: "loomhouse", product: guide.product.id, start: String(callStart) }, customer_details: { email: "buyer@example.com" } }];
    await writeRecord(meeting(pi));
  };
  const gone = async (pi: string) => (await readRecord(scopeOf(pi)))?.gone === true;
  const run = () => syncMeetings(async (handle) => (handle === "loomhouse" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  const seen = async (id: string) => Number((await redis.pipeline([["SISMEMBER", `nl:meet:rf:${callsId}:seen`, id]]))[0]) === 1;
  const anchor = async () => Number((await redis.pipeline([["GET", `nl:meet:rf:${callsId}:since`]]))[0]);

  part("A full refund still pending keeps the meeting");
  await booked("pi_TestCallPend01");
  // A newer partial refund of another payment, so a job that passed the pending one by would move its anchor past it.
  const newer = refund("re_TestCallNewer1", "pi_TestCallOther1", "succeeded", charge("ch_TestCallOther1", false, 900), 900, NOW - 5);
  refunds = [newer, refund("re_TestCallPend01", "pi_TestCallPend01", "pending", charge("ch_TestCallPend01", true), 4900, NOW - 600)];
  await run();
  is("the meeting stays while the refund is pending", await gone("pi_TestCallPend01"), false);
  is("the pending refund is not taken as read", await seen("re_TestCallPend01"), false);
  is("the anchor stays at or below the pending refund's time, so it is read again", (await anchor()) <= NOW - 600, true);

  part("Once it succeeded, the meeting ends");
  refunds = [newer, refund("re_TestCallPend01", "pi_TestCallPend01", "succeeded", charge("ch_TestCallPend01", true), 4900, NOW - 600)];
  await run();
  is("the meeting ends", await gone("pi_TestCallPend01"), true);
  is("and the refund is read", await seen("re_TestCallPend01"), true);
  is("no charge's refunds read for a refund of the whole charge on its own", chargeReads, 0);

  part("Waiting on an action, failed or canceled keeps the meeting");
  await booked("pi_TestCallActn01");
  await booked("pi_TestCallFail01");
  await booked("pi_TestCallCanc01");
  refunds = [
    refund("re_TestCallActn01", "pi_TestCallActn01", "requires_action", charge("ch_TestCallActn01", true)),
    refund("re_TestCallFail01", "pi_TestCallFail01", "failed", charge("ch_TestCallFail01", false)),
    refund("re_TestCallCanc01", "pi_TestCallCanc01", "canceled", charge("ch_TestCallCanc01", false)),
  ];
  await run();
  is("each meeting stays", [await gone("pi_TestCallActn01"), await gone("pi_TestCallFail01"), await gone("pi_TestCallCanc01")], [false, false, false]);
  is("the one waiting on an action is not taken as read", await seen("re_TestCallActn01"), false);

  part("A full refund in parts");
  await booked("pi_TestCallPart01");
  const partCharge = charge("ch_TestCallPart01", true);
  const first = refund("re_TestCallPartA1", "pi_TestCallPart01", "succeeded", partCharge, 2450, NOW - 120);
  const second = (status: string) => refund("re_TestCallPartB1", "pi_TestCallPart01", status, partCharge, 2450, NOW - 60);
  const listed = (status: string) => [second(status), first].map((row) => ({ ...row, charge: "ch_TestCallPart01" }));
  refunds = [second("pending"), first];
  chargeRefunds.ch_TestCallPart01 = listed("pending");
  chargeReads = 0;
  await run();
  is("a succeeded part while the rest is pending keeps the meeting", await gone("pi_TestCallPart01"), false);
  is("the succeeded part is not taken as read", await seen("re_TestCallPartA1"), false);
  is("the charge's refunds were read", chargeReads > 0, true);

  chargeRefunds.ch_TestCallPart01 = "down";
  refunds = [second("succeeded"), first];
  await run();
  is("the charge's refunds not read keep the meeting", await gone("pi_TestCallPart01"), false);
  is("and neither part is taken as read", [await seen("re_TestCallPartA1"), await seen("re_TestCallPartB1")], [false, false]);

  chargeRefunds.ch_TestCallPart01 = listed("succeeded");
  await run();
  is("once both parts succeeded, the meeting ends", await gone("pi_TestCallPart01"), true);

  part("A refund pending for days is said, never taken");
  await booked("pi_TestCallSlow01");
  refunds = [refund("re_TestCallSlow01", "pi_TestCallSlow01", "pending", charge("ch_TestCallSlow01", true), 4900, NOW - 8 * 86_400)];
  await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(NOW - 9 * 86_400)]]);
  const said: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void said.push(args);
  try {
    await run();
  } finally {
    console.error = error;
  }
  is("the meeting stays", await gone("pi_TestCallSlow01"), false);
  is("the log says the refund has been pending for more than seven days", said.some((args) => String(args[0]).includes("pending for more than seven days")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
