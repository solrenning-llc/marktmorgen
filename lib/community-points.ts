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
 * Removes at most one point from each board in one Redis turn. Older races
 * could leave a negative integer; the next removal repairs that value to
 * zero. Non-integer or unsafe scores are unknown and nothing is changed.
 */
export const REMOVE_POINT = `-- marktmorgen:community-point-remove:v1
local function score(key)
  local raw = redis.call('ZSCORE', key, ARGV[1])
  if raw == false then return 0 end
  local value = tonumber(raw)
  if not value or value ~= math.floor(value) or math.abs(value) > 9007199254740991 then return false end
  return value
end
local total = score(KEYS[1])
local today = score(KEYS[2])
if total == false or today == false then return {-1, -1} end
local function take(key, value)
  if value < 0 then redis.call('ZADD', key, 0, ARGV[1]); return 0 end
  if value == 0 then return 0 end
  redis.call('ZINCRBY', key, -1, ARGV[1])
  return 1
end
return {take(KEYS[1], total), take(KEYS[2], today)}`;

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
  // A like taken back comes off today only when today has a point to give;
  // a like from last week can therefore leave a recent board one point high.
  // Both decisions are made atomically so two presses cannot cross at zero.
  const [reply] = await redisPipeline([["EVAL", REMOVE_POINT, 2, allKey(id), day, who]]);
  if (!Array.isArray(reply) || reply.length !== 2 || reply.some((value) => value !== 0 && value !== 1)) {
    throw new Error("Community points could not be removed");
  }
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

/** Points and stored start dates are integer evidence, never coercible objects. */
function rewardInteger(raw: unknown): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

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
  const replies = await redisPipeline([
    ["GET", rewardsKey(id)],
    ["ZSCORE", allKey(id), member],
    ["HGET", membersKey(id), member],
    ["HGETALL", unlockedKey(id, member)],
  ]);
  if (!Array.isArray(replies) || replies.length !== 4) return out;
  const [rawRewards, points, record, already] = replies;
  const held = new Map<string, number>();
  if (!Array.isArray(already) || already.length % 2 !== 0) return out;
  for (let i = 0; i < already.length; i += 2) {
    const product: unknown = already[i];
    const at = rewardInteger(already[i + 1]);
    // Reuse the product rule of the existing reward parser. A retained
    // course does not need to remain in today's reward configuration.
    if (typeof product !== "string" || parseRewards([{ level: 2, product }]).length !== 1 || held.has(product)
      || at === null || at === 0 || at > 8_640_000_000_000) return out;
    held.set(product, at);
  }
  if (typeof record !== "string") return out;
  try {
    const value: unknown = JSON.parse(record);
    if (!value || typeof value !== "object" || Array.isArray(value)) return out;
    const membership = value as { k?: unknown; removed?: unknown };
    if (membership.k !== member || membership.removed !== false) return out;
  } catch { return out; }
  for (const [product, at] of held) out.set(product, at);
  if (!grant) return out;
  const score = points === null ? 0 : rewardInteger(points);
  if (score === null || !Number.isSafeInteger(now) || now <= 0 || now > 8_640_000_000_000_000 || typeof rawRewards !== "string") return out;
  let configuration: unknown;
  try { configuration = JSON.parse(rawRewards); } catch { return out; }
  const rewards = parseRewards(configuration);
  // Dropping one malformed entry would turn an unconfirmed configuration
  // into an apparently valid partial authorization list.
  if (!Array.isArray(configuration) || rewards.length !== configuration.length) return out;
  const level = levelOf(score);
  const due = rewards.filter((r) => r.level <= level && !held.has(r.product));
  if (due.length) {
    const at = Math.floor(now / 1000);
    const writes = due.map((r) => ["HSETNX", unlockedKey(id, member), r.product, at]);
    const answers = await (owner ? orderWrite(owner, writes) : redisPipeline(writes));
    if (!Array.isArray(answers) || answers.length !== due.length || answers.some((a) => a !== 0 && a !== 1)) return out;
    for (let i = 0; i < due.length; i += 1) {
      // Zero means another writer already created it. Its original date is
      // confirmed by the next ordinary read, never replaced with this clock.
      if (answers[i] === 1) out.set(due[i].product, at);
    }
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

const STORED_PRODUCT = /^[a-z0-9]{6,40}$/;

function storedPoints(value: unknown): number | null {
  if (value === null) return null;
  // A pair of removals could race before the atomic decrement existed and
  // leave a negative integer behind. It is known points data, not a missing
  // Redis answer; the copy represents that impossible public score as zero.
  if (typeof value !== "string" || !/^(0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value)) throw new Error("Incomplete community points record");
  const points = Number(value);
  if (!Number.isSafeInteger(points)) throw new Error("Incomplete community points record");
  return points;
}

function storedRewards(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || value.length % 2 !== 0) {
    throw new Error("Incomplete community points record");
  }
  const rewards: Record<string, string> = {};
  for (let i = 0; i < value.length; i += 2) {
    const product = value[i];
    const at = value[i + 1];
    if (typeof product !== "string" || !STORED_PRODUCT.test(product) || typeof at !== "string" || !/^(0|[1-9][0-9]*)$/.test(at)) {
      throw new Error("Incomplete community points record");
    }
    if (Object.hasOwn(rewards, product)) throw new Error("Incomplete community points record");
    const reachedAt = Number(at);
    if (!Number.isSafeInteger(reachedAt)) throw new Error("Incomplete community points record");
    rewards[product] = at;
  }
  return rewards;
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
  const replies = await redisPipeline([["ZSCORE", allKey(id), who], ["HGETALL", unlockedKey(id, who)], ...dayList.map((day) => ["ZSCORE", dayKey(id, day), who])]);
  if (!Array.isArray(replies) || replies.length !== dayList.length + 2) throw new Error("Incomplete community points record");
  const total = storedPoints(replies[0]);
  const rewards = storedRewards(replies[1]);
  const days = replies.slice(2).map(storedPoints);
  return {
    total: Math.max(0, total ?? 0),
    days: dayList.flatMap((day, i) => (days[i] === null ? [] : [{ day, points: Math.max(0, days[i]) }])),
    rewards,
  };
}
