/**
 * The budget for a person's own data rights, deleting what a store keeps
 * about them or a copy of it (owner's decision 9, 9 November 2026: "Cópia e
 * apagamento a pedido da pessoa: orçamento próprio aprovado, pago pelo plano
 * nas lojas pagantes e pela empresa no resto. É dever legal.").
 *
 * Never the store's studio figure, and never refused for want of room: what a
 * month cannot pay for is scheduled and done by itself within the month the
 * law gives (GDPR art. 12(3), "within one month of receipt of the request";
 * docs/official-texts-eu-2026-11-02.md; app/privacy/page.tsx says "typically
 * one month under the GDPR").
 *
 *   - A paying store's plan carries RIGHTS_PLAN_UNITS a UTC month
 *     (tests/plan-cost-registry.ts, line data-rights).
 *   - Every other store (a trial, no plan, a plan that ended) is the
 *     company's: at most RIGHTS_FREE_STORE_UNITS a store a month, from the
 *     company's RIGHTS_COMPANY_UNITS a month (RIGHTS_COMPANY_COST there).
 *   - A deletion larger than the store's whole month (its plan's budget, or
 *     its share of the company's) could never be paid from it: the company's
 *     budget pays for it at once, rather than make the person wait for it.
 *   - One person may draw a store's budget RIGHTS_PERSON_REQUESTS times a
 *     month; past that, theirs waits for the next month like the rest.
 *   - What waits is done when the next UTC month opens (always before the
 *     deadline: the first of the next month comes before the same day of
 *     it), from that month's budget; RIGHTS_DEADLINE_MARGIN_MS before the
 *     deadline, from the company's; and, when even that is used up, it is
 *     still done before the deadline and counted past the cap (a legal duty),
 *     said in the log, never hidden (lib/rights-queue.ts).
 *
 * A unit is the studio's (lib/erasure-rules.ts, UNIT_COMMANDS and UNIT_BYTES),
 * priced as tests/plan-cost-registry.ts prices a studio unit, so the work the
 * erasure already counts (erasureUnits) is what it takes here.
 */
import type { Tier } from "@/lib/plan";

/** A paying store's rights budget, in units, for a UTC month: its plan pays for it. */
export const RIGHTS_PLAN_UNITS: Record<Tier, number> = { creator: 300, pro: 2_000, scale: 5_000 };
/** The most of the company's budget one store that pays nothing may take in a UTC month. */
export const RIGHTS_FREE_STORE_UNITS = 1_000;
/** The company's rights budget for a UTC month, for stores that pay nothing and for what is near its deadline. */
export const RIGHTS_COMPANY_UNITS = 100_000;
/** How many times one person may draw one store's rights budget in a UTC month. */
export const RIGHTS_PERSON_REQUESTS = 3;
/** How long before the legal deadline what waits is paid for by the company's budget. */
export const RIGHTS_DEADLINE_MARGIN_MS = 3 * 86_400_000;
/** What scheduling one deletion counts in the company's budget: its record, its place in the queue, the fingerprint. */
export const RIGHTS_SCHEDULE_UNITS = 1;
/** How long a scheduled deletion's record is kept at the most, done or not: past the deadline, with room to finish. */
export const RIGHTS_ITEM_SECONDS = 92 * 86_400;
/** How many scheduled deletions one run of the hourly job takes on. */
export const RIGHTS_RUN_ITEMS = 25;
/** How many times a scheduled deletion may be done past the company's cap, so a failing one cannot run up the bill. */
export const RIGHTS_FORCED_TRIES = 2;

/** The UTC month a moment is in, "2026-11": the window every rights budget is counted in. */
export function rightsMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** When the UTC month after the one `now` is in begins, in ms. */
export function nextRightsMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * One month after a request (GDPR art. 12(3)), read on the early side: the same date and time of the next month, or
 * the last day of that month at that time when it has no such date, never the end of that day. Never before
 * nextRightsMonth(at); what waits is looked at by rightsDue, which also keeps RIGHTS_DEADLINE_MARGIN_MS before it.
 */
export function legalDeadline(at: number): number {
  const d = new Date(at);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).getUTCDate();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** When a scheduled deletion is next looked at: when the next month opens, or the company's margin before the deadline, whichever is first. */
export function rightsDue(at: number, deadline: number): number {
  return Math.min(nextRightsMonth(at), deadline - RIGHTS_DEADLINE_MARGIN_MS);
}

/** "December 9, 2026": a deadline as the person reads it, in UTC. */
export function rightsDateWords(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
