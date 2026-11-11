/**
 * Points, levels, the leaderboard, and what a level opens.
 *
 * Measured before it was built (30 September 2026): Skool — 1 point a like,
 * 9 levels, a leaderboard, courses unlocked at a level; Circle — points,
 * levels, leaderboards, unlocked content; Mighty Networks — points, badges,
 * leaderboards; Stan — none. What is checked here is what members rely on:
 *
 *   - the levels are where the page says they are;
 *   - a point never goes below zero, and the creator never collects one;
 *   - the 7- and 30-day boards count only those days;
 *   - a course handed over at a level opens for that member, from the day
 *     they reached it, stays theirs if their points fall, and never opens
 *     for somebody the creator removed.
 */
import { addProduct, claimHandle, setCommunity, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { memberKey, readMember, touchMember } from "@/lib/community";
import { LEVELS, REMOVE_POINT, award, board, earnedCourses, levelOf, parseRewards, pointsOf, saveRewards, toNextLevel } from "@/lib/community-points";
import { paidCourses } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const DAY = 86_400_000;

const pipeline = redis.pipeline.bind(redis);

/** The shared memory Redis has no general Lua interpreter; model this one script exactly for the linked behavior suite. */
function installPointRemoval(): void {
  redis.pipeline = (async (batch) => {
    const command = batch[0];
    if (batch.length !== 1 || command?.[0] !== "EVAL" || command[1] !== REMOVE_POINT) return pipeline(batch);
    const totalKey = String(command[3]);
    const todayKey = String(command[4]);
    const member = String(command[5]);
    const values = await pipeline([["ZSCORE", totalKey, member], ["ZSCORE", todayKey, member]]);
    const score = (raw: unknown): number | null => {
      if (raw === null) return 0;
      const value = typeof raw === "string" ? Number(raw) : Number.NaN;
      return Number.isSafeInteger(value) ? value : null;
    };
    const total = score(values[0]);
    const today = score(values[1]);
    if (total === null || today === null) return [[-1, -1]];
    const writes: (string | number)[][] = [];
    if (total < 0) writes.push(["ZADD", totalKey, 0, member]);
    else if (total > 0) writes.push(["ZINCRBY", totalKey, -1, member]);
    if (today < 0) writes.push(["ZADD", todayKey, 0, member]);
    else if (today > 0) writes.push(["ZINCRBY", todayKey, -1, member]);
    if (writes.length) await pipeline(writes);
    return [[total > 0 ? 1 : 0, today > 0 ? 1 : 0]];
  }) as typeof redis.pipeline;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_points_only_a_stand_in";
  redis.clear();
  installPointRemoval();

  part("Levels are where the page says");
  is("0 points is Level 1", levelOf(0), 1);
  is("4 points is still Level 1", levelOf(4), 1);
  is("5 points is Level 2", levelOf(5), 2);
  is("the top is Level 9", levelOf(LEVELS[8]), 9);
  is("far past the top is still Level 9", levelOf(1_000_000), 9);
  is("from 3 points, 2 more reach Level 2", toNextLevel(3), 2);
  is("at the top there is no next level", toNextLevel(40_000), null);

  part("What a level can hand over");
  is("one course per level, lowest level first", parseRewards([{ level: 3, product: "course3aaaa" }, { level: 2, product: "course2aaaa" }]).map((r) => r.level), [2, 3]);
  is("Level 1 hands nothing over: everybody is at it", parseRewards([{ level: 1, product: "course1aaaa" }]).length, 0);
  is("two courses on one level: the first stands", parseRewards([{ level: 2, product: "aaaaaaaa" }, { level: 2, product: "bbbbbbbb" }]).map((r) => r.product), ["aaaaaaaa"]);
  is("past the top level: refused", parseRewards([{ level: 10, product: "aaaaaaaa" }]).length, 0);

  const made = await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const withCommunity = await setCommunity("owner@example.com", true);
  const id = withCommunity?.community?.id;
  if (!id) throw new Error("no community");
  const ana = memberKey("ana@example.com");
  const ben = memberKey("ben@example.com");
  await touchMember(id, "ana@example.com", null, { sid: "points-test" });
  await touchMember(id, "ben@example.com", null, { sid: "points-test" });

  part("Points");
  const now = Date.now();
  for (let i = 0; i < 6; i += 1) await award(id, ana, 1, { sid: "points-test" }, now);
  await award(id, ana, -1, { sid: "points-test" }, now);
  is("six likes and one taken back is five points", (await pointsOf(id, [ana])).get(ana), 5);
  await award(id, ben, -1, { sid: "points-test" }, now);
  is("taking back a point nobody had leaves zero, never less", (await pointsOf(id, [ben])).get(ben), 0);
  await award(id, "creator", 1, { sid: "points-test" }, now);
  is("the creator collects no points", (await board(id, "all", null, now)).top.some((s) => s.key === "creator"), false);

  part("The boards");
  // Ben's points were all made twelve days ago.
  for (let i = 0; i < 9; i += 1) await award(id, ben, 1, { sid: "points-test" }, now - 12 * DAY);
  const all = await board(id, "all", ben, now);
  is("all time: Ben first with 9, Ana with 5", all.top.map((s) => [s.key === ben ? "ben" : "ana", s.points]), [["ben", 9], ["ana", 5]]);
  is("and Ben is told he is first", all.mine, { rank: 1, points: 9 });
  const week = await board(id, "7", ben, now);
  is("7 days: only Ana, whose points are from today", week.top.map((s) => (s.key === ana ? "ana" : "ben")), ["ana"]);
  is("Ben has no place on this week's board", week.mine, null);
  const month = await board(id, "30", null, now);
  is("30 days: both", month.top.length, 2);

  part("A course handed over at a level");
  const course = await addProduct("owner@example.com", "Knife Skills", "", "49");
  if (!course.ok) throw new Error("no product");
  const productId = course.product.id;
  await setProductCourse("owner@example.com", productId, { id: "c".repeat(32), lessons: 3 });
  await saveRewards(id, [{ level: 2, product: productId }]);
  const store = await storeForEmail("owner@example.com");
  if (!store) throw new Error("no store");
  const reached = now;
  const earned = await earnedCourses(id, ana, reached);
  is("Ana, at Level 2, has it", earned.has(productId), true);
  is("from the day she reached it", earned.get(productId), Math.floor(reached / 1000));
  is("and the course opens for her", (await paidCourses(store, "ana@example.com")).has(productId), true);
  await award(id, ana, -1, { sid: "points-test" }, now);
  await award(id, ana, -1, { sid: "points-test" }, now);
  is("her points fall under Level 2", levelOf((await pointsOf(id, [ana])).get(ana) ?? 0), 1);
  is("and the course stays hers", (await paidCourses(store, "ana@example.com")).has(productId), true);
  const carl = memberKey("carl@example.com");
  await touchMember(id, "carl@example.com", null, { sid: "points-test" });
  is("Carl, at Level 1, does not have it", (await paidCourses(store, "carl@example.com")).has(productId), false);
  for (let i = 0; i < 5; i += 1) await award(id, carl, 1, { sid: "points-test" }, now);
  // Taken out by the creator: the record as moderation leaves it.
  const record = await readMember(id, carl);
  await redis.pipeline([["HSET", `nl:cm:${id}:m`, carl, JSON.stringify({ ...record, removed: true })]]);
  is("somebody the creator removed never gets it, whatever their points", (await paidCourses(store, "carl@example.com")).has(productId), false);
  is("nor does an address that never came in", (await earnedCourses(id, memberKey("stranger@example.com"), now)).size, 0);
  await setCommunity("owner@example.com", false);
  const off = await storeForEmail("owner@example.com");
  is("a community switched off hands nothing new over", (await paidCourses(off!, "ben@example.com")).has(productId), false);
  is("and what it already handed over stays", (await paidCourses(off!, "ana@example.com")).has(productId), true);

  done();
}

void main();
