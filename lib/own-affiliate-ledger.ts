/**
 * The balance of one affiliate of Marktmorgen's own programme (220 [HL1],
 * unit 4), from what was recorded about them. Pure: it reads nothing, writes
 * nothing, pays nothing, and the programme is off (OWN_AFFILIATES_ON).
 *
 * - "earned": the commission one plan payment owes (ownCommission), held until
 *   its due time (the payment's money-back days over), then payable;
 * - "lowered": that payment was partly refunded, so its commission is now the
 *   smaller amount ownCommission gives on what the customer kept; the lowest
 *   recorded stands, and one above what was earned is unknown;
 * - "reversed": that payment was wholly refunded or disputed, so its
 *   commission is gone, whether it was read before or after the commission;
 * - "paid": a payout sent to the affiliate, once by its id.
 *
 * Whatever was paid beyond what is due now is a debt (a commission paid and
 * then lowered or reversed, or a payout sent before its commission was due):
 * never charged to the affiliate, only taken from the next commissions as they
 * fall due. A debt no
 * later commission pays is a cost of the programme; docs/marktmorgen-affiliates.md
 * names it as unknown, never zero. A commission or a payout recorded twice
 * counts once; twice with two amounts (or two due times) is unknown. Anything unreadable is unknown,
 * never zero and never payable (rule 24). Client-safe.
 */

export type LedgerEntry =
  | { kind: "earned"; paymentId: string; cents: number; dueAt: number }
  | { kind: "lowered"; paymentId: string; cents: number }
  | { kind: "reversed"; paymentId: string }
  | { kind: "paid"; payoutId: string; cents: number };

export type AffiliateBalance = { payableCents: number; heldCents: number; debtCents: number } | "unknown";

const wholeCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const paymentId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255;

/** One affiliate's balance at `now` (seconds). */
export function affiliateBalance(entries: readonly LedgerEntry[] | "unknown", now: number): AffiliateBalance {
  if (entries === "unknown" || !Array.isArray(entries) || !Number.isFinite(now)) return "unknown";
  const earned = new Map<string, { cents: number; dueAt: number }>();
  const reversed = new Set<string>();
  const lowered = new Map<string, number>();
  const payouts = new Map<string, number>();
  for (const entry of entries as readonly unknown[]) {
    if (!entry || typeof entry !== "object") return "unknown";
    const e = entry as Record<string, unknown>;
    if (e.kind === "earned") {
      if (!paymentId(e.paymentId) || !wholeCents(e.cents) || typeof e.dueAt !== "number" || !Number.isFinite(e.dueAt)) return "unknown";
      const before = earned.get(e.paymentId);
      if (before && (before.cents !== e.cents || before.dueAt !== e.dueAt)) return "unknown";
      earned.set(e.paymentId, { cents: e.cents, dueAt: e.dueAt });
    } else if (e.kind === "lowered") {
      if (!paymentId(e.paymentId) || !wholeCents(e.cents)) return "unknown";
      lowered.set(e.paymentId, Math.min(e.cents, lowered.get(e.paymentId) ?? e.cents));
    } else if (e.kind === "reversed") {
      if (!paymentId(e.paymentId)) return "unknown";
      reversed.add(e.paymentId);
    } else if (e.kind === "paid") {
      if (!paymentId(e.payoutId) || !wholeCents(e.cents)) return "unknown";
      const before = payouts.get(e.payoutId);
      if (before !== undefined && before !== e.cents) return "unknown";
      payouts.set(e.payoutId, e.cents);
    } else {
      return "unknown";
    }
  }
  let due = 0;
  let held = 0;
  let paid = 0;
  for (const cents of payouts.values()) paid += cents;
  for (const [id, low] of lowered) {
    const was = earned.get(id);
    if (was && low > was.cents) return "unknown";
  }
  for (const [id, { cents: earnedCents, dueAt }] of earned) {
    if (reversed.has(id)) continue;
    const cents = lowered.get(id) ?? earnedCents;
    if (dueAt <= now) due += cents;
    else held += cents;
  }
  if (!Number.isSafeInteger(due) || !Number.isSafeInteger(held) || !Number.isSafeInteger(paid)) return "unknown";
  const net = due - paid;
  return { payableCents: Math.max(0, net), heldCents: held, debtCents: Math.max(0, -net) };
}
