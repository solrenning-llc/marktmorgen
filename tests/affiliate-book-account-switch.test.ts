// Money-defect hunt on the creator's connected Stripe account (Claude 7, 13/11/2026).
//
// The affiliate book (lib/affiliates.ts readBook) settles each sale against the refunds
// and disputes on the store's connected Stripe account, read on the account the store
// names NOW. When the creator disconnected their account, or moved to another one, the
// sales paid into the old account were judged against nothing: a refunded sale's
// commission came back as earned and owed, and the book still said refundsChecked, so a
// payout batch (lib/affiliate-payouts.ts) paid affiliates for money the creator had
// already given back to buyers. A sale paid into another account, or any Stripe sale
// while no account is connected, cannot be judged: the book now says it is not checked.
//
// Synthetic store and affiliate, Stripe mocked by account; MemoryRedis (tests/redis-stub.ts).
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { noteCharge, readBook } from "@/lib/affiliates";
import { decideLeads, readLeads, recordLead } from "@/lib/affiliate-leads";
import { leadsKey } from "@/lib/affiliate-lead-rules";
import { claimHandle, clearStripeAccount, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { OTHER_ACCOUNT_DAYS } from "@/lib/affiliates";
import { DISPUTE_DAYS as CHECKUP_DISPUTE_DAYS } from "@/lib/checkup";
import { DISPUTE_DAYS as PLAN_DISPUTE_DAYS } from "@/lib/refund-reserve-rules";
import { MAX_HOLD_DAYS } from "@/lib/affiliate-setting";
import { MAX_LEAD_HOLD_DAYS } from "@/lib/affiliate-lead-rules";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_account_switch_only";
process.env.RESEND_API_KEY = "re_test_affiliate_account_switch_only";

const OWNER = "book-switch@example.com";
const OLD = "acct_1BookOldAccount";
const NEW = "acct_1BookNewAccount";
const ANA = "aaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);

/** Refunds by account: only the old account holds the refund of the sale paid into it. */
const refundsOn: Record<string, Record<string, unknown>[]> = {
  [OLD]: [
    { id: "re_old1", object: "refund", status: "succeeded", payment_intent: "pi_1BookSale", amount: 10_000 },
    { id: "re_old2", object: "refund", status: "succeeded", payment_intent: "pi_1BookCall", amount: 5_000 },
  ],
  [NEW]: [],
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const account = new Headers(init?.headers).get("stripe-account") ?? "";
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.pathname === "/v1/refunds") return answer({ object: "list", data: refundsOn[account] ?? [], has_more: false });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "bookswitch", "Book Switch", "");
  await ensureStatsId(OWNER);
  is("old account connected", (await setStripeAccount(OWNER, OLD, true)).ok, true);
  await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
  ]);
  // A sale through Ana's link, paid into the old account, through the real writer.
  await noteCharge((await storeForEmail(OWNER))!, {
    id: "pi_1BookSale", status: "succeeded", amount: 10_000, currency: "usd", created: NOW - 3600,
    receipt_email: "buyer@example.com", metadata: { via: ANA, via_rate: "30", product: "prod01", title: "Bread course" },
  });

  part("control: on the account it was paid into, the refund takes the commission");
  let book = await readBook((await storeForEmail(OWNER))!);
  is("the sale is on the book", book.lines.length, 1);
  is("refunded in full: nothing earned", book.lines[0]?.commission, 0);
  is("checked", book.refundsChecked, true);
  is("the account a sale was paid into is never on a line", book.lines.some((line) => "acct" in line), false);

  part("the creator moves to another Stripe account");
  await clearStripeAccount(OWNER);
  is("new account connected", (await setStripeAccount(OWNER, NEW, true)).ok, true);
  book = await readBook((await storeForEmail(OWNER))!);
  is("the old account's refund was not read: the book is not said to be checked", book.refundsChecked, false);

  part("the creator disconnects Stripe altogether");
  await clearStripeAccount(OWNER);
  book = await readBook((await storeForEmail(OWNER))!);
  is("no account to read refunds on: the book is not said to be checked", book.refundsChecked, false);

  part("a sale written before sales named their account, read while none is connected");
  await redis.pipeline([["HSET", `nl:aff:${statsId}:sales`, "pi_1BookSale", JSON.stringify({
    ref: "pi_1BookSale", pi: "pi_1BookSale", aff: ANA, at: NOW - 3600, product: "prod01", title: "Bread course",
    base: 10_000, total: 10_000, currency: "usd", rate: 30, self: false, how: "click",
  })]]);
  book = await readBook((await storeForEmail(OWNER))!);
  is("legacy Stripe sale, no account connected: not checked", book.refundsChecked, false);

  part("control: back on the old account, all reads again");
  is("old account connected again", (await setStripeAccount(OWNER, OLD, true)).ok, true);
  book = await readBook((await storeForEmail(OWNER))!);
  is("refunded: nothing earned", book.lines[0]?.commission, 0);
  is("checked", book.refundsChecked, true);

  part("a partner's share of a sale paid into the old account, after a move to another one");
  const PARTNER_OWNER = "book-switch-partner@example.com";
  await claimHandle(PARTNER_OWNER, "bookpartner", "Book Partner", "");
  await ensureStatsId(PARTNER_OWNER);
  is("old account connected", (await setStripeAccount(PARTNER_OWNER, OLD, true)).ok, true);
  await setAffiliateSetting(PARTNER_OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const partnerStats = (await storeForEmail(PARTNER_OWNER))!.statsId!;
  await redis.pipeline([["HSET", `nl:aff:${partnerStats}:people`, ANA, JSON.stringify({
    id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "",
    share: { percent: 20, products: ["prod01"] },
  })]]);
  // No link: only the partner shares in this sale.
  await noteCharge((await storeForEmail(PARTNER_OWNER))!, {
    id: "pi_1BookSale", status: "succeeded", amount: 10_000, currency: "usd", created: NOW - 3600,
    receipt_email: "buyer@example.com", metadata: { product: "prod01", title: "Bread course" },
  });
  book = await readBook((await storeForEmail(PARTNER_OWNER))!);
  is("control: the partner's share is on the book", book.lines.map((l) => l.how), ["partner"]);
  is("control: refunded on its own account, nothing earned", [book.lines[0]?.commission, book.refundsChecked], [0, true]);
  await clearStripeAccount(PARTNER_OWNER);
  is("new account connected", (await setStripeAccount(PARTNER_OWNER, NEW, true)).ok, true);
  book = await readBook((await storeForEmail(PARTNER_OWNER))!);
  is("partner share paid into the old account: not checked", book.refundsChecked, false);

  part("a booked call's lead refunded on the old account, after a move to another one");
  const LEAD_OWNER = "book-switch-lead@example.com";
  await claimHandle(LEAD_OWNER, "booklead", "Book Lead", "");
  await ensureStatsId(LEAD_OWNER);
  await setSubscription(LEAD_OWNER, { customerId: "cus_BookLead0001", subscriptionId: "sub_BookLead0001", active: true, tier: "creator", trialEnds: 0, period: paidPeriod() });
  is("old account connected", (await setStripeAccount(LEAD_OWNER, OLD, true)).ok, true);
  await setAffiliateSetting(LEAD_OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30, lead: { kind: "booking", cents: 1_500, hold: 7, daily: 10, budget: 50_000 } });
  const leadStats = (await storeForEmail(LEAD_OWNER))!.statsId!;
  await redis.pipeline([["HSET", `nl:aff:${leadStats}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 60 * 86_400) * 1000, decidedAt: 1, note: "" })]]);
  // A call booked through Ana's link 40 days ago, paid 5,000 into the old account, its call long over, through the real writer.
  is("the booking's lead is written", await recordLead((await storeForEmail(LEAD_OWNER))!, {
    aff: ANA, kind: "booking", email: "caller@example.com", at: NOW - 40 * 86_400, end: NOW - 39 * 86_400, ref: "cs_test_bookleadcall01", pi: "pi_1BookCall", paid: 5_000, title: "Bread call",
  }), "recorded");
  const [kept] = await readLeads((await storeForEmail(LEAD_OWNER))!);
  is("the creator approves it", await decideLeads((await storeForEmail(LEAD_OWNER))!, [kept!.id], "approve"), { ok: true, changed: 1 });
  book = await readBook((await storeForEmail(LEAD_OWNER))!);
  is("control: refunded on its own account, the lead earns nothing", [book.lines.map((l) => [l.how, l.status, l.commission]), book.refundsChecked], [[["lead", "refunded", 0]], true]);
  is("the account a lead was paid into is never on a line", book.lines.some((line) => "acct" in line || "acct" in (line.lead ?? {})), false);
  await clearStripeAccount(LEAD_OWNER);
  is("new account connected", (await setStripeAccount(LEAD_OWNER, NEW, true)).ok, true);
  book = await readBook((await storeForEmail(LEAD_OWNER))!);
  is("lead refunded on the old account: it earns nothing, or the book is not checked", book.refundsChecked === false || book.lines.every((l) => l.commission === 0), true);
  is("lead paid into the old account: not checked", book.refundsChecked, false);

  part("only a sale on another account still inside its refund and dispute window holds the book");
  is("the window is at least the longest dispute window and hold the code knows", [CHECKUP_DISPUTE_DAYS, PLAN_DISPUTE_DAYS, MAX_HOLD_DAYS, MAX_LEAD_HOLD_DAYS].every((days) => OTHER_ACCOUNT_DAYS >= days), true);
  const WINDOW_OWNER = "book-switch-window@example.com";
  await claimHandle(WINDOW_OWNER, "bookwindow", "Book Window", "");
  await ensureStatsId(WINDOW_OWNER);
  is("new account connected", (await setStripeAccount(WINDOW_OWNER, NEW, true)).ok, true);
  await setAffiliateSetting(WINDOW_OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const windowStats = (await storeForEmail(WINDOW_OWNER))!.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${windowStats}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 800 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${windowStats}:codes`, "ana", ANA],
  ]);
  const oldSale = (pi: string, at: number | undefined) => JSON.stringify({
    ref: pi, pi, aff: ANA, ...(at === undefined ? {} : { at }), product: "prod01", title: "Bread course",
    base: 10_000, total: 10_000, currency: "usd", rate: 30, self: false, how: "click", acct: OLD,
  });
  // Paid into the old account two years ago, as writeReferral writes it: long past any refund or dispute window.
  await redis.pipeline([["HSET", `nl:aff:${windowStats}:sales`, "pi_1WindowOld", oldSale("pi_1WindowOld", NOW - 730 * 86_400)]]);
  // And a new sale on the new account, through the real writer.
  await noteCharge((await storeForEmail(WINDOW_OWNER))!, {
    id: "pi_1WindowNew", status: "succeeded", amount: 10_000, currency: "usd", created: NOW - 3600,
    receipt_email: "buyer2@example.com", metadata: { via: ANA, via_rate: "30", product: "prod01", title: "Bread course" },
  });
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("both sales on the book", book.lines.length, 2);
  is("a sale on the old account 730 days ago no longer holds the book: checked", book.refundsChecked, true);
  await redis.pipeline([["HSET", `nl:aff:${windowStats}:sales`, "pi_1WindowRecent", oldSale("pi_1WindowRecent", NOW - 10 * 86_400)]]);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("a sale on the old account 10 days ago: not checked", book.refundsChecked, false);
  await redis.pipeline([["HDEL", `nl:aff:${windowStats}:sales`, "pi_1WindowRecent"], ["HSET", `nl:aff:${windowStats}:sales`, "pi_1WindowNoTime", oldSale("pi_1WindowNoTime", undefined)]]);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("a sale on the old account whose time does not read counts as inside the window: not checked", book.refundsChecked, false);
  await redis.pipeline([["HDEL", `nl:aff:${windowStats}:sales`, "pi_1WindowNoTime"]]);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("control: only the old sale outside the window and the new one: checked", book.refundsChecked, true);
  // A booked call's lead paid into the old account: its window runs from the later of its booking and its call.
  const oldLead = (at: number, end: number) => JSON.stringify({
    id: "bbbbbbbbbbbbbbbbbbbbbbbb", aff: ANA, kind: "booking", at, end, ref: "cs_test_windowcall01", pi: "pi_1WindowCall", paid: 5_000,
    title: "Bread call", email: "caller@example.com", cents: 1_500, currency: "usd", hold: 7, daily: 10, budget: 50_000, state: "approved", d: 1, why: "", acct: OLD,
  });
  await redis.pipeline([["HSET", leadsKey(windowStats), "bbbbbbbbbbbbbbbbbbbbbbbb", oldLead(NOW - 400 * 86_400, NOW - 400 * 86_400)]]);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("a lead on the old account booked and held 400 days ago: checked", book.refundsChecked, true);
  await redis.pipeline([["HSET", leadsKey(windowStats), "bbbbbbbbbbbbbbbbbbbbbbbb", oldLead(NOW - 400 * 86_400, NOW - 10 * 86_400)]]);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("a lead on the old account booked 400 days ago for a call 10 days ago: not checked", book.refundsChecked, false);
  await redis.pipeline([["HSET", leadsKey(windowStats), "bbbbbbbbbbbbbbbbbbbbbbbb", oldLead(0, NOW - 400 * 86_400)]]);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("a lead on the old account whose booking time does not read: not checked", book.refundsChecked, false);
  await redis.pipeline([["HDEL", leadsKey(windowStats), "bbbbbbbbbbbbbbbbbbbbbbbb"]]);
  await clearStripeAccount(WINDOW_OWNER);
  book = await readBook((await storeForEmail(WINDOW_OWNER))!);
  is("no account connected, a sale inside the window: not checked", book.refundsChecked, false);
  done();
}

void main();
