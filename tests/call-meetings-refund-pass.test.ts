/**
 * The meetings' refund job under the owner's decision 18 (9 November 2026), past one run's pages (pre-review of
 * claude5/call-refunds-confirmed at 8c78d27d2f, Claude 5's audit of the Stripe reads, A3). Synthetic only: the
 * in-memory Redis double and a stand-in for the creator's Stripe account that lists refunds newest first, honoring
 * `created[gte]`, `starting_after` and `limit`.
 *
 *   - a call's full refund pending, then succeeded behind 250 newer refunds, ends its meeting within five runs, and the
 *     anchor moves past it (before: the job read only the two newest pages, the anchor never moved and lapsed);
 *   - a refund on its way that is not a call's never holds the anchor, and is never said in the log;
 *   - a call's refund on its way for more than seven days is said at most once a day;
 *   - a call's refund held for later is looked up once, not on every run;
 *   - a row that does not read (a pending refund with no time) never writes the anchor as "0".
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { MEET_REFUND_PLACE_COMMANDS, MEET_REFUND_ROW_COMMANDS, syncMeetings } from "@/lib/call-meetings";
import { callScope, readRecord, writeRecord, type MeetRecord } from "@/lib/meet-records";
import { MEET_STORES } from "@/lib/meet-links";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_call_refund_pass";
const OWNER = "weaver@example.com";
const ACCOUNT = "acct_1TestCallRfPass1";
const NOW = Math.floor(Date.now() / 1000);
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
/** How many times each payment's checkout was looked up. */
const lookedUp: Record<string, number> = {};
/** Every refund on the account, any order; listed newest first, honoring created[gte], starting_after and limit. */
let refunds: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent") ?? "";
    lookedUp[pi] = (lookedUp[pi] ?? 0) + 1;
    return answer({ object: "list", data: sessionsByPayment[pi] ?? [], has_more: false });
  }
  if (path === "/refunds" && !url.searchParams.get("charge")) {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    let rows = refunds.filter((r) => typeof r.created !== "number" || r.created >= gte).sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0));
    if (after) {
      const at = rows.findIndex((r) => r.id === after);
      if (at < 0) return answer({ error: { type: "invalid_request_error", message: "No such refund" } }, 400);
      rows = rows.slice(at + 1);
    }
    return answer({ object: "list", data: rows.slice(0, limit), has_more: rows.length > limit });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** Every command sent, for the job's cost. */
let sent: Command[] = [];
redis.pipeline = (async (commands: Command[]) => {
  sent.push(...commands);
  return memory(commands);
}) as typeof redis.pipeline;

const charge = (id: string, refunded: boolean, back: number) => ({ object: "charge", id, amount: 4900, amount_refunded: back, refunded });
const refund = (id: string, pi: string, status: string, chargeRow: Record<string, unknown>, amount: number, created: number) => ({ id, object: "refund", created, status, amount, payment_intent: pi, charge: chargeRow });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "loomhouse", "Loom House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00010", subscriptionId: "sub_Owner00010", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Weaving call", "", "49", null);
  if (!guide.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const callsId = "e".repeat(16);
  const callStore: Store = { ...store, callsId };
  const callStart = Date.now() + 86_400_000 * 90;
  await redis.pipeline([["ZADD", MEET_STORES, callStart, `${callsId}|loomhouse`]]);
  const scopeOf = (pi: string) => callScope(callsId, { group: false, session: `cs_test_${pi.slice(3)}`, product: guide.product.id, start: callStart });
  const meeting = (pi: string): MeetRecord => ({
    provider: "google", scope: scopeOf(pi), statsId: store.statsId!, handle: "loomhouse", callsId, product: guide.product.id, session: `cs_test_${pi.slice(3)}`, group: false,
    id: "", account: "", link: "https://marktmorgen.com/call", made: false, start: callStart, end: callStart + 3_600_000, tz: "UTC", title: "Weaving call",
    guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "",
  });
  const booked = async (pi: string) => {
    sessionsByPayment[pi] = [{ id: `cs_test_${pi.slice(3)}`, payment_intent: pi, metadata: { kind: "call", store: "loomhouse", product: guide.product.id, start: String(callStart) }, customer_details: { email: "buyer@example.com" } }];
    await writeRecord(meeting(pi));
  };
  const run = () => syncMeetings(async (handle) => (handle === "loomhouse" ? callStore : null), Date.now() + 10_000, "https://marktmorgen.com");
  const gone = async (pi: string) => (await readRecord(scopeOf(pi)))?.gone === true;
  const anchorRaw = async () => (await redis.pipeline([["GET", `nl:meet:rf:${callsId}:since`]]))[0];
  const anchor = async () => Number(await anchorRaw());
  /** The log lines saying a refund has been pending for more than seven days, over `runs` runs. */
  const alertsOver = async (runs: number) => {
    const said: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void said.push(args);
    try {
      for (let i = 0; i < runs; i += 1) await run();
    } finally {
      console.error = error;
    }
    return said.filter((args) => String(args[0]).includes("pending for more than seven days")).length;
  };

  part("A call's refund pending, then succeeded behind 250 newer refunds");
  {
    const pi = "pi_TestRfPassSlow1";
    await booked(pi);
    const slowAt = NOW - 5 * 86_400;
    await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(slowAt - 60), "EX", 60 * 86_400]]);
    refunds = [refund("re_TestRfPassSlow1", pi, "pending", charge("ch_TestRfPassSlow1", true, 4900), 4900, slowAt)];
    await run();
    is("held while pending: the meeting stays and the anchor stays at it", [await gone(pi), (await anchor()) <= slowAt], [false, true]);
    for (let i = 0; i < 250; i += 1) {
      const n = String(i).padStart(4, "0");
      refunds.push(refund(`re_TestRfPassPart${n}`, `pi_TestRfPassO${n}`, "succeeded", charge(`ch_TestRfPassO${n}`, false, 100), 100, slowAt + 3600 + i * 600));
    }
    refunds[0] = refund("re_TestRfPassSlow1", pi, "succeeded", charge("ch_TestRfPassSlow1", true, 4900), 4900, slowAt);
    for (let i = 0; i < 5; i += 1) await run();
    is("the refund succeeded in full: the meeting ends within five runs", await gone(pi), true);
    is("the anchor moves past it", (await anchor()) > slowAt, true);
  }

  part("A refund on its way that is not a call's");
  {
    // With a newer partial refund of another sale, which the anchor moves to once nothing holds it.
    refunds = [
      refund("re_TestRfPassNewer", "pi_TestRfPassNewer", "succeeded", charge("ch_TestRfPassNewer", false, 100), 100, NOW - 60),
      refund("re_TestRfPassEbook", "pi_TestRfPassEbook", "pending", charge("ch_TestRfPassEbook", true, 4900), 4900, NOW - 8 * 86_400),
    ];
    await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(NOW - 9 * 86_400), "EX", 60 * 86_400], ["DEL", `nl:meet:rf:${callsId}:pass`]]);
    is("is never said in the log, however many runs", await alertsOver(3), 0);
    is("and never holds the anchor", (await anchor()) >= NOW - 60, true);
  }

  part("A call's refund pending for more than seven days");
  {
    const pi = "pi_TestRfPassWait1";
    await booked(pi);
    const at = NOW - 8 * 86_400;
    refunds = [refund("re_TestRfPassWait1", pi, "pending", charge("ch_TestRfPassWait1", true, 4900), 4900, at)];
    await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(at - 60), "EX", 60 * 86_400], ["DEL", `nl:meet:rf:${callsId}:pass`]]);
    lookedUp[pi] = 0;
    sent = [];
    is("is said once in three runs", await alertsOver(3), 1);
    // Its place and its one row, each run: the commands on the job's own keys stay inside what the registry prices.
    const own = sent.filter((command) => String(command[1] ?? "").startsWith(`nl:meet:rf:${callsId}:`)).length;
    is("each run sends at most MEET_REFUND_PLACE_COMMANDS + MEET_REFUND_ROW_COMMANDS on its own keys for one row", own <= 3 * (MEET_REFUND_PLACE_COMMANDS + MEET_REFUND_ROW_COMMANDS), true);
    is("its meeting stays", await gone(pi), false);
    is("and it is looked up once, not on every run", lookedUp[pi], 1);
    advance(86_400_000 + 60_000);
    is("a day later it is said again, once", await alertsOver(2), 1);
    is("the anchor is kept (written again) while it holds it", (await anchor()) > 0 && (await anchor()) <= at, true);
  }

  part("A row that does not read");
  {
    const before = NOW - 3 * 86_400;
    await redis.pipeline([["SET", `nl:meet:rf:${callsId}:since`, String(before), "EX", 60 * 86_400], ["DEL", `nl:meet:rf:${callsId}:pass`]]);
    refunds = [{ id: "re_TestRfPassNoTime", object: "refund", status: "pending", amount: 4900, payment_intent: "pi_TestRfPassNoTm", charge: charge("ch_TestRfPassNoTm", true, 4900) }];
    await run();
    is("a pending refund with no time never writes the anchor as 0", [await anchorRaw() !== "0", (await anchor()) >= before - 300], [true, true]);
  }
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
