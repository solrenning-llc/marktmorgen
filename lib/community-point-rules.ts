/**
 * Points for posts, comments and finished lessons (112 [E2-POINTS], unit 1):
 * the rules, as plain functions. No Redis, no secrets; the studio's page and
 * the leaderboard can import them. Keeping the points is the next unit
 * (lib/community-points.ts already keeps the ones a like makes); until then
 * nothing calls this, and a like is still the only way to make a point.
 *
 * Why: today a member's only way up the board is likes on what they wrote
 * (lib/community-points.ts, measured against Skool and Circle on 30 September
 * 2026). A member who finishes a course or answers questions makes nothing
 * for it. The owner's P4 list (E2) asks for points for posts, comments and
 * finished lessons; no competitor claim is made here. What a member can
 * check, and what cannot be farmed:
 *
 *   - Off by default. Each action makes the points the creator chose, from 0
 *     to MAX_ACTION_POINTS; a community that never opens the setting keeps
 *     exactly today's rule.
 *   - One award per fact (a post, a comment, a lesson of a product), keyed by
 *     factKey: posting, deleting and posting again, or marking a lesson
 *     finished twice, never makes points twice.
 *   - A daily cap per member on what these actions make (likes stay as they
 *     are), so a flood of short posts is not a way up the board.
 *   - The creator collects no points: the board is for members.
 *   - Taking back is exact: what was recorded with the fact, not today's
 *     rule, when a post or comment is removed or a course is refunded.
 *   - Unknown is never points: a count or a record that could not be read
 *     gives nothing and takes nothing, and says so.
 *   - Every rule is said on the leaderboard in plain words (pointRulesWords).
 */

export const POINT_ACTIONS = ["post", "comment", "lesson"] as const;
export type PointAction = (typeof POINT_ACTIONS)[number];

/** The most one post, comment or lesson can make. */
export const MAX_ACTION_POINTS = 5;
/** The highest daily cap a creator can choose. */
export const MAX_DAILY_POINTS = 50;
/** The daily cap until the creator picks one. */
export const DEFAULT_DAILY_CAP = 10;

export type PointRules = { post: number; comment: number; lesson: number; dailyCap: number };

export const NO_ACTION_POINTS: PointRules = Object.freeze({ post: 0, comment: 0, lesson: 0, dailyCap: DEFAULT_DAILY_CAP }) as PointRules;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PRODUCT = /^[a-z0-9]{6,40}$/;

const inRange = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

/** What was stored, made safe: a field out of bounds goes back to its own default, never to more. */
export function parsePointRules(raw: unknown): PointRules {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...NO_ACTION_POINTS };
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...NO_ACTION_POINTS };
  const v = value as Record<string, unknown>;
  const points = (x: unknown) => (inRange(x, 0, MAX_ACTION_POINTS) ? x : 0);
  return {
    post: points(v.post),
    comment: points(v.comment),
    lesson: points(v.lesson),
    dailyCap: inRange(v.dailyCap, 1, MAX_DAILY_POINTS) ? v.dailyCap : DEFAULT_DAILY_CAP,
  };
}

/** The studio's form: every field a whole number in bounds, or the whole form is refused. */
export function readPointRulesInput(raw: unknown): { ok: true; rules: PointRules } | { ok: false; why: "points" | "cap" } {
  if (!raw || typeof raw !== "object") return { ok: false, why: "points" };
  const v = raw as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === "string" && /^\d{1,3}$/.test(x) ? Number(x) : x);
  const [post, comment, lesson, dailyCap] = [num(v.post), num(v.comment), num(v.lesson), num(v.dailyCap)];
  if (![post, comment, lesson].every((x) => inRange(x, 0, MAX_ACTION_POINTS))) return { ok: false, why: "points" };
  if (!inRange(dailyCap, 1, MAX_DAILY_POINTS)) return { ok: false, why: "cap" };
  return { ok: true, rules: { post: post as number, comment: comment as number, lesson: lesson as number, dailyCap } };
}

/** The one key a fact is awarded under; null when an id is not one, and then nothing is awarded. */
export function factKey(action: PointAction, ids: { id: string; product?: string }): string | null {
  if (!ID.test(ids.id)) return null;
  if (action === "post") return `p:${ids.id}`;
  if (action === "comment") return `c:${ids.id}`;
  if (typeof ids.product !== "string" || !PRODUCT.test(ids.product)) return null;
  return `l:${ids.product}:${ids.id}`;
}

export type AwardWhy = "ok" | "partial" | "off" | "creator" | "repeat" | "cap" | "unknown";

/**
 * The points one fact makes now. `earnedToday` is what these actions already
 * made the member today, read exactly; `alreadyAwarded` whether the fact's key
 * is already recorded (null when that could not be read).
 */
export function pointsToAward(
  rules: unknown,
  ask: { action: PointAction; byCreator: boolean; earnedToday: number; alreadyAwarded: boolean | null },
): { give: number; why: AwardWhy } {
  const safe = parsePointRules(rules);
  const value = safe[ask.action];
  if (value === 0) return { give: 0, why: "off" };
  if (ask.byCreator) return { give: 0, why: "creator" };
  if (typeof ask.alreadyAwarded !== "boolean" || !inRange(ask.earnedToday, 0, Number.MAX_SAFE_INTEGER)) return { give: 0, why: "unknown" };
  if (ask.alreadyAwarded) return { give: 0, why: "repeat" };
  const left = safe.dailyCap - ask.earnedToday;
  if (left <= 0) return { give: 0, why: "cap" };
  return left >= value ? { give: value, why: "ok" } : { give: left, why: "partial" };
}

/** Why a fact may go: only these take its points back. */
const TAKEN_BACK_WHEN: Record<PointAction, readonly string[]> = {
  post: ["deleted", "removed"],
  comment: ["deleted", "removed"],
  // A lesson marked unfinished keeps its points: marking it again gives nothing, since a fact is awarded once.
  lesson: ["refunded"],
};

export function shouldTakeBack(action: PointAction, reason: string): boolean {
  return TAKEN_BACK_WHEN[action].includes(reason);
}

/**
 * What to take back for a fact: exactly what was recorded with it. `read` is
 * null when the record could not be read; { found: false } when it was read
 * and there is none.
 */
export function takeBack(read: { found: true; amount: unknown } | { found: false } | null): { take: number } | { take: null; why: "unknown" } {
  if (!read) return { take: null, why: "unknown" };
  if (!read.found) return { take: 0 };
  return inRange(read.amount, 0, MAX_ACTION_POINTS) ? { take: read.amount } : { take: null, why: "unknown" };
}

const pts = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

/** How points are made in this community, as the leaderboard says it. */
export function pointRulesWords(rules: unknown): string[] {
  const safe = parsePointRules(rules);
  const lines = ["A like on your post or comment from someone else: 1 point."];
  if (safe.post) lines.push(`A new post: ${pts(safe.post)}.`);
  if (safe.comment) lines.push(`A comment: ${pts(safe.comment)}.`);
  if (safe.lesson) lines.push(`A lesson you finish: ${pts(safe.lesson)}.`);
  if (safe.post || safe.comment || safe.lesson) lines.push(`Posts, comments and lessons give at most ${pts(safe.dailyCap)} a day.`);
  return lines;
}
