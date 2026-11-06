/**
 * A creator disputing a payment they made to us for their plan (queue item
 * 232 [CA1] unit 5). Pure: no store, no Stripe.
 *
 * Stripe leaves the subscription active and the invoice paid when a payment
 * is disputed, so nothing in the subscription says it. The daily job reads
 * the disputes on our own account (lib/plan-disputes.ts), finds the plan
 * invoice each one is about, and writes it on the store's record. From then:
 *
 *   - while the bank has not decided ("open"), what costs us to run stops,
 *     exactly as for an unpaid renewal (lib/plan-standing.ts, costsPaused);
 *   - decided for us ("won", or an inquiry closed without a chargeback):
 *     everything starts again;
 *   - decided for the creator ("lost" for us): the money went back, so the
 *     period that payment covered is unpaid and stays paused to its end.
 *     When the end could not be read, a year from the dispute, the longest
 *     period any plan has (unknown is never read as "no time").
 *
 * Nothing closes and nothing is deleted: the store's page, the studio,
 * exports and deletion stay open, as for an unpaid renewal.
 */

export type PlanDisputeStatus = "open" | "won" | "lost";

export type PlanDispute = {
  /** Stripe's dispute id (du_…). */
  id: string;
  status: PlanDisputeStatus;
  /** When the dispute was opened, in seconds. */
  at: number;
  /** The end of the period the disputed payment covered, in seconds. */
  coversUntil: number;
};

/** The most a store keeps; the oldest decided ones go first. */
export const PLAN_DISPUTES_KEPT = 10;
/** The most read back from a record, far above what withPlanDispute keeps. */
const PARSE_CAP = 100;
const YEAR = 366 * 24 * 60 * 60;
const DISPUTE_ID = /^du_[A-Za-z0-9]{1,200}$/;

/** Stripe's dispute statuses, read as what the bank decided. Unknown reads as open. */
export function disputeStatusOf(stripeStatus: unknown): PlanDisputeStatus {
  if (stripeStatus === "won" || stripeStatus === "warning_closed") return "won";
  if (stripeStatus === "lost") return "lost";
  return "open";
}

/** One kept dispute, or null when it is not one. */
export function parsePlanDispute(value: unknown): PlanDispute | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !DISPUTE_ID.test(raw.id)) return null;
  if (raw.status !== "open" && raw.status !== "won" && raw.status !== "lost") return null;
  if (!Number.isSafeInteger(raw.at) || (raw.at as number) <= 0) return null;
  const at = raw.at as number;
  const covers = Number.isSafeInteger(raw.coversUntil) && (raw.coversUntil as number) > 0 ? (raw.coversUntil as number) : at + YEAR;
  return { id: raw.id, status: raw.status, at, coversUntil: covers };
}

export function parsePlanDisputes(value: unknown): PlanDispute[] {
  if (!Array.isArray(value)) return [];
  const out: PlanDispute[] = [];
  for (const row of value) {
    const parsed = parsePlanDispute(row);
    if (parsed && !out.some((kept) => kept.id === parsed.id)) out.push(parsed);
  }
  // withPlanDispute trims spent ones; reading never drops one that still pauses.
  return out.slice(-PARSE_CAP);
}

/**
 * The list with `entry` written in: a known dispute still open takes its
 * new status, a decided one stays as decided (the date it was opened and the period it covered stay as first read); a
 * new one is added. Past the limit, decided ones that no longer pause
 * anything go first, never one that still pauses.
 */
export function withPlanDispute(list: PlanDispute[], entry: PlanDispute, nowSeconds: number): PlanDispute[] {
  // A decided dispute stays decided: a status Stripe adds later never reopens it.
  const next = list.map((kept) => (kept.id === entry.id && kept.status === "open" ? { ...kept, status: entry.status } : kept));
  if (!next.some((kept) => kept.id === entry.id)) next.push(entry);
  while (next.length > PLAN_DISPUTES_KEPT) {
    const spent = next.findIndex((kept) => !pauses(kept, nowSeconds));
    if (spent < 0) break;
    next.splice(spent, 1);
  }
  return next;
}

function pauses(dispute: PlanDispute, nowSeconds: number): boolean {
  if (dispute.status === "open") return true;
  return dispute.status === "lost" && nowSeconds < dispute.coversUntil;
}

/** Whether a dispute of a plan payment pauses what costs us to run, right now. */
export function planDisputed(store: { planDisputes?: PlanDispute[] }, nowSeconds = Date.now() / 1000): boolean {
  return (store.planDisputes ?? []).some((dispute) => pauses(dispute, nowSeconds));
}

/**
 * The end of the service period a paid invoice covered: the latest line
 * period end. 0 when none can be read (the caller then keeps a year).
 */
export function coveredUntil(invoice: Record<string, unknown> | null | undefined): number {
  const lines = (invoice?.lines as { data?: unknown } | undefined)?.data;
  let end = 0;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const period = (line as { period?: { end?: unknown } } | null)?.period;
      if (Number.isSafeInteger(period?.end) && (period!.end as number) > end) end = period!.end as number;
    }
  }
  return end;
}

/**
 * What the creator is told, in one place, so the studio and the Terms say
 * the same thing and say what the code does.
 */
export const DISPUTE_PAUSED_WORDS =
  "While your bank looks at it, your checkout takes no new orders, free copies or sign-ups, and emails to your list, AI drafts, lesson video, imports from other platforms, new connections to Zoom, Google Calendar and Meta with Meta's daily ad-spend read, and new uploads, your buyers' review photos included, are paused. New webhook endpoints cannot be added, and webhooks are not sent to your endpoints, not even later, except events from your Stripe account, which are sent once the dispute is settled, as far back as Stripe keeps them (30 days). Reading your store through your API keys, AI assistants included, waits too, and so does adding to it through them; removing labels, taking back access and removing webhook endpoints do not.";
export const DISPUTE_KEPT_WORDS =
  "Your store's page stays up, your buyers keep reaching what they already bought except lesson video, your studio stays open, and nothing is deleted.";
export const DISPUTE_OUTCOME_WORDS =
  "If the bank decides for us, everything starts again. If it decides for you, the payment went back to you, so the period it paid for stays paused until it ends.";
