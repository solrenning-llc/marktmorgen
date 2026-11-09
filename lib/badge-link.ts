/**
 * Where the "Made with Marktmorgen" link at the foot of a store page leads
 * (14 [D11], the owner's complement of 8 November 2026).
 *
 * It carries the creator's invite code only while both locks are open: the
 * invite programme (INVITE_PROGRAM_OPEN) and sales (PLANS_ON_SALE), so a
 * visitor is never sent to a sign-up that does not work today. With either
 * closed, or with no valid code, it is the plain link to the home page it has
 * always been, and no code is read for it.
 *
 * The link holds the code and nothing else: no email, name or internal id.
 * The page writes nothing in the visitor's browser for it; the invite cookie
 * is born only on the invite page, by its own rules (app/invite/[code]/accept).
 * The reward, its hold and its checks stay exactly as lib/creator-invite-rules.ts
 * and lib/creator-invites.ts have them: this only says where the link goes.
 */
import { INVITE_CODE_PATTERN, INVITE_PROGRAM_OPEN, invitePath } from "@/lib/creator-invite-rules";
import { existingInviteCode } from "@/lib/creator-invites";
import { PLANS_ON_SALE } from "@/lib/opening";

/** The badge's link with no code: the home page, as it has always been. */
export const BADGE_HOME = "/";

/** Whether the badge's link may carry a code: the invite programme and sales, both open. */
export const INVITE_BADGE_LINK_ON: boolean = INVITE_PROGRAM_OPEN && PLANS_ON_SALE;

/** The badge's link: the invite page with the creator's code while the link is on and the code is valid, else the plain one. */
export function badgeHref(code: string | null, on: boolean = INVITE_BADGE_LINK_ON): string {
  return on && typeof code === "string" && INVITE_CODE_PATTERN.test(code) ? invitePath(code) : BADGE_HOME;
}

/**
 * The store's invite code for its badge, read only while the link is on (one
 * GET, priced on the front page in tests/traffic-cost.ts) and never made: a
 * store page must not write. Null when the link is off, when the store has no
 * code yet, or when the read did not answer in its exact shape; the badge then
 * links to the home page, and the page is never held up by it.
 */
export async function badgeInviteCode(sid: string, on: boolean = INVITE_BADGE_LINK_ON): Promise<string | null> {
  if (!on) return null;
  return existingInviteCode(sid).catch(() => null);
}
