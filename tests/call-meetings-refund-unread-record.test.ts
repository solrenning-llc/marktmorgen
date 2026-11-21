/**
 * Codex X6's LOW on #2619 (6952486935): one meeting record that never reads must not stop the refund scan. The refund
 * whose record is unknown is marked as a call's and held for the next pass (never "no meeting", CX-123 rule 24), and
 * the store's other refunds in the same page are still read and their meetings still end. Synthetic store, the tests'
 * in-memory Redis, a stubbed Stripe.
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { syncMeetings } from "@/lib/call-meetings";
import { callScope, readRecord, recordKey, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { MEET_STORES } from "@/lib/meet-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_unread_record";
const OWNER = "potter@example.com";
const ACCOUNT = "acct_1TestUnread01";
const NOW = Math.floor(Date.now() / 1000);
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessionsByPayment[url.searchParams.get("payment_intent") ?? ""] ?? [], has_more: false });
  if (path === "/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const rows = refunds.filter((r) => (r.created as number) >= gte).sort((a, b) => (b.created as number) - (a.created as number));
    return answer({ object: "list", data: rows, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (id: string) => ({ object: "charge", id, amount: 4900, amount_refunded: 4900, refunded: true });
const refund = (id: string, pi: string, created: number) => ({ id, object: "refund", created, status: "succeeded", amount: 4900, payment_intent: pi, charge: charge(`ch_${id.slice(3)}`) });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnroom", "Kiln Room", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00071", subscriptionId: "sub_Owner00071", active: true, period: paidPeriod() });
  const lesson = await addProduct(OWNER, "Throwing lesson", "", "49", null);
  if (!lesson.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const callsId = "e".repeat(16);
  const callStore: Store = { ...store, callsId };
  const callStart = Date.now() + 86_400_000;
  await redis.pipeline([["ZADD", MEET_STORES, callStart, `${callsId}|kilnroom`]]);
  const scopeOf = (pi: string) => callScope(callsId, { group: false, session: `cs_test_${pi.slice(3)}`, product: lesson.product.id, start: callStart });
  const meeting = (pi: string): MeetRecord => ({
    provider: "google", scope: scopeOf(pi), statsId: store.statsId!, handle: "kilnroom", callsId, product: lesson.product.id, session: `cs_test_${pi.slice(3)}`, group: false,
    id: "", account: "", link: "https://marktmorgen.com/call", made: false, start: callStart, end: callStart + 3_600_000, tz: "UTC", title: "Throwing lesson",
    guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "",
  });
  const call = (pi: string) => {
    sessionsByPayment[pi] = [{ id: `cs_test_${pi.slice(3)}`, payment_intent: pi, metadata: { kind: "call", store: "kilnroom", product: lesson.product.id, start: String(callStart) }, customer_details: { email: "buyer@example.com" } }];
  };
  const run = () => syncMeetings(async (handle) => (handle === "kilnroom" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  const seen = async (member: string) => Number((await redis.pipeline([["SISMEMBER", `nl:meet:rf:${callsId}:seen`, member]]))[0]);

  part("A refund whose meeting record does not read is held; the next refund in the page still ends its meeting");
  const bad = "pi_TestUnreadRecBad";
  const good = "pi_TestUnreadRecGood";
  call(bad);
  call(good);
  // The newer refund comes first in Stripe's page: its record is in a shape readRecords refuses.
  await redis.pipeline([["SET", recordKey(scopeOf(bad)), "{not a record", "EX", 86_400]]);
  await writeRecord(meeting(good));
  await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(NOW - 7200), "EX", 60 * 86_400]]);
  refunds = [refund("re_TestUnreadRecBad", bad, NOW - 60), refund("re_TestUnreadRecGood", good, NOW - 120)];
  let threw = false;
  try { await run(); } catch { threw = true; }
  is("the run is not stopped by the unreadable record", threw, false);
  is("the other refund's meeting ended", (await readRecord(scopeOf(good)))?.gone, true);
  is("the unreadable one is held as a call's, never read as handled", [await seen("call:re_TestUnreadRecBad"), await seen("re_TestUnreadRecBad")], [1, 0]);

  part("Once its record reads again, the held refund ends its meeting");
  await writeRecord(meeting(bad));
  await run();
  is("ended on a later pass", (await readRecord(scopeOf(bad)))?.gone, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
