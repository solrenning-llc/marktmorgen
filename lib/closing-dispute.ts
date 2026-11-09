/**
 * Whether a closing may give back a charge Stripe marks `disputed`, read
 * from that charge's own disputes (lib/closing-refunds.ts, a member's unused
 * time; lib/closing-plan-guard.ts, a plan paid for a closing store). Pure:
 * the callers ask Stripe, on their own account and budget, for
 * disputesQuery(); this reads the reply.
 *
 * `charge.disputed` stays true once a charge has had any dispute, also after
 * the merchant won it (`won`) or an inquiry was closed without becoming a
 * chargeback (`warning_closed`): the money then stayed with the merchant, so
 * what the closing owes is owed as on a charge never disputed. Every other
 * status Stripe gives holds it: the open stages (the inquiry's warning_*,
 * the chargeback's needs_response and under_review, and the appeal stages),
 * `lost`, `prevented` (either a resolution refunded to the buyer or a block
 * where the merchant keeps the money; not told apart here, so it is never
 * given back on that guess) and the legacy `charge_refunded`. The same
 * pairing as lib/plan-refund-rules.ts (SETTLED: won, warning_closed) and the
 * status table of lib/dispute-statuses.ts on #3323 (stripe-node 23.1.0
 * Dispute.Status, with the appeal stages).
 *
 * Read exactly (CX-123 rule 24), with the list reader every Stripe list here
 * uses (lib/stripe-list.ts, readStripePage): a reply that is not a whole
 * list, more than one page, none listed although the charge says disputed,
 * or a row that is not a dispute of this very charge with a status Stripe
 * gives throws. The caller then gives nothing back and tries again on its
 * next run: a refund on a guess could give the money back a second time,
 * after the bank already did.
 */
import { StripeListUnreadable, ownField, readStripePage } from "@/lib/stripe-list";

/** Stripe's dispute ids (du_, and dp_ on older accounts). */
const DISPUTE_ID = /^(du|dp)_[A-Za-z0-9]{6,255}$/;

/** Closed with the money left with the merchant: the closing gives back as on a charge never disputed. */
const KEPT: ReadonlySet<string> = new Set(["won", "warning_closed"]);
/** Every other status Stripe gives a dispute: open, under appeal, or the money gone back or possibly gone back. */
const HELD: ReadonlySet<string> = new Set([
  "warning_needs_response",
  "warning_under_review",
  "needs_response",
  "under_review",
  "appeal_needs_response",
  "appeal_under_review",
  "lost",
  "prevented",
  "charge_refunded",
]);

/** The query for one charge's disputes: a charge has one or two (an inquiry, then a chargeback); ten is one page. */
export function disputesQuery(charge: string): string {
  return `/disputes?${new URLSearchParams({ charge, limit: "10" })}`;
}

const idOf = (value: unknown): string => (typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : "");

/**
 * "kept" when every dispute of `charge` was closed with the money left with the merchant; "held" when any one is open,
 * under appeal, lost, prevented or charge_refunded. Throws StripeListUnreadable for anything else (the header says why).
 */
export function chargeDisputes(page: unknown, charge: string): "kept" | "held" {
  const legible = (row: Record<string, unknown>) => {
    const status = ownField(row, "status");
    return ownField(row, "object") === "dispute" && idOf(ownField(row, "charge")) === charge && typeof status === "string" && (KEPT.has(status) || HELD.has(status));
  };
  const read = readStripePage(page, legible, DISPUTE_ID);
  if (read.unreadable > 0) throw new StripeListUnreadable(`${read.unreadable} disputes of ${charge} could not be read`);
  if (read.hasMore) throw new StripeListUnreadable(`the disputes of ${charge} were not read to their end`);
  if (!read.rows.length) throw new StripeListUnreadable(`${charge} is marked disputed and no dispute of it was listed`);
  return read.rows.every((row) => KEPT.has(row.status as string)) ? "kept" : "held";
}
