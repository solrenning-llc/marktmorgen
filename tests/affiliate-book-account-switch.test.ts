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
import { bookCsv, listAffiliates, noteCharge, readBook } from "@/lib/affiliates";
import { owedLines } from "@/lib/affiliate-payouts";
import { bookSlice, keptSlice } from "@/lib/affiliate-book-snapshot";
import { COPIERS } from "@/lib/person-copy";
import { decideLeads, readLeads, recordLead } from "@/lib/affiliate-leads";
import { REFUND_MARK_MAX_BYTES, leadsKey, readRefundMark } from "@/lib/affiliate-lead-rules";
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

  part("a refund read on the sale's own account is remembered, so it still counts after a move past the window");
  const MARK_OWNER = "book-switch-mark@example.com";
  await claimHandle(MARK_OWNER, "bookmark", "Book Mark", "");
  await ensureStatsId(MARK_OWNER);
  is("old account connected", (await setStripeAccount(MARK_OWNER, OLD, true)).ok, true);
  await setAffiliateSetting(MARK_OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const markStats = (await storeForEmail(MARK_OWNER))!.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${markStats}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 800 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${markStats}:codes`, "ana", ANA],
  ]);
  // Paid into the old account 200 days ago and refunded there in full; a second sale there refunded 4,000 of 10,000.
  refundsOn[OLD].push(
    { id: "re_old_mark", object: "refund", status: "succeeded", payment_intent: "pi_1MarkRefunded", amount: 10_000 },
    { id: "re_old_part", object: "refund", status: "succeeded", payment_intent: "pi_1MarkPart", amount: 4_000 },
  );
  for (const pi of ["pi_1MarkRefunded", "pi_1MarkPart"]) {
    await noteCharge((await storeForEmail(MARK_OWNER))!, {
      id: pi, status: "succeeded", amount: 10_000, currency: "usd", created: NOW - 200 * 86_400,
      receipt_email: `${pi}@example.com`, metadata: { via: ANA, via_rate: "30", product: "prod01", title: "Bread course" },
    });
  }
  const markOf = async (pi: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${markStats}:sales`, pi]]);
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    // The mark is `rf` in base 36; the account it was read on is the record's own `acct`, never a field of its own.
    return [typeof value.rf === "string" && /^[0-9a-z]+$/.test(value.rf) ? parseInt(value.rf, 36) : value.rf, "rfa" in value ? value.rfa : value.acct];
  };
  book = await readBook((await storeForEmail(MARK_OWNER))!);
  is("control: read on the old account, the refunded sale earns nothing", book.lines.find((l) => l.pi === "pi_1MarkRefunded")?.commission, 0);
  is("the refund read on the sale's own account is kept on the sale, with the account", await markOf("pi_1MarkRefunded"), [10_000, OLD]);
  is("a partial refund is kept as read", await markOf("pi_1MarkPart"), [4_000, OLD]);
  is("the kept refund is never on a line", book.lines.some((line) => "rf" in line || "rfa" in line), false);
  is("the mark is within REFUND_MARK_MAX_BYTES of the record", (await redis.pipeline([["HGET", `nl:aff:${markStats}:sales`, "pi_1MarkRefunded"]]).then(([raw]) => String(raw).length)) - JSON.stringify({ ...JSON.parse(String((await redis.pipeline([["HGET", `nl:aff:${markStats}:sales`, "pi_1MarkRefunded"]]))[0])), rf: undefined }).length <= REFUND_MARK_MAX_BYTES, true);
  is("the largest mark fits REFUND_MARK_MAX_BYTES", `,"rf":${JSON.stringify(Number.MAX_SAFE_INTEGER.toString(36))}`.length, REFUND_MARK_MAX_BYTES);
  is("a mark not in exact base 36 is not a mark", [readRefundMark("00"), readRefundMark("-1"), readRefundMark("A"), readRefundMark("2gosa7pa2gw"), readRefundMark("7ps")], [null, null, null, null, 10_000]);
  // A later smaller read never lowers what was kept; a larger one raises it.
  refundsOn[OLD] = refundsOn[OLD].map((r) => (r.id === "re_old_part" ? { ...r, amount: 1_000 } : r));
  await readBook((await storeForEmail(MARK_OWNER))!);
  is("a later smaller read does not lower the kept refund", await markOf("pi_1MarkPart"), [4_000, OLD]);
  refundsOn[OLD] = refundsOn[OLD].map((r) => (r.id === "re_old_part" ? { ...r, amount: 6_000 } : r));
  await readBook((await storeForEmail(MARK_OWNER))!);
  is("a later larger read raises it", await markOf("pi_1MarkPart"), [6_000, OLD]);
  // The creator moves to the new account; the old sales are 200 days old, past the window.
  await clearStripeAccount(MARK_OWNER);
  is("new account connected", (await setStripeAccount(MARK_OWNER, NEW, true)).ok, true);
  book = await readBook((await storeForEmail(MARK_OWNER))!);
  is("refunded before the move, 200 days ago: it earns nothing after the move", book.lines.find((l) => l.pi === "pi_1MarkRefunded")?.commission, 0);
  is("partly refunded before the move: it earns on what was kept", book.lines.find((l) => l.pi === "pi_1MarkPart")?.commission, 1_200);
  is("both read before the move: the book is checked", book.refundsChecked, true);
  is("neither line is held", book.lines.some((l) => l.unchecked === true), false);
  is("the payout pays only what was kept", owedLines(book).map((l) => l.cents), [1_200]);
  is("the kept refund is never on a line after the move", book.lines.some((line) => "rf" in line || "rfa" in line), false);
  is("nor in the spreadsheet", /\brfa?\b|acct_/.test(bookCsv(book, await listAffiliates((await storeForEmail(MARK_OWNER))!))), false);
  is("nor in a kept slice of the book", /"rfa?"|acct_/.test(JSON.stringify(keptSlice(bookSlice(book, ANA)))), false);

  part("a sale on another account never read there, past the window: only that line is held");
  const HELD_OWNER = "book-switch-held@example.com";
  await claimHandle(HELD_OWNER, "bookheld", "Book Held", "");
  await ensureStatsId(HELD_OWNER);
  is("new account connected", (await setStripeAccount(HELD_OWNER, NEW, true)).ok, true);
  await setAffiliateSetting(HELD_OWNER, { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const heldStats = (await storeForEmail(HELD_OWNER))!.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${heldStats}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 800 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${heldStats}:codes`, "ana", ANA],
    // Paid into the old account 200 days ago and never read there: what it earns is not known.
    ["HSET", `nl:aff:${heldStats}:sales`, "pi_1HeldOld", oldSale("pi_1HeldOld", NOW - 200 * 86_400)],
  ]);
  await noteCharge((await storeForEmail(HELD_OWNER))!, {
    id: "pi_1HeldNew", status: "succeeded", amount: 10_000, currency: "usd", created: NOW - 3600,
    receipt_email: "buyer3@example.com", metadata: { via: ANA, via_rate: "30", product: "prod01", title: "Bread course" },
  });
  book = await readBook((await storeForEmail(HELD_OWNER))!);
  is("both sales on the book", book.lines.length, 2);
  is("the book is not blocked by the one unread line", book.refundsChecked, true);
  is("the unread line is held", book.lines.find((l) => l.pi === "pi_1HeldOld")?.unchecked, true);
  is("the line on the store's account is not", book.lines.find((l) => l.pi === "pi_1HeldNew")?.unchecked, undefined);
  is("what is payable leaves the held line out", book.rows[0]?.payable, 3_000);
  is("the payout pays only the line that was checked", owedLines(book).map((l) => l.cents), [3_000]);
  const [heldRaw] = await redis.pipeline([["HGET", `nl:aff:${heldStats}:sales`, "pi_1HeldOld"]]);
  is("an unread line keeps no refund it was never read for", "rf" in (JSON.parse(String(heldRaw)) as Record<string, unknown>), false);

  part("a booked call's kept refund never reaches the person's copy of their lead");
  const leadCopy = (await COPIERS["lib/affiliate-leads.ts"]({ store: (await storeForEmail(LEAD_OWNER))!, email: "caller@example.com" } as unknown as Parameters<(typeof COPIERS)[string]>[0])) as Record<string, unknown>[];
  const [leadRaw] = await redis.pipeline([["HGET", leadsKey(leadStats), String(leadCopy[0]?.id)]]);
  const leadKept = JSON.parse(String(leadRaw)) as Record<string, unknown>;
  is("the lead's refund read on its own account was kept", [typeof leadKept.rf === "string" ? parseInt(leadKept.rf, 36) : leadKept.rf, "rfa" in leadKept ? leadKept.rfa : leadKept.acct], [5_000, OLD]);
  is("the person's copy leaves it out", leadCopy.some((l) => "rf" in l || "rfa" in l || "acct" in l), false);
  done();
}

void main();
