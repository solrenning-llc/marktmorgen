/**
 * A refund or a dispute for a payment that is not on the affiliate book
 * cannot change any line of it, so its amount is never judged (#5285 row
 * #3189, Claude 1's LOW): before, one damaged row for a payment not on the
 * book (an amount that is not whole cents, text, missing, or in another
 * currency) left the whole book "not checked", and no affiliate was paid
 * that day. A row for a payment on the book still holds the book exactly as
 * before (tests/affiliate-refunds-exact.test.ts), and a row whose payment
 * does not read still holds it. A row with no id is not readable as a row of
 * the page (lib/stripe-list.ts, readStripePage), so it still holds the book:
 * the page cannot be followed past it.
 * Synthetic only: the Redis stub and a stand-in for Stripe.
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_off_book_only";
process.env.RESEND_API_KEY = "re_test_affiliate_off_book_only";

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
  await setStripeAccount(OWNER, "acct_1TestOffBook01", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_one", sale("cs_one", 10_000)],
  ]);
  const state = async () => {
    const book = await readBook(store);
    const one = book.lines.find((l) => l.ref === "cs_one");
    return { checked: book.refundsChecked, one: [one?.status, one?.commission] };
  };

  part("Control: a damaged row for a payment on the book still holds it");
  refunds = [refund("re_bad", "pi_cs_one", { amount: 99.5 })];
  disputes = [];
  is("refund on the book, half a cent: not checked", (await state()).checked, false);
  refunds = [];
  disputes = [dispute("dp_bad", "pi_cs_one", { amount: "10000" })];
  is("lost dispute on the book, amount as text: not checked", (await state()).checked, false);
  disputes = [];
  refunds = [refund("re_nopi", "pi_cs_one", { payment_intent: 7 })];
  is("a refund whose payment does not read: not checked", (await state()).checked, false);
  refunds = [];

  for (const [what, over] of [
    ["an amount that is not whole cents", { amount: 99.5 }],
    ["an amount that is text", { amount: "10000" }],
    ["an amount that is missing", { amount: undefined }],
    ["a negative amount", { amount: -10_000 }],
    ["no currency", { currency: undefined }],
  ] as [string, Record<string, unknown>][]) {
    part(`A row for a payment not on the book with ${what}`);
    refunds = [refund("re_off", "pi_not_on_the_book", over)];
    disputes = [];
    is("a refund: the book is checked and the sale earns", await state(), { checked: true, one: ["earned", 3_000] });
    refunds = [];
    disputes = [dispute("dp_off", "pi_not_on_the_book", over)];
    is("a lost dispute: the book is checked and the sale earns", await state(), { checked: true, one: ["earned", 3_000] });
    disputes = [];
  }
  done();
}

void main();
