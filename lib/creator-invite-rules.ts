/**
 * The terms of inviting another creator to Marktmorgen, in one place.
 *
 * Read by the job that adds the credit, by the studio page that shows it, by
 * the invite page a new creator lands on, and by the public pages and the
 * Terms. Nothing here reads a secret or talks to anything, so a client
 * component and a marketing page can import the real numbers rather than
 * retyping them.
 *
 * Measured before it was built (30 September 2026), what the others pay a
 * creator who brings them another creator:
 *
 *   - Stan: 20% of each payment, for as long as that creator stays
 *     subscribed, paid in cash; its help center names nothing for the new
 *     creator.
 *   - Skool: 40% of the subscription, in cash, held 14 days.
 *   - Beacons: 25% of the monthly profit, and the new creator gets $20 of
 *     credit.
 *   - Circle: $100 and up to 20% recurring. Kajabi: tiered, up to 20%.
 *     Gumroad: nothing.
 *
 * Here it is half of every payment, for as long as they pay, and the new
 * creator gets a whole month of the plan back after their first payment. It
 * is paid as credit on the inviting creator's own Marktmorgen plan, and that
 * is said everywhere it is offered: two creators who stay pay for the plan of
 * whoever brought them, and credit beyond that stays on the account for the
 * months after. It is credit rather than cash because credit is what reaches
 * a creator in any country, the same day, with no payout account to set up —
 * and a program is only offered in the form it is actually paid.
 */
import { PLAN_PRICES, REFUND_DAYS } from "@/lib/plan";

/** Of every payment an invited creator makes to us, the share credited to whoever invited them. */
export const INVITE_SHARE_PERCENT = 50;

/** The credit an invited creator gets after their first payment: one month of the plan, in cents. */
export const INVITE_BONUS_CENTS = PLAN_PRICES.creator.month;

/**
 * The cards' usual window for a dispute, in days: the owner's decision of 19 November 2026 on #4514 (part (b)) holds
 * every invite credit, and the invited creator's bonus, this long after the payment it is earned on.
 */
export const INVITE_DISPUTE_WINDOW_DAYS = 120;

/**
 * Days after a payment before its credit is added.
 *
 * The cards' dispute window (INVITE_DISPUTE_WINDOW_DAYS), and never less than our Refund Policy's full-refund window
 * and a week: a refund asked for on the last day of it is made before anything has been credited on the back of a
 * payment that is given back. Written as the larger of the two rather than as a number, so that lengthening the refund
 * window cannot quietly start paying credit on refundable payments, which is exactly what happened the day the window
 * went from fourteen days to thirty and this said 21. A payment taken back by a dispute decided even later than this
 * is handled by lib/creator-invite-clawback.ts.
 */
export const INVITE_HOLD_DAYS = Math.max(INVITE_DISPUTE_WINDOW_DAYS, REFUND_DAYS + 7);

/** How long an accepted invite waits for its creator to make their store. */
export const INVITE_COOKIE_DAYS = 60;

/** New offers are paused until a fully funded replacement is reviewed. */
export const INVITE_PROGRAM_OPEN = false;
export const INVITE_PAUSE_NOTICE = "New creator invitations are paused. Existing invitation credits and recorded referral terms are preserved.";
/** Old cookies contain only a code, not an acceptance timestamp. Allow the full
 * original 60-day lifetime after the final possible pre-pause issue date.
 * Deploy this pause before 17 October 2026 UTC. No cookie is renewed by the pause.
 */
export const LEGACY_INVITE_RECORDING_UNTIL = Date.UTC(2026, 11, 16);
export function mayRecordAcceptedInvite(now = Date.now()): boolean {
  return Number.isFinite(now) && now >= 0 && (INVITE_PROGRAM_OPEN || now < LEGACY_INVITE_RECORDING_UNTIL);
}

export const INVITE_COOKIE = "nl_invite";

/** Eight letters and digits, lower case, with nothing that reads as something else. */
export const INVITE_CODE_PATTERN = /^[a-hj-km-np-z2-9]{8}$/;
export const INVITE_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Terms are captured when an invite is recorded, never recalculated from a later offer. */
export type InviteTerms = { version: 1; sharePercent: number; bonusCents: number };

export function currentInviteTerms(): InviteTerms {
  return { version: 1, sharePercent: INVITE_SHARE_PERCENT, bonusCents: INVITE_BONUS_CENTS };
}

/** Missing terms identify the original offer. Invalid snapshots must not become that offer. */
export function readInviteTerms(raw: unknown): InviteTerms | null {
  if (raw === undefined) return { version: 1, sharePercent: 50, bonusCents: 2900 };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Partial<InviteTerms>;
  if (t.version !== 1 || !Number.isInteger(t.sharePercent) || t.sharePercent! < 0 || t.sharePercent! > 100 ||
      !Number.isSafeInteger(t.bonusCents) || t.bonusCents! < 0 || t.bonusCents! > 1_000_000) return null;
  return { version: 1, sharePercent: t.sharePercent!, bonusCents: t.bonusCents! };
}

/** The share of one payment, in cents, rounded down. */
export function inviteShare(paidCents: number, terms: InviteTerms = currentInviteTerms()): number {
  if (!Number.isSafeInteger(paidCents) || paidCents <= 0 || !readInviteTerms(terms)) return 0;
  return Math.floor((paidCents * terms.sharePercent) / 100);
}

/** Where an invite link leads. */
export function invitePath(code: string): string {
  return `/invite/${code}`;
}
