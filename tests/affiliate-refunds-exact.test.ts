/**
 * A refund or a dispute counts against an affiliate's sale only when Stripe's
 * row reads exactly (lib/affiliates.ts, refundsSince and disputesSince; rule
 * 24, money).
 *
 * The defect this file was written around: both readers added each row's
 * `amount` into the sale's refunded cents without looking at its currency, and
 * an amount that was not a number became 0. A refund Stripe made but whose
 * amount could not be read was then counted as nothing, the book still said it
 * had checked every refund (refundsChecked true), and the payout batch paid
 * the full commission on a sale the creator had given back. A refund in
 * another currency was added as if its cents were the sale's, and a row a page
 * repeated was counted twice. Checked:
 *
 *   - a refund or a dispute with an amount that is not a whole number of
 *     cents, with no currency, with a currency other than the sale's, or with
 *     no id leaves the book "not checked", so no payout is made on it;
 *   - the same refund or dispute read twice counts once;
 *   - healthy controls: an exact refund or dispute takes the commission as
 *     before, and a refund in another currency for a payment not on the book
 *     does not hold the book.
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_refunds_exact_only";
process.env.RESEND_API_KEY = "re_test_affiliate_refunds_exact_only";

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";

let refunds: Record<string, unknown>[] = [];
let disputes: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.pathname === "/v1/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (url.pathname === "/v1/disputes") return answer({ object: "list", data: disputes, has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = (ref: string, base: number) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff: ANA, at: NOW - 3600, product: "prod01", title: "Bread course", base, total: base, currency: "usd", rate: 30, self: false, how: "click" });
const refund = (id: string, pi: string, over: Record<string, unknown> = {}) => ({ id, object: "refund", status: "succeeded", payment_intent: pi, amount: 10_000, currency: "usd", ...over });
const dispute = (id: string, pi: string, over: Record<string, unknown> = {}) => ({ id, object: "dispute", status: "lost", payment_intent: pi, amount: 10_000, currency: "usd", created: NOW, ...over });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "crumb", "Crumb Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRefundEx1", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_one", sale("cs_one", 10_000)],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_two", sale("cs_two", 10_000)],
  ]);
  const state = async () => {
    const book = await readBook(store);
    const one = book.lines.find((l) => l.ref === "cs_one");
    return { checked: book.refundsChecked, one: [one?.status, one?.commission] };
  };

  part("Healthy controls");
  refunds = [];
  disputes = [];
  is("nothing refunded: earned, and the book says it checked", await state(), { checked: true, one: ["earned", 3_000] });
  refunds = [refund("re_ok", "pi_cs_one")];
  is("an exact refund in full: nothing earned, checked", await state(), { checked: true, one: ["refunded", 0] });
  refunds = [refund("re_part", "pi_cs_one", { amount: 4_000, currency: "USD" })];
  is("an exact partial refund, its currency in capitals: 30% of what was kept, checked", await state(), { checked: true, one: ["partly refunded", 1_800] });
  refunds = [refund("re_other", "pi_not_on_the_book", { currency: "eur" })];
  is("a refund in euros for a payment not on the book: holds nothing", await state(), { checked: true, one: ["earned", 3_000] });
  refunds = [refund("re_failed", "pi_cs_one", { status: "failed", amount: "garbled" })];
  is("a failed refund, whatever its amount says: not counted, still checked", await state(), { checked: true, one: ["earned", 3_000] });
  refunds = [];
  disputes = [dispute("dp_ok", "pi_cs_one")];
  is("an exact lost dispute: nothing earned, checked", await state(), { checked: true, one: ["refunded", 0] });
  disputes = [dispute("dp_won", "pi_cs_one", { status: "won", amount: "garbled" })];
  is("a dispute the creator won, whatever its amount says: earned, checked", await state(), { checked: true, one: ["earned", 3_000] });
  disputes = [];

  part("A refund that cannot be read exactly holds the book");
  for (const [what, over] of [
    ["an amount that is text", { amount: "10000" }],
    ["an amount that is not whole cents", { amount: 99.5 }],
    ["an amount that is missing", { amount: undefined }],
    ["a negative amount", { amount: -10_000 }],
    ["an amount past what can be counted exactly", { amount: 2 ** 60 }],
    ["no currency", { currency: undefined }],
    ["a currency that is not text", { currency: 840 }],
    ["euros on a sale in dollars", { currency: "eur" }],
    ["no id", { id: undefined }],
  ] as [string, Record<string, unknown>][]) {
    refunds = [refund("re_bad", "pi_cs_one", over)];
    is(`refund with ${what}: the book is not checked, so no payout is made on it`, (await state()).checked, false);
  }
  refunds = [];

  part("A dispute that cannot be read exactly holds the book");
  for (const [what, over] of [
    ["an amount that is text", { amount: "10000" }],
    ["an amount that is not whole cents", { amount: 99.5 }],
    ["an amount that is missing", { amount: undefined }],
    ["a negative amount", { amount: -10_000 }],
    ["no currency", { currency: undefined }],
    ["euros on a sale in dollars", { currency: "eur" }],
    ["no id", { id: undefined }],
  ] as [string, Record<string, unknown>][]) {
    disputes = [dispute("dp_bad", "pi_cs_one", over)];
    is(`lost dispute with ${what}: the book is not checked, so no payout is made on it`, (await state()).checked, false);
  }
  disputes = [];

  part("The same row read twice counts once");
  refunds = [refund("re_twice", "pi_cs_one", { amount: 4_000 }), refund("re_twice", "pi_cs_one", { amount: 4_000 })];
  is("one partial refund listed twice: 30% of the 6,000 kept, not of 2,000", await state(), { checked: true, one: ["partly refunded", 1_800] });
  refunds = [refund("re_a", "pi_cs_one", { amount: 4_000 }), refund("re_b", "pi_cs_one", { amount: 4_000 })];
  is("two different partial refunds: both count", await state(), { checked: true, one: ["partly refunded", 600] });
  refunds = [];
  disputes = [dispute("dp_twice", "pi_cs_one", { amount: 4_000 }), dispute("dp_twice", "pi_cs_one", { amount: 4_000 })];
  is("one partial dispute listed twice: counted once", await state(), { checked: true, one: ["partly refunded", 1_800] });
  disputes = [];

  done();
}

void main();
