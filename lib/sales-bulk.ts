/**
 * The purchase email again for several orders at once (767 [STN14], unit 4; lib/sales-bulk-rules.ts has the rules).
 *
 * - Counted before any is sent: the store's email figure is read exactly (allowanceUsedExact). A count that cannot
 *   be read, or fewer emails left than the orders chosen, sends nothing. Each email then still takes its own count
 *   inside resendPurchase (lib/email.ts), as one sent alone does, so a figure used up by something else meanwhile
 *   refuses the rest, and they are counted as "could not".
 * - Each order keeps the single resend's two limits (lib/resend-limits.ts), per sale and per store, by the same
 *   counters, so choosing many at once never sends more than choosing them one by one. They are essential limits
 *   (essentialLimitState): an email spends money, so a counter out of reach or answering in another shape sends
 *   nothing and is "not confirmed", never "too often" (SG2 17).
 * - Rule 24: only resendPurchase's exact "sent" is sent. An error, a strange answer or a limit is "could not";
 *   nothing is retried here, because an email whose send is not known may have gone.
 * One order at a time, in order: at most MAX_BULK_SALES Stripe reads and emails a request.
 */
import { resendPurchase, type ResendOutcome } from "@/lib/purchase-email";
import { type LimitState, essentialLimitState } from "@/lib/request-guard";
import { RESEND_PER_SALE_PER_DAY, RESEND_PER_STORE_PER_HOUR } from "@/lib/resend-limits";
import { BULK_SALES_REFUSALS, type CouldNot, type ResendTally, emailsLeftWords } from "@/lib/sales-bulk-rules";
import type { Store } from "@/lib/store";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";

export type BulkResendDeps = {
  /** What the store's email figure has used in its window, exactly; null when not known. */
  used: (store: Store) => Promise<number | null>;
  /** The store's email figure in its window. */
  figure: (store: Store) => number;
  /** One more on this counter: room, no room, or not known (essentialLimitState). */
  limit: (scope: string, who: string, limit: number, windowSeconds: number) => Promise<LimitState>;
  resend: (store: Store, reference: string) => Promise<ResendOutcome>;
};

const LIVE: BulkResendDeps = {
  used: (store) => allowanceUsedExact(store, "email"),
  figure: (store) => allowanceFor(store, "email"),
  limit: essentialLimitState,
  resend: resendPurchase,
};

export type BulkResendResult = { ok: true; tally: ResendTally } | { ok: false; error: "uncounted" | "emails"; message: string; left?: number };

const COULD_NOT: ReadonlySet<string> = new Set<CouldNot>(["unknown", "call", "refunded", "failed"]);

/** A counter's exact answer; anything but "within" or "exceeded", or an error, is not known. */
async function room(deps: BulkResendDeps, scope: string, who: string, limit: number, seconds: number): Promise<LimitState> {
  const state: unknown = await deps.limit(scope, who, limit, seconds).catch(() => "unknown");
  return state === "within" || state === "exceeded" ? state : "unknown";
}

export async function bulkResend(store: Store, asked: { references: string[]; skipped: number }, deps: BulkResendDeps = LIVE): Promise<BulkResendResult> {
  const { references, skipped } = asked;
  if (references.length) {
    const used = await deps.used(store).catch(() => null);
    if (used === null || !Number.isSafeInteger(used) || used < 0) return { ok: false, error: "uncounted", message: BULK_SALES_REFUSALS.uncounted };
    const left = Math.max(0, deps.figure(store) - used);
    if (left < references.length) return { ok: false, error: "emails", left, message: emailsLeftWords(left, references.length) };
  }
  const tally: ResendTally = { asked: references.length + skipped, sent: [], couldNot: [], skipped };
  for (const reference of references) {
    // The single resend's order: the sale's count first, then the store's (app/api/store/resend/route.ts).
    const saleRoom = await room(deps, "resend-sale", reference, RESEND_PER_SALE_PER_DAY, 24 * 60 * 60);
    const counted = saleRoom === "within" ? await room(deps, "resend-store", store.sid || store.handle, RESEND_PER_STORE_PER_HOUR, 60 * 60) : saleRoom;
    if (counted !== "within") {
      tally.couldNot.push({ reference, why: counted === "exceeded" ? "limited" : "failed" });
      continue;
    }
    let outcome: unknown;
    try {
      outcome = await deps.resend(store, reference);
    } catch (error) {
      console.error("sending a purchase email again, in bulk, failed", error);
      outcome = "failed";
    }
    if (outcome === "sent") tally.sent.push(reference);
    else tally.couldNot.push({ reference, why: typeof outcome === "string" && COULD_NOT.has(outcome) ? (outcome as CouldNot) : "failed" });
  }
  return { ok: true, tally };
}
