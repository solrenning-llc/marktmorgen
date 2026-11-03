/**
 * Points, levels and the leaderboard of a community — and what a level opens.
 *
 * Measured before it was built (30 September 2026): Skool gives 1 point per
 * like, 9 levels, a leaderboard, and courses that unlock at a level, on every
 * plan. Circle gives 1 point per like, levels, leaderboards and content
 * unlocked for engaged members. Mighty Networks has points, streaks, badges
 * and leaderboards. Stan has none of it. So a community here has the same
 * rule people already understand — a like is a point — and three things the
 * others do not do together:
 *
 *   - a level can open a space for posting, and can hand over one of the
 *     creator's own paid courses, free, as a reward;
 *   - every member sees exactly how the points are made and what each level
 *     opens, on the leaderboard page, with nothing hidden in an algorithm;
 *   - a point cannot be given to yourself, and the creator's own likes count
 *     the same as anybody's — no weighting that members cannot see.
 *
 * How a point is made: every like a member's post or comment receives from
 * somebody else is one point to its author, and taking the like back takes
 * the point back. The creator collects no points: the board is for members.
 *
 * Kept, under the community's own id (no import of lib/community.ts, so the
 * course reader in lib/learn.ts can ask about rewards without a cycle):
 *
 *   nl:cm:<id>:pts            all-time points, by member key (sorted set)
 *   nl:cm:<id>:pts:d:<day>    points made on one UTC day (kept 32 days)
 *   nl:cm:<id>:rw             what each level opens: { level, product }[]
 *   nl:cm:<id>:unl:<member>   when each reward reached this member (hash)
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataOwner, orderWrite } from "@/lib/order-data";
import { LEVELS, MAX_LEVEL, MAX_REWARDS, type Reward, levelOf, parseRewards, toNextLevel } from "@/lib/community-levels";

export { LEVELS, MAX_LEVEL, MAX_REWARDS, type Reward, levelOf, parseRewards, toNextLevel };

/** How many days of daily points are kept: enough for the 30-day board. */
const DAYS_KEPT = 32;
export type Period = "7" | "30" | "all";
export const BOARD_SIZE = 50;

const MEMBER = /^[0-9a-f]{32}$/;
const COMMUNITY = /^[0-9a-f]{32}$/;

const allKey = (id: string) => `nl:cm:${id}:pts`;
const dayKey = (id: string, day: number) => `nl:cm:${id}:pts:d:${day}`;
const rewardsKey = (id: string) => `nl:cm:${id}:rw`;
const unlockedKey = (id: string, member: string) => `nl:cm:${id}:unl:${member}`;
const boardKey = (id: string, period: string) => `nl:cm:${id}:pts:b:${period}`;
const membersKey = (id: string) => `nl:cm:${id}:m`;

const dayOf = (ms: number) => Math.floor(ms / 86_400_000);

/**
 * Gives a member a point, or takes one back. Only a member's own key earns:
 * the creator, and anything that is not a member key, is passed over.
 * All-time points never go below zero.
 */
export async function award(id: string, who: string, delta: 1 | -1, owner: DataOwner, now = Date.now()): Promise<void> {
  if (!COMMUNITY.test(id) || !MEMBER.test(who) || !isRedisConfigured()) return;
  const day = dayKey(id, dayOf(now));
  if (delta > 0) {
    // A member's first point puts them on the boards for good: counted in the store's room (lib/order-data.ts).
    await orderWrite(owner, [
      ["ZINCRBY", allKey(id), 1, who],
      ["ZINCRBY", day, 1, who],
      ["EXPIRE", day, DAYS_KEPT * 86_400],
    ]);
    return;
  }
  const [total, today] = await redisPipeline([
    ["ZSCORE", allKey(id), who],
    ["ZSCORE", day, who],
  ]);
  // A like taken back comes off the day it is taken back on when that day has
  // a point to give, and off the all-time total always: the recent boards may
  // stay a point high for a like given last week and taken back today, which
  // is the kinder error of the two.
  const writes: (string | number)[][] = [];
  if (Number(total) > 0) writes.push(["ZINCRBY", allKey(id), -1, who]);
  if (Number(today) > 0) writes.push(["ZINCRBY", day, -1, who]);
  if (writes.length) await redisPipeline(writes);
}

/** Each member's all-time points; 0 for anybody with none. */
export async function pointsOf(id: string, keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(keys)].filter((k) => MEMBER.test(k));
  if (!unique.length || !isRedisConfigured()) return out;
  const rows = await redisPipeline(unique.map((k) => ["ZSCORE", allKey(id), k]));
  unique.forEach((k, i) => out.set(k, Math.max(0, Number(rows[i]) || 0)));
  return out;
}

export type Standing = { key: string; points: number };

/**
 * The top of the board for a period, most points first, and where this
 * member stands on it. Members with no points in the period are left off.
 */
export async function board(
  id: string,
  period: Period,
  viewer: string | null,
  now = Date.now(),
  size = BOARD_SIZE,
): Promise<{ top: Standing[]; mine: { rank: number; points: number } | null }> {
  if (!COMMUNITY.test(id) || !isRedisConfigured()) return { top: [], mine: null };
  let key = allKey(id);
  if (period !== "all") {
    const days = Number(period);
    const today = dayOf(now);
    const sources = Array.from({ length: days }, (_, i) => dayKey(id, today - i));
    key = boardKey(id, period);
    // Made fresh for each read and kept a minute, so a busy page adds no work.
    await redisPipeline([
      ["ZUNIONSTORE", key, sources.length, ...sources],
      ["EXPIRE", key, 60],
    ]);
  }
  const reads: (string | number)[][] = [["ZREVRANGE", key, 0, size - 1, "WITHSCORES"]];
  if (viewer && MEMBER.test(viewer)) reads.push(["ZREVRANK", key, viewer], ["ZSCORE", key, viewer]);
  const [raw, rank, score] = await redisPipeline(reads);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const top: Standing[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const points = Number(flat[i + 1]) || 0;
    if (points > 0) top.push({ key: flat[i], points });
  }
  const mine =
    viewer && rank !== null && rank !== undefined && Number(score) > 0 ? { rank: Number(rank) + 1, points: Number(score) } : null;
  return { top, mine };
}

// ------------------------------------------------------------------ rewards

export async function readRewards(id: string): Promise<Reward[]> {
  if (!COMMUNITY.test(id) || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["GET", rewardsKey(id)]]);
  return parseRewards(raw);
}

export async function saveRewards(id: string, rewards: Reward[]): Promise<void> {
  await redisPipeline([["SET", rewardsKey(id), JSON.stringify(parseRewards(rewards))]]);
}

/**
 * The courses this member has earned by level, with when each reached them
 * (in seconds: a course's drip counts from then). Written the first time it
 * is asked after the level is reached, and never taken back by losing a
 * point later: a reward handed over stays handed over. A member the creator
 * removed from the community earns nothing more.
 */
export async function earnedCourses(
  id: string,
  member: string,
  now = Date.now(),
  /** False while the community is switched off: what was handed over stays, nothing new is. */
  grant = true,
  /** The store whose room what is handed over is counted in (lib/order-data.ts). */
  owner?: DataOwner,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!COMMUNITY.test(id) || !MEMBER.test(member) || !isRedisConfigured()) return out;
  const [rawRewards, points, record, already] = await redisPipeline([
    ["GET", rewardsKey(id)],
    ["ZSCORE", allKey(id), member],
    ["HGET", membersKey(id), member],
    ["HGETALL", unlockedKey(id, member)],
  ]);
  const held = new Map<string, number>();
  const flat = Array.isArray(already) ? already.map(String) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) held.set(flat[i], Number(flat[i + 1]) || 0);
  let removed = typeof record !== "string";
  if (typeof record === "string") {
    try {
      removed = (JSON.parse(record) as { removed?: unknown }).removed === true;
    } catch {
      removed = true;
    }
  }
  if (removed) return out;
  for (const [product, at] of held) out.set(product, at);
  const level = levelOf(Math.max(0, Number(points) || 0));
  if (!grant) return out;
  const due = parseRewards(rawRewards).filter((r) => r.level <= level && !held.has(r.product));
  if (due.length) {
    const at = Math.floor(now / 1000);
    const writes = due.map((r) => ["HSETNX", unlockedKey(id, member), r.product, at]);
    await (owner ? orderWrite(owner, writes) : redisPipeline(writes));
    for (const r of due) out.set(r.product, at);
  }
  return out;
}

/**
 * Deletes one member's points (lib/community-erasure.ts): their all-time
 * total, what they made on each day still kept, the rewards that reached
 * them, and the boards worked out from them, which are worked out again.
 */
export async function forgetPointsPerson(id: string, who: string, now = Date.now()): Promise<number> {
  if (!COMMUNITY.test(id) || !MEMBER.test(who) || !isRedisConfigured()) return 0;
  const today = dayOf(now);
  const days = Array.from({ length: DAYS_KEPT + 1 }, (_, i) => dayKey(id, today - i));
  const replies = await redisPipeline([
    ["ZREM", allKey(id), who],
    ...days.map((key) => ["ZREM", key, who]),
    ["DEL", unlockedKey(id, who), boardKey(id, "7"), boardKey(id, "30"), boardKey(id, "all")],
  ]);
  return replies.reduce<number>((sum, n) => sum + (Number(n) || 0), 0);
}

/**
 * One member's points, for the copy of their data (619 [SZ3],
 * lib/person-copy.ts): the all-time total, each kept day's, and the rewards
 * unlocked. The same records the erasure deletes. Only reads.
 */
export async function pointsRecordOf(id: string, who: string, now = Date.now()): Promise<{ total: number; days: { day: number; points: number }[]; rewards: Record<string, string> }> {
  if (!COMMUNITY.test(id) || !MEMBER.test(who) || !isRedisConfigured()) return { total: 0, days: [], rewards: {} };
  const today = dayOf(now);
  const dayList = Array.from({ length: DAYS_KEPT + 1 }, (_, i) => today - i);
  const [total, unlocked, ...days] = await redisPipeline([["ZSCORE", allKey(id), who], ["HGETALL", unlockedKey(id, who)], ...dayList.map((day) => ["ZSCORE", dayKey(id, day), who])]);
  const flat = Array.isArray(unlocked) ? unlocked.map(String) : [];
  const rewards: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) rewards[flat[i]] = flat[i + 1];
  return {
    total: Math.max(0, Number(total) || 0),
    days: dayList.flatMap((day, i) => (days[i] === null || days[i] === undefined ? [] : [{ day, points: Number(days[i]) || 0 }])),
    rewards,
  };
}
