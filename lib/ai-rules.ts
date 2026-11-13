/**
 * The writing help in the studio, as rules the browser can read too: what it
 * writes, how much of it a store gets each month, and what it will never do.
 * The part that talks to the model is lib/ai.ts, which only the server loads.
 *
 * Measured before it was built (30 September 2026): Circle (AI writer,
 * course builder), Mighty Networks (Instant Course Outline, "Make It
 * Better"), Kajabi (Cofounder AI, 500 to 1,000 AI credits on its $199 and
 * $399 plans), Teachable (Course Starter, drafts the sales page), Thinkific
 * (outline, landing page and email copy) and Beacons all write for a
 * creator. Stan's Stanley answers questions about Stan. Here it is on the
 * $29 plan, for the things a creator most often stares at a blank box over:
 * a product's description, its whole sales page (added 7 October 2026), a
 * course's outline, and an email.
 *
 * What it never does, because a page written for somebody else to sell with
 * has to be something they can stand behind:
 *
 *   - invent a testimonial, a review, a number of students, sales or
 *     earnings, a result, a guarantee, a bonus, a discount, a deadline or a
 *     limit on how many are left;
 *   - publish anything. It fills the boxes in the studio, the creator reads
 *     and changes them, and nothing is saved until they press Save.
 */

import { PDF_READ_MICRO_USD, WRITING_JOB_MICRO_USD } from "@/lib/spend-cost-table";
import { PLAN_TITLES } from "@/lib/plan";

export type AiKind = "product" | "page" | "outline" | "email" | "review" | "block";

/**
 * Writing jobs a store may ask for in a window (lib/allowance-window.ts: a billing month when the store pays), by where it stands
 * with its plan. Lowered on October 17, 2026 to what each plan's 60%
 * after-tax floor leaves room for once every other allowance is used in full
 * (tests/spend-floor.test.ts shows the sum): Store, which has no room left,
 * and the free trial, whose cost has no approved funded-exposure review yet,
 * have none. The money behind them is a monthly ceiling worked out from these
 * counts and the supplier rates (lib/ai-spend-policy.ts, lib/spend-cost-table.ts).
 */
export const AI_MONTHLY = { trial: 0, creator: 0, pro: 40, scale: 80 } as const;

/** The plans whose price includes the writing help, as public copy names them. */
export const AI_PLANS_WORDS = `${PLAN_TITLES.pro} and ${PLAN_TITLES.scale}`;

/** The allowance as every public page states it, from the same numbers admission uses. */
export function aiAllowanceWords(): string {
  return `${AI_MONTHLY.pro} writing jobs a month on ${PLAN_TITLES.pro} and ${AI_MONTHLY.scale} on ${PLAN_TITLES.scale}; not included on ${PLAN_TITLES.creator} or during the free trial. Each request sets aside the most it could cost from the plan's monthly AI budget before it runs. So long ones, like a whole sales page or reading a PDF, use more of it, and the budget can run out before the jobs do. An attempt that fails still counts.`;
}
/** And in any one minute, so a stuck button cannot spend the month. */
export const AI_PER_MINUTE = 6;

/** The most a creator types into the studio's help box (lib/help-ask.ts). */
export const MAX_HELP_QUESTION = 400;

/** The most a creator types into the box that tells it what to write. */
export const MAX_AI_NOTES = 1_500;

/** What a product is, as the writer is told it, so it never has to guess how it is delivered. */
export type ProductKind = "download" | "link" | "course" | "membership" | "call" | "bundle";

export type EmailGoal = "announce" | "nurture" | "offer" | "update";

export const EMAIL_GOALS: { id: EmailGoal; label: string }[] = [
  { id: "announce", label: "Announce a product" },
  { id: "offer", label: "Remind people about a product" },
  { id: "nurture", label: "Teach something useful" },
  { id: "update", label: "Share news" },
];

/** The course outline the writer proposes: at most this many modules, and lessons in each. */
export const MAX_AI_MODULES = 8;
export const MAX_AI_LESSONS = 8;

/**
 * A sales page drafted from the product's own PDF too (lib/ai.ts,
 * readPdfFacts): its first pages are read, at most this many, and the reading
 * takes this many of the month's jobs on top of the page's own one. A PDF's
 * text is not bounded by its size, so its reading is reserved at the model's
 * whole context window; the jobs it takes are that reservation in priced jobs,
 * rounded up (lib/spend-cost-table.ts).
 */
export const READ_PDF_PAGES = 10;
export const READ_PDF_JOBS = Math.ceil(PDF_READ_MICRO_USD / WRITING_JOB_MICRO_USD);
