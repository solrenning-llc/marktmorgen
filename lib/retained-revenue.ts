/**
 * What a store kept, by currency (added 18 October 2026; ClickFunnels audit
 * F51 and F52, priority 4 "Reconciled retained revenue").
 *
 * For each window, every currency the store was paid in gets one line:
 *
 *   paid at checkout (purchases and one-click extras)
 * + renewals (memberships renewed, later plan payments)
 * − refunds given in the window
 * − disputed money the bank holds or gave back to the buyer (disputeTakes)
 * = kept.
 *
 * Currencies are never added together and nothing is converted: euros added
 * to dollars make a number that means nothing. A line is "complete" only when
 * every one of its four readings was read in full; otherwise its kept figure
 * is null and the page says which reading is missing, because a figure with
 * a reading left out looks exactly like a real one.
 *
 * Refunds and disputes count on the day they were recorded, which may be
 * after the sale they take back (as the money-by-source table already says).
 * The disputed amount is before Stripe's dispute fee, which Stripe charges
 * the creator separately and is not read here. PayPal disputes are not read
 * at all, and the page says so when the store sells through PayPal.
 *
 * For the store's own currency, the kept money is also split by the channel a
 * sale is under, so the money with no channel recorded is visible instead of
 * folded into a total: "direct" (a sale that carried no tag and no remembered
 * visit) and "unrecorded" (a renewal, refund or dispute that could not be
 * matched to a sale read). A channel says where the buyer came from; it does
 * not show that the channel caused the sale (ATTRIBUTION_NOTE).
 *
 * Pure: imports nothing, so the studio, the tests and the CSV read one rule.
 */

/**
 * The states of a Stripe dispute in which the money may not be the creator's:
 * held by the bank while it is answered or reviewed, or taken back for good
 * (lost). `prevented` is here for a reader that has only the status (the
 * affiliate book, lib/affiliates.ts): it may be a resolution, refunded to the
 * buyer, so such a reader never pays a commission on it. A reader that has
 * the dispute itself asks disputeTakes, which reads a prevented dispute's own
 * money. An inquiry (warning_*) takes nothing, and a dispute won gives it
 * back. The legacy `charge_refunded` (removed in API 2023-08-16) is left out:
 * its money went back through a refund, which the refund reading already
 * takes off, so counting it here would take it twice. Statuses: stripe-node
 * v22.6.0 Dispute.Status and its CHANGELOG.
 */
export const DISPUTE_TAKES: ReadonlySet<string> = new Set(["needs_response", "under_review", "lost", "prevented"]);

/**
 * Whether a dispute's own balance transactions took money from the creator
 * and did not put it back. Stripe's `prevented` is either a `resolution`,
 * "resolved (refunded) before it could become a chargeback", or a `block`,
 * stopped by the card network while the merchant keeps the money (API
 * reference, Dispute payment_method_details.card.case_type; changelog basil
 * 2025-08-27). case_type does not exist at the versions read here, so the
 * money is read instead: `balance_transactions` is "zero, one, or two balance
 * transactions that show funds withdrawn and reinstated to your Stripe
 * account as a result of this dispute", and a negative `amount` is funds sent
 * to another party (stripe-node v12.18.0 types/Disputes.d.ts, v22.6.0
 * src/resources/Disputes.ts and BalanceTransactions.ts). `amount`, not `net`:
 * the fee on a withdrawal is Stripe's dispute fee, not money given back.
 *
 * True when more was withdrawn than reinstated; false when nothing was
 * withdrawn or all of it was reinstated; null when the list or any amount is
 * not in that shape (CX-123 rule 24), never read as either. A Refund's money
 * is the Refund's own balance transaction, never one of these, so a
 * resolution that also made a Refund is counted once, by the refund reading.
 */
export function disputeMoneyGone(dispute: unknown): boolean | null {
  if (!dispute || typeof dispute !== "object" || Array.isArray(dispute)) return null;
  const moves = (dispute as { balance_transactions?: unknown }).balance_transactions;
  if (!Array.isArray(moves) || moves.length > 2) return null;
  let total = 0;
  for (const move of moves) {
    if (!move || typeof move !== "object" || Array.isArray(move)) return null;
    const { object, amount } = move as { object?: unknown; amount?: unknown };
    if (object !== "balance_transaction" || typeof amount !== "number" || !Number.isSafeInteger(amount)) return null;
    total += amount;
  }
  // A dispute that put back more than it took is not a shape Stripe documents.
  if (total > 0) return null;
  return total < 0;
}

/**
 * Whether one dispute Stripe listed takes the creator's money, for a reader
 * that has the dispute itself (lib/stats.ts). A prevented one by its own
 * money (disputeMoneyGone; null when that cannot be read, so the reader
 * says it is partial instead of guessing); every other status as
 * DISPUTE_TAKES says.
 */
export function disputeTakes(dispute: { status?: unknown; balance_transactions?: unknown }): boolean | null {
  if (dispute.status === "prevented") return disputeMoneyGone(dispute);
  return typeof dispute.status === "string" && DISPUTE_TAKES.has(dispute.status);
}

/** A channel name for a renewal, refund or dispute that no sale read explains. */
export const UNPLACED = "unrecorded";

export const ATTRIBUTION_NOTE =
  "A channel says where the buyer came from before buying. It does not show that the channel caused the sale, and it is not a measure of lift.";

export const DISPUTE_NOTE =
  "Disputed is the amount of each dispute the bank is holding or gave back to the buyer, before Stripe's dispute fee. A dispute you win gives it back and it leaves this column.";

export type Window = "d7" | "d30" | "d90";
export const WINDOWS: readonly Window[] = ["d7", "d30", "d90"];

/** One amount in the smallest unit of its currency, with the day (UTC) it was recorded and the channel it is under. */
export type Entry = { day: string; cents: number; currency: string; source: string };

export type Readings = {
  /** Checkouts and one-click extras. Complete when every page was read. */
  sales: { entries: Entry[]; complete: boolean };
  /** Paid renewal invoices; null when the store has no Stripe account and so no renewals to read. */
  renewals: { entries: Entry[]; complete: boolean } | null;
  /** Refunds, Stripe's and PayPal's; null when they could not be read. */
  refunds: { entries: Entry[]; complete: boolean } | null;
  /** Disputes in DISPUTE_TAKES; null when they could not be read. No Stripe account reads as complete and empty. */
  disputes: { entries: Entry[]; complete: boolean } | null;
};

export type KeptLine = {
  currency: string;
  sales: number;
  salesCents: number;
  renewals: number;
  renewalCents: number;
  refunds: number;
  refundCents: number;
  disputes: number;
  disputeCents: number;
  /** Null when a reading is missing or incomplete; then `missing` names it. */
  keptCents: number | null;
  missing: ("sales" | "renewals" | "refunds" | "disputes")[];
};

export type KeptWindow = {
  lines: KeptLine[];
  /**
   * The store currency's kept money by channel ("" and "direct" are folded into
   * "direct"), biggest first. Null when that currency's line is not complete.
   */
  byChannel: { source: string; keptCents: number }[] | null;
  /** The part of byChannel with no channel: direct, and unrecorded (not matched to a sale read). */
  unattributed: { direct: number; unrecorded: number } | null;
};

/** The first day (YYYY-MM-DD) of each window, from the day "today" is. Pure date arithmetic in UTC. */
export function windowStarts(today: string): Record<Window, string> {
  const at = Date.parse(`${today}T00:00:00Z`);
  const back = (days: number) => new Date(at - days * 86400_000).toISOString().slice(0, 10);
  return { d7: back(6), d30: back(29), d90: back(89) };
}

const channelOf = (source: string) => (source === "" || source === "direct" ? "direct" : source);

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a reading holds an entry it could not read (CX-123 rule 24): a day
 * that is not a day, or, in the window, an amount that is not a whole number
 * of the smallest unit or a currency that is not named. A refund, renewal or
 * dispute is never for nothing, so a zero there is an amount not read too.
 * Such an entry makes the reading incomplete: left out, the money would make
 * the kept figure look exactly like a real one.
 */
function holdsUnread(entries: Entry[], from: string, positive: boolean): boolean {
  return entries.some((e) => {
    if (typeof e.day !== "string" || !DAY_SHAPE.test(e.day)) return true;
    if (e.day < from) return false;
    return !Number.isSafeInteger(e.cents) || e.cents < (positive ? 1 : 0) || typeof e.currency !== "string" || !e.currency;
  });
}

/** What each currency kept in one window, and the store currency's kept money by channel. */
export function keptIn(readings: Readings, from: string, storeCurrency: string): KeptWindow {
  const by = new Map<string, KeptLine>();
  const line = (currency: string): KeptLine => {
    let row = by.get(currency);
    if (!row) {
      row = { currency, sales: 0, salesCents: 0, renewals: 0, renewalCents: 0, refunds: 0, refundCents: 0, disputes: 0, disputeCents: 0, keptCents: null, missing: [] };
      by.set(currency, row);
    }
    return row;
  };
  const channels = new Map<string, number>();
  const toChannel = (entry: Entry, sign: 1 | -1) => {
    if (entry.currency !== storeCurrency) return;
    const key = channelOf(entry.source);
    channels.set(key, (channels.get(key) ?? 0) + sign * entry.cents);
  };
  const inWindow = (entries: Entry[]) => entries.filter((e) => e.day >= from && e.cents > 0 && e.currency);
  for (const e of inWindow(readings.sales.entries)) {
    const row = line(e.currency);
    row.sales += 1;
    row.salesCents += e.cents;
    toChannel(e, 1);
  }
  for (const e of inWindow(readings.renewals?.entries ?? [])) {
    const row = line(e.currency);
    row.renewals += 1;
    row.renewalCents += e.cents;
    toChannel(e, 1);
  }
  for (const e of inWindow(readings.refunds?.entries ?? [])) {
    const row = line(e.currency);
    row.refunds += 1;
    row.refundCents += e.cents;
    toChannel(e, -1);
  }
  for (const e of inWindow(readings.disputes?.entries ?? [])) {
    const row = line(e.currency);
    row.disputes += 1;
    row.disputeCents += e.cents;
    toChannel(e, -1);
  }
  // The store's own currency always has a line, so "nothing was paid" is said rather than left blank.
  line(storeCurrency);
  const missing: KeptLine["missing"] = [];
  if (!readings.sales.complete || holdsUnread(readings.sales.entries, from, false)) missing.push("sales");
  if (readings.renewals && (!readings.renewals.complete || holdsUnread(readings.renewals.entries, from, true))) missing.push("renewals");
  if (!readings.refunds?.complete || holdsUnread(readings.refunds.entries, from, true)) missing.push("refunds");
  if (!readings.disputes?.complete || holdsUnread(readings.disputes.entries, from, true)) missing.push("disputes");
  const lines = [...by.values()].map((row) => ({
    ...row,
    missing,
    keptCents: missing.length ? null : row.salesCents + row.renewalCents - row.refundCents - row.disputeCents,
  }));
  lines.sort((a, b) => Number(b.currency === storeCurrency) - Number(a.currency === storeCurrency) || a.currency.localeCompare(b.currency));
  if (missing.length) return { lines, byChannel: null, unattributed: null };
  const byChannel = [...channels.entries()]
    .map(([source, keptCents]) => ({ source, keptCents }))
    .filter((row) => row.keptCents !== 0)
    .sort((a, b) => b.keptCents - a.keptCents || a.source.localeCompare(b.source));
  return {
    lines,
    byChannel,
    unattributed: { direct: channels.get("direct") ?? 0, unrecorded: channels.get(UNPLACED) ?? 0 },
  };
}

/** Every window at once. */
export function keptByCurrency(readings: Readings, today: string, storeCurrency: string): Record<Window, KeptWindow> {
  const starts = windowStarts(today);
  return { d7: keptIn(readings, starts.d7, storeCurrency), d30: keptIn(readings, starts.d30, storeCurrency), d90: keptIn(readings, starts.d90, storeCurrency) };
}

/** What a missing reading is called on the page. */
export const MISSING_WORDS: Record<KeptLine["missing"][number], string> = {
  sales: "not every purchase could be read",
  renewals: "not every renewal could be read",
  refunds: "refunds could not all be read",
  disputes: "disputes could not all be read",
};
