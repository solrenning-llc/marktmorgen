/**
 * 361 [AP1] (e): the reminder a member gets the day before their access ends,
 * as rules only (docs/ap1-autopilot-design.md). The end is what Stripe says on
 * the membership (lib/membership-manage.ts endsAtOf: cancel_at, or the period's
 * end when it is set to end then), read by the sender just before it sends.
 * The email names that real date: it never says "in 24 hours".
 *
 *   nl:ending:<statsId>:<subscription>:<end>   sent, so one end gets one reminder
 *
 * Off until the creator switches it on. Pure and browser-safe.
 */

/** How long before the end the reminder is due. */
export const ACCESS_ENDING_HOURS = 24;

/** The statuses under which a membership still gives access, as lib/membership-access.ts reads them, less past_due. */
const RUNNING = new Set(["active", "trialing"]);

/**
 * Whether the reminder is due now: the membership is running and its end (seconds, as Stripe gives it) is still
 * ahead and at most ACCESS_ENDING_HOURS away. No end, an end it cannot read, or an end already past: never.
 */
export function endingDue(member: { status: string; endsAt: number | null }, now: number): boolean {
  if (!RUNNING.has(member.status)) return false;
  const end = member.endsAt;
  if (typeof end !== "number" || !Number.isFinite(end) || end <= 0) return false;
  const left = end * 1000 - now;
  return left > 0 && left <= ACCESS_ENDING_HOURS * 3_600_000;
}

/** The mark that one end of one membership was reminded of. A moved end has its own. */
export function endingMark(statsId: string, subscription: string, endsAt: number): string {
  return `nl:ending:${statsId}:${subscription}:${endsAt}`;
}

/**
 * The creator's switch, with the postal address every email to a list must carry (as the come-back email's,
 * lib/member-health-rules.ts parseNudge): on only when it says true and an address is given; off by default.
 */
export type EndingSetting = { on: boolean; address: string };
export const NO_ENDING: EndingSetting = { on: false, address: "" };

export function parseEnding(raw: unknown): EndingSetting {
  const value = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const address = typeof value.address === "string" ? value.address.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return { on: value.on === true && address.length > 0, address };
}
