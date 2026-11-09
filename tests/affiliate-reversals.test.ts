/**
 * What an affiliate earns once the money has moved again (lib/affiliates.ts,
 * readBook, noteSession; ClickFunnels audit F44–F50, added 17 October 2026).
 *
 * The defect this file was written around: commission was settled against
 * the refunds on the creator's Stripe account and nothing else. A chargeback
 * is not a refund — Stripe takes the money back through a dispute and no
 * refund is ever made — so a sale charged back still earned its affiliate the
 * full share, and the payout batch was built on it. The book now reads the
 * disputes beside the refunds (disputesSince). Checked:
 *
 *   - a refund in full takes the commission, a partial one leaves it on what
 *     was kept;
 *   - a dispute the bank is holding, or the buyer won, takes it too; an
 *     inquiry takes nothing, and a dispute the creator won earns again;
 *   - disputes that could not be read leave the book "not checked", and a
 *     payout batch is refused on such a book;
 *   - nobody earns on their own purchase, including from their inbox written
 *     another way; the creator cannot apply to their own programme;
 *   - a code typed at checkout credits the affiliate it was given to when no
 *     link was followed, never over a link, and never somebody removed.
 */
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { noteSession, readBook, requestAffiliateLink } from "@/lib/affiliates";
import { giveCode } from "@/lib/affiliate-codes";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_reversals_only";
process.env.RESEND_API_KEY = "re_test_affiliate_reversals_only";

const OWNER = "chef@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const GONE = "dddddddddddd";

let refunds: Record<string, unknown>[] = [];
let disputes: Record<string, unknown>[] = [];
let disputesWork = true;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/refunds") return answer({ object: "list", data: refunds, has_more: false });
  if (url.pathname === "/v1/disputes") return disputesWork ? answer({ object: "list", data: disputes, has_more: false }) : answer({ error: { message: "down" } }, 500);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", ...over });
const sale = (ref: string, aff: string, base: number) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at: NOW - 3600, product: "prod01", title: "Bread course", base, total: base, currency: "usd", rate: 30, self: false, how: "click" });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReversal1", true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, ("ana.cook" + "@" + "gmail.com"), "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:emails`, ("ana.cook" + "@" + "gmail.com"), ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", `nl:aff:${statsId}:codes`, "ben", BEN],
    ["HSET", `nl:aff:${statsId}:people`, GONE, person(GONE, "dee@example.com", "dee", { status: "removed" })],
    ["HSET", `nl:aff:${statsId}:codes`, "dee", GONE],
  ]);
  const line = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);

  part("Refunds");
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:sales`, "cs_full", sale("cs_full", ANA, 10_000)],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_part", sale("cs_part", ANA, 10_000)],
  ]);
  refunds = [
    { id: "re_full", object: "refund", status: "succeeded", payment_intent: "pi_cs_full", amount: 10_000, currency: "usd" },
    { id: "re_part", object: "refund", status: "succeeded", payment_intent: "pi_cs_part", amount: 4_000, currency: "usd" },
  ];
  is("refunded in full: nothing earned", [(await line("cs_full"))?.status, (await line("cs_full"))?.commission], ["refunded", 0]);
  is("refunded in part: 30% of what was kept", [(await line("cs_part"))?.status, (await line("cs_part"))?.commission], ["partly refunded", 1_800]);
  refunds = [];

  part("Chargebacks, which are not refunds");
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:sales`, "cs_lost", sale("cs_lost", BEN, 10_000)],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_open", sale("cs_open", BEN, 10_000)],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_won", sale("cs_won", BEN, 10_000)],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_ask", sale("cs_ask", BEN, 10_000)],
  ]);
  disputes = [
    { id: "dp_1", object: "dispute", status: "lost", payment_intent: "pi_cs_lost", amount: 10_000, currency: "usd", created: NOW },
    { id: "dp_2", object: "dispute", status: "needs_response", payment_intent: "pi_cs_open", amount: 10_000, currency: "usd", created: NOW },
    { id: "dp_3", object: "dispute", status: "won", payment_intent: "pi_cs_won", amount: 10_000, currency: "usd", created: NOW },
    { id: "dp_4", object: "dispute", status: "warning_needs_response", payment_intent: "pi_cs_ask", amount: 10_000, currency: "usd", created: NOW },
  ];
  let book = await readBook(store);
  const commission = (ref: string) => book.lines.find((l) => l.ref === ref)?.commission;
  is("a dispute lost: nothing earned", commission("cs_lost"), 0);
  is("a dispute the bank is holding: nothing earned while it holds it", commission("cs_open"), 0);
  is("a dispute the creator won: earned again", commission("cs_won"), 3_000);
  is("an inquiry, which takes no money: earned", commission("cs_ask"), 3_000);
  is("what Ben is owed counts only the two that stand", book.rows.find((r) => r.affiliate.id === BEN)?.owed, 6_000);
  is("and the book says it checked", book.refundsChecked, true);
  disputes[1] = { ...disputes[1], status: "won" };
  book = await readBook(store);
  is("the held dispute won by the creator: earned again", commission("cs_open"), 3_000);
  disputesWork = false;
  book = await readBook(store);
  is("disputes unreadable: the book says what is owed is not checked", book.refundsChecked, false);
  disputesWork = true;
  disputes = [];

  part("Nobody earns on their own purchase");
  const order = (id: string, email: string, meta: Record<string, string>, discounts: unknown[] = []) => ({
    id,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    amount_total: 5_000,
    amount_subtotal: 5_000,
    currency: "usd",
    total_details: { amount_tax: 0 },
    payment_intent: `pi_${id}`,
    metadata: { store: "harbor", product: "prod01", title: "Bread course", ...meta },
    customer_details: { email },
    discounts,
  });
  await noteSession(store, order("cs_self1", ("AnaCook+deals" + "@" + "gmail.com"), { via: ANA, via_rate: "30" }));
  is("bought through her own link with her inbox written another way: her own purchase, nothing earned", [(await line("cs_self1"))?.status, (await line("cs_self1"))?.commission], ["own purchase", 0]);
  is("the creator cannot apply to their own programme", await requestAffiliateLink({ store, email: "Chef@Example.com", note: "", ip: "203.0.113.20", origin: "https://marktmorgen.com" }), "owner");

  part("A code typed at checkout");
  await giveCode(store, "promo_1TestAnaCode001", ANA);
  await giveCode(store, "promo_1TestDeeCode001", GONE);
  store = (await storeForEmail(OWNER))!;
  const code = (promo: string) => [{ promotion_code: promo }];
  await noteSession(store, order("cs_code1", "cy@example.com", {}, code("promo_1TestAnaCode001")));
  is("no link followed: the code credits the affiliate it was given to, at today's share", [(await line("cs_code1"))?.aff, (await line("cs_code1"))?.how, (await line("cs_code1"))?.commission], [ANA, "code", 1_500]);
  await noteSession(store, order("cs_code2", "eve@example.com", { via: BEN, via_rate: "30" }, code("promo_1TestAnaCode001")));
  is("a link followed wins over a code typed", [(await line("cs_code2"))?.aff, (await line("cs_code2"))?.how], [BEN, "click"]);
  await noteSession(store, order("cs_code3", "fay@example.com", {}, code("promo_1TestDeeCode001")));
  is("a code given to somebody since removed credits nobody", await line("cs_code3"), undefined);
  await noteSession(store, order("cs_code4", ("ana.cook" + "@" + "gmail.com"), {}, code("promo_1TestAnaCode001")));
  is("her own code on her own purchase: nothing earned", [(await line("cs_code4"))?.status, (await line("cs_code4"))?.commission], ["own purchase", 0]);
  await noteSession(store, order("cs_code1", "cy@example.com", {}, code("promo_1TestAnaCode001")));
  is("the same order noticed twice is written once", (await readBook(store)).lines.filter((l) => l.ref === "cs_code1").length, 1);
  refunds = [{ id: "re_code1", object: "refund", status: "succeeded", payment_intent: "pi_cs_code1", amount: 5_000, currency: "usd" }];
  is("and its refund takes the code's commission back too", (await line("cs_code1"))?.commission, 0);

  done();
}

void main();
