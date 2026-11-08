/**
 * Rule 24 on the refunds and disputes the affiliate book is settled against (lib/affiliates.ts, refundsSince and
 * disputesSince; Claude 2's review of #3248). The book says `refundsChecked` only when every page of the creator's
 * refunds and disputes was read whole: that flag is what holds back the payout batch file and "Mark as paid". A page
 * that is not Stripe's list (no `data` list, no `has_more` true or false), a row that cannot be read (no id, an amount
 * that is not a whole number, a status or payment intent of another kind), or a list that says there is more but
 * whose last row cannot be read, is not "these are all the refunds": the book says it is not checked, so nobody is
 * paid commission on a sale whose refund could not be read. A healthy read, an empty one and two pages read in turn
 * are unchanged.
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_refund_pages_only";
process.env.RESEND_API_KEY = "re_test_affiliate_refund_pages_only";

const OWNER = "pages@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";

type Reply = (after: string | null) => unknown;
const LIST = (data: unknown[], hasMore = false) => ({ object: "list", data, has_more: hasMore });
let refundsReply: Reply = () => LIST([]);
let disputesReply: Reply = () => LIST([]);
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const after = url.searchParams.get("starting_after");
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/refunds") return answer(refundsReply(after));
  if (url.pathname === "/v1/disputes") return answer(disputesReply(after));
  return answer(LIST([]));
}) as typeof fetch;

const refund = (id: string, over: Record<string, unknown> = {}) => ({ id, object: "refund", status: "succeeded", payment_intent: "pi_cs_full", amount: 10_000, ...over });
const dispute = (id: string, over: Record<string, unknown> = {}) => ({ id, object: "dispute", status: "lost", payment_intent: "pi_cs_full", amount: 10_000, created: NOW, ...over });
const sale = (ref: string, base: number) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff: ANA, at: NOW - 3600, product: "prod01", title: "Bread course", base, total: base, currency: "usd", rate: 30, self: false, how: "click" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "pages", "Pages Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRefundPage", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_full", sale("cs_full", 10_000)],
  ]);
  const read = async () => {
    const book = await readBook(store);
    return [book.refundsChecked, book.lines.find((l) => l.ref === "cs_full")?.commission];
  };

  part("Controls: a whole read settles the book as before");
  refundsReply = () => LIST([refund("re_full0001")]);
  is("refunded in full on a whole page: checked, nothing earned", await read(), [true, 0]);
  refundsReply = () => LIST([]);
  is("no refund on a whole empty page: checked, the share earned", await read(), [true, 3_000]);
  refundsReply = (after) => (after === null ? LIST([refund("re_other001", { payment_intent: "pi_cs_other" })], true) : after === "re_other001" ? LIST([refund("re_full0001")]) : LIST([]));
  is("the refund on the second page is read: checked, nothing earned", await read(), [true, 0]);
  refundsReply = () => LIST([refund("re_full0001", { payment_intent: null, amount: 500 })]);
  is("a refund with no payment intent (a charge-only refund) reads and names no sale", await read(), [true, 3_000]);
  refundsReply = () => LIST([]);
  disputesReply = () => LIST([dispute("dp_full0001", { payment_intent: { id: "pi_cs_full" } })]);
  is("a dispute lost, its payment intent expanded: checked, nothing earned", await read(), [true, 0]);
  disputesReply = () => LIST([]);

  part("Refunds in another shape are not \"no refunds\"");
  const refundShapes: [string, Reply][] = [
    ["no data list", () => ({ object: "list", has_more: false })],
    ["data an object", () => ({ object: "list", data: { 0: refund("re_full0001") }, has_more: false })],
    ["no has_more", () => ({ object: "list", data: [refund("re_full0001")] })],
    ["has_more as text", () => ({ object: "list", data: [refund("re_full0001")], has_more: "false" })],
    ["not an object", () => [refund("re_full0001")]],
    ["the amount as text", () => LIST([refund("re_full0001", { amount: "10000" })])],
    ["a fractional amount", () => LIST([refund("re_full0001", { amount: 99.5 })])],
    ["a negative amount", () => LIST([refund("re_full0001", { amount: -1 })])],
    ["no status", () => LIST([refund("re_full0001", { status: undefined })])],
    ["a payment intent of another kind", () => LIST([refund("re_full0001", { payment_intent: 42 })])],
    ["a row with no id", () => LIST([refund("re_full0001", { id: undefined })])],
    ["a null row beside the refund", () => LIST([refund("re_full0001"), null])],
    ["more to come but the last row unreadable", () => LIST([refund("re_full0001"), { status: "succeeded" }], true)],
    ["more to come on an empty page", () => LIST([], true)],
  ];
  for (const [name, reply] of refundShapes) {
    refundsReply = reply;
    is(`${name}: the book is not checked`, (await read())[0], false);
  }
  refundsReply = () => LIST([]);

  part("Disputes in another shape are not \"no disputes\"");
  const disputeShapes: [string, Reply][] = [
    ["no data list", () => ({ object: "list", has_more: false })],
    ["no has_more", () => ({ object: "list", data: [dispute("dp_full0001")] })],
    ["the amount as text", () => LIST([dispute("dp_full0001", { amount: "10000" })])],
    ["no status", () => LIST([dispute("dp_full0001", { status: 7 })])],
    ["a payment intent of another kind", () => LIST([dispute("dp_full0001", { payment_intent: 42 })])],
    ["an expanded payment intent with no id", () => LIST([dispute("dp_full0001", { payment_intent: { amount: 1 } })])],
    ["a row with no id", () => LIST([dispute("dp_full0001", { id: undefined })])],
    ["more to come but the last row unreadable", () => LIST([dispute("dp_full0001"), {}], true)],
  ];
  for (const [name, reply] of disputeShapes) {
    disputesReply = reply;
    is(`${name}: the book is not checked`, (await read())[0], false);
  }
  disputesReply = () => LIST([]);
  is("control again: a whole empty read is checked", (await read())[0], true);

  done();
}

void main();
