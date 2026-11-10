/**
 * Bulk actions on the studio's sales list (767 [STN14], unit 4; Claude 4, 9 November 2026). Pure and browser-safe.
 *
 * Only actions that already exist one at a time, each kept as it is:
 *   - a label on or off the buyers' contacts: the contact-labels route (lib/bulk-labels.ts), with its review before
 *     anything is written and its exact undo. It starts no automation and sends nothing.
 *   - the purchase email again: resendPurchase (lib/purchase-email.ts), the same as the list's own button, counted
 *     before any is sent (lib/sales-bulk.ts). An email cannot be taken back, and the screen says so.
 *   - a file of the rows chosen, made in the browser from what the list shows: it changes nothing.
 * Nothing here moves money: no refund and no charge, which stay with the creator, one at a time, in Stripe.
 *
 * Rule 24 (CX-123): a row whose outcome is not known is counted as "could not", never as done; an answer whose counts
 * are not whole numbers is not a result (readLabelOutcome, readLabelReview: null).
 */
import { type BulkChange, type BulkReview, type Removed, count } from "@/lib/bulk-label-rules";
import { csvLine } from "@/lib/csv";
import { plainAmount } from "@/lib/money";

/**
 * The most orders one bulk request touches: a whole page of the studio's list (ORDERS_PAGE_SIZE, held equal by
 * tests/sales-bulk.test.ts). An internal bound on one request's work, the same on every plan, never a plan limit;
 * more is refused whole, never cut.
 */
export const MAX_BULK_SALES = 25;

/** A Checkout Session's id: the orders whose purchase email can be sent again (app/api/store/resend). */
export const SALE_REFERENCE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** What the bulk actions read of a sale (lib/store-checkout.ts Sale): no answers, no shipping address. */
export type BulkSaleRow = {
  reference: string;
  title: string;
  email: string | null;
  /** Seconds since the epoch. */
  paidAt: number;
  /** In the currency's smallest unit, as Stripe gives it. */
  amount: number;
  currency: string;
  isCall: boolean;
  isTip: boolean;
  trial: boolean;
};

/** Only the fields above, so the page hands nothing more to the browser. */
export function bulkRowOf(sale: BulkSaleRow): BulkSaleRow {
  const { reference, title, email, paidAt, amount, currency, isCall, isTip, trial } = sale;
  return { reference, title, email, paidAt, amount, currency, isCall, isTip, trial };
}

/** Whether the list offers to send this order's purchase email again (app/studio/page.tsx, ResendPurchase). */
export function canResend(row: BulkSaleRow): boolean {
  return !row.isCall && !row.isTip && Boolean(row.email) && SALE_REFERENCE.test(row.reference);
}

export type BulkSalesRefusal = "none" | "many" | "uncounted" | "emails" | "unknown";

/** What the studio says when a bulk request is refused before anything is done. Plain words, no plan talk. */
export const BULK_SALES_REFUSALS: Record<Exclude<BulkSalesRefusal, "emails">, string> = {
  none: "Choose at least one order first.",
  many: `You can act on up to ${MAX_BULK_SALES} orders at once. Choose fewer orders.`,
  uncounted: "Your store's emails could not be counted just now, so nothing was sent. Try again in a moment.",
  unknown: "That action is not one this list can do.",
};

/** When fewer emails are left than the orders chosen: how many are left, and what to do. Nothing is sent. */
export function emailsLeftWords(left: number, asked: number): string {
  return `Your store has ${count(left, "email", "emails")} left before its email count starts again, fewer than the ${asked.toLocaleString("en-US")} this would send. Choose ${count(left, "order", "orders")} or fewer, or wait until the count starts again.`;
}

export type ReferencesRead = { ok: true; references: string[]; skipped: number } | { ok: false; error: "none" | "many" };

/**
 * The orders a request names, each once. More than MAX_BULK_SALES entries is refused whole; an entry that is not an
 * order whose email can be sent again is counted in `skipped` (shown as "could not"), never sent and never dropped
 * without a word.
 */
export function readReferences(raw: unknown): ReferencesRead {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "none" };
  if (raw.length > MAX_BULK_SALES) return { ok: false, error: "many" };
  const references: string[] = [];
  let skipped = 0;
  for (const entry of raw) {
    if (typeof entry !== "string" || !SALE_REFERENCE.test(entry)) skipped += 1;
    else if (!references.includes(entry)) references.push(entry);
  }
  return { ok: true, references, skipped };
}

/** Why an order's email was not sent again. "failed" covers every answer that is not the exact "sent". */
export type CouldNot = "unknown" | "call" | "refunded" | "failed" | "limited";
export type ResendTally = { asked: number; sent: string[]; couldNot: { reference: string; why: CouldNot }[]; skipped: number };

const COULD_NOT_WORDS: Record<CouldNot | "skipped", string> = {
  unknown: "not found as a sale of this store",
  call: "a booked call, which has its own email",
  refunded: "refunded",
  failed: "not confirmed as sent",
  limited: "sent again too often today or this hour",
  skipped: "not an order whose email can be sent again",
};

/** What will happen, before it does: how many orders, how many people, and that it cannot be taken back. */
export function resendConfirmWords(orders: number, people: number): string {
  return `Send the purchase email again for ${count(orders, "order", "orders")}, to ${count(people, "person", "people")}. Each email goes only to the address the buyer paid with, and each one uses one of your store's emails. An email cannot be taken back once it is sent.`;
}

/** The file's confirmation: how many orders and buyers' addresses it holds, and that nothing changes. */
export function exportConfirmWords(orders: number, withEmail: number): string {
  return `Download a file of ${count(orders, "order", "orders")}, with the email addresses of ${count(withEmail, "buyer", "buyers")}. It holds people's details, so keep it safe. Nothing in your store changes.`;
}

/** Where an action cannot be taken back, the screen says so in these words instead of offering an undo. */
export const NO_UNDO = {
  resend: "An email cannot be taken back once it is sent, so this has no undo.",
  export: "A download changes nothing in your store, so there is nothing to undo.",
} as const;

/**
 * A label's confirmation, from the contact-labels review: how many contacts on the list change, why each other one
 * does not (already as asked, not on the list, the most labels, no email address on the order), and the undo.
 */
export function labelConfirmWords(label: string, change: BulkChange, review: BulkReview, noEmail: number): string {
  const head = change === "add" ? `Add the label "${label}" to ${count(review.changes, "contact", "contacts")} on your list.` : `Take the label "${label}" off ${count(review.changes, "contact", "contacts")} on your list.`;
  const left = [
    review.already ? `${review.already.toLocaleString("en-US")} already as asked` : "",
    review.notOnList ? `${review.notOnList.toLocaleString("en-US")} not on your list` : "",
    noEmail ? `${noEmail.toLocaleString("en-US")} with no email address` : "",
    review.full ? `${review.full.toLocaleString("en-US")} with the most labels a contact can have` : "",
  ].filter(Boolean);
  const rest = left.length ? ` Not changed: ${left.join(", ")}.` : "";
  const tail = review.changes ? " It sends no email and starts no automation. You can undo it right after." : " Nothing would change.";
  return `${head}${rest}${tail}`;
}

/** What was sent and, for each reason, how many could not be; always with the words that there is no undo. */
export function resendResultWords(tally: ResendTally): { short: string; words: string } {
  const could = tally.couldNot.length + tally.skipped;
  const short = `Sent ${count(tally.sent.length, "email", "emails")}.${could ? ` ${count(could, "order", "orders")} could not be sent.` : ""}`;
  const by = new Map<CouldNot | "skipped", number>();
  for (const { why } of tally.couldNot) by.set(why, (by.get(why) ?? 0) + 1);
  if (tally.skipped) by.set("skipped", tally.skipped);
  const reasons = [...by.entries()].map(([why, n]) => `${n.toLocaleString("en-US")} ${COULD_NOT_WORDS[why]}`);
  return { short, words: `${short}${reasons.length ? ` Not sent: ${reasons.join(", ")}.` : ""} ${NO_UNDO.resend}` };
}

const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** An optional count: absent is none (the route leaves it out when nothing failed); present, it must be whole. */
const optional = (value: unknown): number | null => (value === undefined ? 0 : whole(value) ? value : null);

/** A contact-labels review, read exactly: null for any count that is not a whole number (rule 24). */
export function readLabelReview(raw: unknown): BulkReview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!whole(r.changes) || !whole(r.already) || !whole(r.notOnList) || !whole(r.full) || !whole(r.skipped)) return null;
  const replaced = optional(r.replaced);
  if (replaced === null) return null;
  return { changes: r.changes, already: r.already, notOnList: r.notOnList, full: r.full, skipped: r.skipped, ...(r.replaced !== undefined ? { replaced } : {}) };
}

export type Taken = Removed & { email: string; forms?: number; cleaned?: true };
export type LabelOutcome = { changed: string[]; taken: Taken[]; already: number; full: number; notOnList: number; noRoom: number; failed: number };

/**
 * A contact-labels apply answer, read exactly: the addresses changed, what each lost or had replaced (sent back by
 * the undo) and every count. Null when any of it is not in its shape: the screen then says the result is not known,
 * never "0 changed", and offers no undo built on a guess.
 */
export function readLabelOutcome(raw: unknown, change: BulkChange): LabelOutcome | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (!Array.isArray(a.changed) || !a.changed.every((e) => typeof e === "string")) return null;
  if (!whole(a.already) || !whole(a.full) || !whole(a.notOnList)) return null;
  const noRoom = optional(a.noRoom);
  const failed = optional(a.failed);
  if (noRoom === null || failed === null) return null;
  // The route always sends both lists. An undo puts back what each contact lost, so a removal says it for every
  // address it changed, and an add only for addresses it changed; left out, short or naming another address, the
  // answer is not in its shape and no undo is built on a guess (Codex H2, LOW on #3543).
  const rawTaken = change === "remove" ? a.removed : a.replaced;
  if (!Array.isArray(rawTaken)) return null;
  const changed = new Set(a.changed as string[]);
  const named = new Set<string>();
  const taken: Taken[] = [];
  for (const entry of rawTaken as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.email !== "string" || typeof e.label !== "string" || !whole(e.at)) return null;
    if (!changed.has(e.email) || named.has(e.email)) return null;
    named.add(e.email);
    taken.push(entry as Taken);
  }
  if (change === "remove" && named.size !== changed.size) return null;
  return { changed: a.changed as string[], taken, already: a.already, full: a.full, notOnList: a.notOnList, noRoom, failed };
}

const KIND: (row: BulkSaleRow) => string = (row) => (row.trial ? "trial" : row.isTip ? "support" : row.isCall ? "call" : "product");

/**
 * The rows chosen as CSV, with the sales file's own column names (lib/stats.ts salesCsv) for what the list shows.
 * Every cell goes through the shared writer, so a title that starts like a formula stays text; an amount that is not
 * whole cents, or a currency that is not three letters, is left blank, never written as 0.00.
 */
export function selectedSalesCsv(rows: readonly BulkSaleRow[]): string {
  const lines = [csvLine(["paid_at_utc", "stripe_id", "product", "kind", "amount", "currency", "buyer_email"])];
  for (const row of rows) {
    const known = Number.isSafeInteger(row.amount) && row.amount >= 0 && /^[a-z]{3}$/i.test(row.currency);
    const at = Number.isFinite(row.paidAt) ? new Date(row.paidAt * 1000) : null;
    lines.push(
      csvLine([
        at && Number.isFinite(at.getTime()) ? at.toISOString() : "",
        row.reference,
        row.title,
        KIND(row),
        known ? plainAmount(row.amount, row.currency) : "",
        /^[a-z]{3}$/i.test(row.currency) ? row.currency.toUpperCase() : "",
        row.email ?? "",
      ]),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
