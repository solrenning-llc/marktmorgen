/**
 * The balance of one affiliate of Marktmorgen's own programme (220 [HL1],
 * unit 4), from what was recorded about them. Pure: it reads nothing, writes
 * nothing, pays nothing, and the programme is off (OWN_AFFILIATES_ON).
 *
 * - "earned": the commission one plan payment owes (ownCommission), held until
 *   its due time (the payment's money-back days over), then payable;
 * - "reversed": that payment was refunded or disputed, so its commission is
 *   gone, whether it was read before or after the commission;
 * - "paid": what was sent to the affiliate.
 *
 * One already paid and then reversed is a debt: never charged to the
 * affiliate, only taken from the next commissions as they fall due. A debt no
 * later commission pays is a cost of the programme; docs/marktmorgen-affiliates.md
 * names it as unknown, never zero. A payment recorded twice counts once; twice
 * with two amounts or two due times is unknown. Anything unreadable is unknown,
 * never zero and never payable (rule 24). Client-safe.
 */

export type LedgerEntry =
  | { kind: "earned"; paymentId: string; cents: number; dueAt: number }
  | { kind: "reversed"; paymentId: string }
  | { kind: "paid"; cents: number };

export type AffiliateBalance = { payableCents: number; heldCents: number; debtCents: number } | "unknown";

const wholeCents = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const paymentId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 255;

/** One affiliate's balance at `now` (seconds). */
export function affiliateBalance(entries: readonly LedgerEntry[] | "unknown", now: number): AffiliateBalance {
  if (entries === "unknown" || !Array.isArray(entries) || !Number.isFinite(now)) return "unknown";
  const earned = new Map<string, { cents: number; dueAt: number }>();
  const reversed = new Set<string>();
  let paid = 0;
  for (const entry of entries as readonly unknown[]) {
    if (!entry || typeof entry !== "object") return "unknown";
    const e = entry as Record<string, unknown>;
    if (e.kind === "earned") {
      if (!paymentId(e.paymentId) || !wholeCents(e.cents) || typeof e.dueAt !== "number" || !Number.isFinite(e.dueAt)) return "unknown";
      const before = earned.get(e.paymentId);
      if (before && (before.cents !== e.cents || before.dueAt !== e.dueAt)) return "unknown";
      earned.set(e.paymentId, { cents: e.cents, dueAt: e.dueAt });
    } else if (e.kind === "reversed") {
      if (!paymentId(e.paymentId)) return "unknown";
      reversed.add(e.paymentId);
    } else if (e.kind === "paid") {
      if (!wholeCents(e.cents)) return "unknown";
      paid += e.cents;
    } else {
      return "unknown";
    }
  }
  let due = 0;
  let held = 0;
  for (const [id, { cents, dueAt }] of earned) {
    if (reversed.has(id)) continue;
    if (dueAt <= now) due += cents;
    else held += cents;
  }
  if (!Number.isSafeInteger(due) || !Number.isSafeInteger(held) || !Number.isSafeInteger(paid)) return "unknown";
  const net = due - paid;
  return { payableCents: Math.max(0, net), heldCents: held, debtCents: Math.max(0, -net) };
}
