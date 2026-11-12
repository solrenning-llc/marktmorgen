/**
 * What the creator's own pitches did (501 [OX3]; added 12 November 2026):
 * by goal, how many were sent, answered and became a deal, and one next step
 * in plain words. Read only from the pitches the Outreach page already reads
 * (lib/outreach.ts listPitches): no read, write or call of its own.
 *
 *   - Only this store's own pitches, as the creator marked them: "sent" when
 *     they said they sent it; "replied" and "deal" are answers; "stopped" is
 *     a business that asked not to be written to again, said apart, never
 *     counted as an answer. Drafts are not sent.
 *   - Below MIN_SENT sent pitches there is not enough to learn from, and the
 *     page says so instead of a share or a tip; the same for each goal.
 *   - The next step only states what the creator's own numbers show: drafts
 *     not sent yet, or that one goal got answers more often than another, with
 *     both counts. No benchmark of other creators, no promise, no urgency.
 *   - No open tracking: answers are what the creator marked, never a pixel.
 */
import { OUTREACH_GOALS, type OutreachGoal, type PitchStatus } from "@/lib/outreach-rules";

/** The fewest sent pitches, overall and for a goal, before any share is shown. */
export const MIN_SENT = 5;

export type GoalRow = { goal: OutreachGoal; label: string; sent: number; answered: number; deals: number; stopped: number; enough: boolean };

export type OutreachResults =
  | { kind: "none" }
  | { kind: "few"; sent: number; drafts: number; next: string }
  | { kind: "rows"; sent: number; drafts: number; rows: GoalRow[]; next: string | null };

const n = (x: number) => x.toLocaleString("en-US");
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
const SENT: ReadonlySet<PitchStatus> = new Set(["sent", "replied", "deal", "stopped"]);
/** What each goal is called in a sentence: "sponsor pitches". */
const GOAL_WORDS: Record<OutreachGoal, string> = { sponsor: "sponsor", partner: "partner", business: "business" };

/** The creator's results from their own pitches; `none` when they have not written any. */
export function outreachResults(pitches: readonly { goal: OutreachGoal; status: PitchStatus }[]): OutreachResults {
  if (!pitches.length) return { kind: "none" };
  const drafts = pitches.filter((p) => p.status === "draft").length;
  const sentPitches = pitches.filter((p) => SENT.has(p.status));
  const sent = sentPitches.length;
  const draftsLine = drafts ? `You have ${plural(drafts, "draft", "drafts")} not sent yet.` : null;
  if (sent < MIN_SENT) {
    return {
      kind: "few",
      sent,
      drafts,
      next: [`Not enough data yet: ${plural(sent, "pitch", "pitches")} sent. Once you have sent ${n(MIN_SENT)}, this shows what got answers.`, draftsLine].filter(Boolean).join(" "),
    };
  }
  const rows: GoalRow[] = OUTREACH_GOALS.map(({ id, label }) => {
    const mine = sentPitches.filter((p) => p.goal === id);
    const answered = mine.filter((p) => p.status === "replied" || p.status === "deal").length;
    return { goal: id, label, sent: mine.length, answered, deals: mine.filter((p) => p.status === "deal").length, stopped: mine.filter((p) => p.status === "stopped").length, enough: mine.length >= MIN_SENT };
  }).filter((row) => row.sent > 0);

  // A goal is said to get answers more often only against another goal with enough sent, and only when strictly more often.
  const compared = rows.filter((r) => r.enough);
  let compare: string | null = null;
  if (compared.length >= 2) {
    const share = (r: GoalRow) => r.answered / r.sent;
    const sorted = [...compared].sort((a, b) => share(b) - share(a));
    const [best, second] = sorted;
    if (share(best) > share(second)) {
      compare = `Your ${GOAL_WORDS[best.goal]} pitches got answers more often (${n(best.answered)} of ${n(best.sent)}) than your ${GOAL_WORDS[second.goal]} pitches (${n(second.answered)} of ${n(second.sent)}). Your next pitches could be to ${best.goal === "business" ? "businesses that would buy" : `${GOAL_WORDS[best.goal]}s`}.`;
    }
  }
  const answeredAll = rows.reduce((sum, r) => sum + r.answered, 0);
  const none = answeredAll === 0 ? `None of the ${plural(sent, "pitch", "pitches")} you sent has an answer marked yet.` : null;
  const next = [compare ?? none, draftsLine].filter(Boolean).join(" ") || null;
  return { kind: "rows", sent, drafts, rows, next };
}
