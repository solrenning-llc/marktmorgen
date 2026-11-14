/**
 * A refund or dispute list page, and each row's state and payment, count
 * only when Stripe's answer reads exactly (lib/affiliates.ts, refundsSince
 * and disputesSince; rule 24, money; Claude 3 and Codex G on #3189).
 *
 * The defect this file was written around: a page whose `data` was missing
 * or not a list read as an empty list, a `has_more` that was missing or not
 * true or false read as "the end", a page that said there was more but gave
 * no row (or no readable last row) read as "the end", and a page that was not
 * a list at all was never looked at. Each gave refundsChecked true with
 * nothing read, so the full commission was payable. A refund in
 * `requires_action` (made, waiting on the buyer), or with a status missing,
 * of another type or not one Stripe gives, was skipped as "not refunded"; a
 * dispute with a status that does not read the same; a counted refund whose
 * payment could not be read was skipped. Two records of one payment in
 * different currencies let the last one decide. Checked:
 *
 *   - every unreadable page shape, on both lists, leaves the book "not checked";
 *   - `requires_action` counts as refunded, like `pending`;
 *   - a refund or dispute status that does not read holds the book;
 *   - a payment that is neither text, an object with an id, nor null holds it,
 *     and so does a counted row with no payment_intent field at all;
 *   - a refund on a payment whose records disagree on the currency holds it;
 *   - healthy controls: a complete page, a known non-counting state (failed,
 *     canceled, won), a refund with no payment, an expanded payment, and a
 *     ten-page list that is still not finished (incomplete, ten calls).
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_refunds_page_only";
process.env.RESEND_API_KEY = "re_test_affiliate_refunds_page_only";

const OWNER = "miller@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const PI = "pi_cs_one";

const list = (data: unknown[] = [], over: Record<string, unknown> = {}) => ({ object: "list", data, has_more: false, ...over });
let refundPage: unknown = list();
let disputePage: unknown = list();
let refundCalls = 0;
let writes = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (init?.method && init.method !== "GET") writes += 1;
  const url = new URL(String(input));
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.pathname === "/v1/refunds") {
    refundCalls += 1;
    return answer(refundPage);
  }
  if (url.pathname === "/v1/disputes") return answer(disputePage);
  return answer(list());
}) as typeof fetch;

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });
const sale = (ref: string, currency = "usd") =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff: ANA, at: NOW - 3600, product: "prod01", title: "Rye course", base: 10_000, total: 10_000, currency, rate: 30, self: false, how: "click" });
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_one", object: "refund", status: "succeeded", payment_intent: PI, amount: 10_000, currency: "usd", ...over });
const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_one", object: "dispute", status: "lost", payment_intent: PI, amount: 10_000, currency: "usd", created: NOW, ...over });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rye", "Rye Mill", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPageRye1", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_one", sale("cs_one")],
  ]);
  const state = async () => {
    const book = await readBook(store);
    const one = book.lines.find((l) => l.ref === "cs_one");
    return { checked: book.refundsChecked, one: [one?.status, one?.commission] };
  };

  part("Healthy controls");
  is("a complete empty page: earned, checked", await state(), { checked: true, one: ["earned", 3_000] });
  refundPage = list([refund({ amount: 4_000 })]);
  is("an exact partial refund: 30% of what was kept, checked", await state(), { checked: true, one: ["partly refunded", 1_800] });
  for (const status of ["failed", "canceled"]) {
    refundPage = list([refund({ status, amount: "garbled" })]);
    is(`a ${status} refund: not counted, checked`, await state(), { checked: true, one: ["earned", 3_000] });
  }
  refundPage = list([refund({ payment_intent: null, currency: "eur" })]);
  is("a refund with no payment (null): cannot be on the book, checked", await state(), { checked: true, one: ["earned", 3_000] });
  refundPage = list([refund({ payment_intent: { id: PI, object: "payment_intent" } })]);
  is("a refund whose payment is expanded with its id: counted", await state(), { checked: true, one: ["refunded", 0] });
  refundPage = list();
  disputePage = list([dispute({ status: "won", amount: "garbled" })]);
  is("a won dispute: not taken, checked", await state(), { checked: true, one: ["earned", 3_000] });
  disputePage = list();
  refundCalls = 0;
  refundPage = list([refund({ id: "re_more", status: "failed" })], { has_more: true });
  const ceiling = await state();
  is("a list still not finished after ten pages: not checked, ten calls", [ceiling.checked, refundCalls], [false, 10]);
  refundPage = list();

  const pages: [string, unknown][] = [
    ["no data", { object: "list", has_more: false }],
    ["data null", { object: "list", data: null, has_more: false }],
    ["data an object", { object: "list", data: {}, has_more: false }],
    ["no has_more", { object: "list", data: [] }],
    ["has_more in text", { object: "list", data: [], has_more: "true" }],
    ["more, but no row", { object: "list", data: [], has_more: true }],
    ["more, but the last row has no id", { object: "list", data: [refund({ id: undefined, status: "failed" })], has_more: true }],
    ["not a list", { object: "invoice", data: [], has_more: false }],
    ["no object", { data: [], has_more: false }],
    ["a row that is not an object", { object: "list", data: [null], has_more: false }],
  ];
  part("A refund page that does not read holds the book");
  for (const [what, page] of pages) {
    refundPage = page;
    is(`refund page with ${what}: not checked`, (await state()).checked, false);
  }
  refundPage = list();
  part("A dispute page that does not read holds the book");
  for (const [what, page] of pages) {
    disputePage = page;
    is(`dispute page with ${what}: not checked`, (await state()).checked, false);
  }
  disputePage = list();

  part("A refund's state");
  refundPage = list([refund({ status: "requires_action" })]);
  is("a refund in requires_action (made, waiting on the buyer): counted as refunded", await state(), { checked: true, one: ["refunded", 0] });
  for (const [what, status] of [["no status", undefined], ["status null", null], ["status a number", 7], ["a status Stripe does not give", "processing"]] as [string, unknown][]) {
    refundPage = list([refund({ status })]);
    is(`a refund with ${what}: not checked`, (await state()).checked, false);
  }
  refundPage = list([refund({ object: "invoice" })]);
  is("a refund row that is not a refund: not checked", (await state()).checked, false);
  refundPage = list();

  part("A dispute's state");
  for (const [what, status] of [["no status", undefined], ["a status Stripe does not give", "g_future"]] as [string, unknown][]) {
    disputePage = list([dispute({ status })]);
    is(`a dispute with ${what}: not checked`, (await state()).checked, false);
  }
  disputePage = list([dispute({ object: "refund" })]);
  is("a dispute row that is not a dispute: not checked", (await state()).checked, false);
  disputePage = list();

  part("A counted refund's payment");
  for (const [what, pi] of [["a number", 17], ["an object with no id", { object: "payment_intent" }], ["an empty text", ""]] as [string, unknown][]) {
    refundPage = list([refund({ payment_intent: pi })]);
    is(`a succeeded refund whose payment is ${what}: not checked`, (await state()).checked, false);
  }
  refundPage = list();
  for (const [what, pi] of [["a number", 17], ["an object with no id", { object: "payment_intent" }]] as [string, unknown][]) {
    disputePage = list([dispute({ payment_intent: pi })]);
    is(`a lost dispute whose payment is ${what}: not checked`, (await state()).checked, false);
  }
  disputePage = list();

  // Codex G's second money review of #3189 (G97-LPI): a counted row with no payment_intent field at all is not one
  // that says it names no payment (only an explicit null says that, the control above); it read as "nothing on the
  // book", and the full commission was payable.
  part("A counted refund or dispute with no payment_intent field");
  const without = (row: Record<string, unknown>) => {
    const { payment_intent: _, ...rest } = row;
    void _;
    return rest;
  };
  for (const status of ["succeeded", "pending", "requires_action"]) {
    refundPage = list([without(refund({ status }))]);
    is(`a ${status} refund with no payment_intent field: not checked`, (await state()).checked, false);
  }
  refundPage = list();
  disputePage = list([without(dispute())]);
  is("a lost dispute with no payment_intent field: not checked", (await state()).checked, false);
  disputePage = list();
  refundPage = list([without(refund({ status: "failed" }))]);
  is("control: a failed refund with no payment_intent field gives nothing back: checked", await state(), { checked: true, one: ["earned", 3_000] });
  refundPage = list();
  disputePage = list([without(dispute({ status: "won" }))]);
  is("control: a won dispute with no payment_intent field takes nothing: checked", await state(), { checked: true, one: ["earned", 3_000] });
  disputePage = list([dispute({ payment_intent: null })]);
  is("control: a lost dispute with no payment (null): cannot be on the book, checked", await state(), { checked: true, one: ["earned", 3_000] });
  disputePage = list();

  part("Two records of one payment disagree on its currency");
  await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "cs_two", JSON.stringify({ ...JSON.parse(sale("cs_one", "eur")), ref: "cs_two" })]]);
  refundPage = list([refund({ amount: 4_000, currency: "eur" })]);
  is("a refund on a payment recorded in two currencies: not checked", (await state()).checked, false);
  refundPage = list([refund({ amount: 4_000 })]);
  is("the same refund in the other currency: not checked either", (await state()).checked, false);
  refundPage = list();
  is("no refund on that payment: checked", (await state()).checked, true);

  is("nothing was written to Stripe", writes, 0);
  done();
}

void main();
