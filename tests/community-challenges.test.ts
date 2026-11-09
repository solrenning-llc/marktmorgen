/**
 * 19 [E2], unit 1 (TODOS-62 P4): challenges in a store's community
 * (lib/community-challenges.ts). A creator puts a challenge on with a title,
 * a few words, a first and a last day and one task for every day; members
 * join and check in once a day (days run midnight to midnight UTC); each
 * member sees their own check-ins and streak, the creator sees counts.
 *
 * Held here: the input's limits; at most MAX_OPEN_CHALLENGES not yet over
 * and MAX_KEPT_CHALLENGES kept; one check-in a day, never before the first
 * day or after the last; every write takes its room in the store's data
 * room first and gives it back when it is not kept; a challenge over for
 * CHALLENGE_KEEP_DAYS leaves the members' list and is let go, room and all,
 * the next time one is made; a person deleted from the store leaves every
 * challenge, with their check-ins out of the counts; an unknown reply from
 * Redis fails, never reads as "not checked in" (rule 24). No points: those
 * are unit 2.
 */
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import {
  CHALLENGE_DAY_MS,
  challengeDay,
  challengeDays,
  dayDate,
  streakOf,
} from "@/lib/community-challenge-rules";
import {
  challengeBytes,
  challengeCounts,
  challengesOf,
  checkIn,
  createChallenge,
  deleteChallenge,
  joinBytes,
  joinChallenge,
  checkInBytes,
  keptChallenges,
  memberProgress,
  readChallengeInput,
} from "@/lib/community-challenges";
import { CHALLENGE_KEEP_DAYS, MAX_CHALLENGE_DAYS, MAX_KEPT_CHALLENGES, MAX_OPEN_CHALLENGES } from "@/lib/community-text";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "challengeowner@example.com";
const DAY = CHALLENGE_DAY_MS;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function main(): Promise<void> {
  part("Days, run midnight to midnight UTC");
  const start = Date.UTC(2026, 11, 1);
  is("a day is 24 hours", DAY, 86_400_000);
  is("the first day is day 0, the next day 1", [challengeDay(start, start), challengeDay(start, start + DAY - 1), challengeDay(start, start + DAY)], [0, 0, 1]);
  is("before the first day there is none", challengeDay(start, start - 1), -1);
  is("a challenge from the 1st to the 7th has 7 days", challengeDays({ start, end: start + 7 * DAY }), 7);
  is("each day has its date", [dayDate(start, 0), dayDate(start, 6)], ["2026-12-01", "2026-12-07"]);
  is("a streak counts back from today", streakOf([true, true, true], 2), 3);
  is("today not done yet: it counts back from yesterday", streakOf([true, true, false], 2), 2);
  is("a missed day ends it", streakOf([true, false, true, true], 3), 2);
  is("nothing done, nothing", streakOf([false, false], 1), 0);
  is("over: it counts back from the last day", streakOf([true, true, true], 5), 3);

  part("What a creator may put");
  const now = Date.UTC(2026, 10, 20, 15);
  const good = { title: "Write every day", about: "Seven days of writing.", task: "Write 200 words.", from: "2026-12-01", to: "2026-12-07" };
  const read = (over: Record<string, unknown>) => readChallengeInput({ ...good, ...over }, now);
  const ok = read({});
  is("a good one reads, UTC midnight to the midnight after its last day", typeof ok === "string" ? ok : [ok.title, ok.task, ok.start, ok.end], ["Write every day", "Write 200 words.", start, start + 7 * DAY]);
  is("no title", read({ title: "  " }), "title");
  is("no task", read({ task: "" }), "task");
  is("a date that is not one", read({ from: "2026-13-01" }), "dates");
  is("a last day before the first", read({ from: "2026-12-07", to: "2026-12-01" }), "dates");
  is("longer than the most days", read({ to: iso(start + MAX_CHALLENGE_DAYS * DAY) }), "too_long");
  is("exactly the most days is fine", typeof read({ to: iso(start + (MAX_CHALLENGE_DAYS - 1) * DAY) }), "object");
  is("a last day already over", read({ from: "2026-11-01", to: "2026-11-10" }), "past");
  is("too far ahead", read({ from: "2028-01-01", to: "2028-01-02" }), "too_far");
  is("a title too long is cut, not refused", typeof ok !== "string" && (read({ title: "x".repeat(500) }) as { title: string }).title.length, 120);

  redis.clear();
  await claimHandle(OWNER, "challengeshop", "Challenge Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Chal00001", subscriptionId: "sub_Chal00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const room = (slot: string) => Number(redis.run(["HGET", dataKey(store)!, slot])) || 0;
  if (typeof ok === "string") throw new Error("no input");

  part("Made, with its room taken first");
  const made = await createChallenge(store, ok, now);
  if (!made.ok) throw new Error("not made");
  const c = made.challenge;
  const slot = `cm:ch:${c.id}`;
  is("its slot holds what it weighs", room(slot), challengeBytes(c));
  is("it is kept", (await keptChallenges(id, now)).map((x) => x.id), [c.id]);
  for (let i = 1; i < MAX_OPEN_CHALLENGES; i += 1) {
    const more = await createChallenge(store, ok, now);
    is(`one more not yet over (${i + 1})`, more.ok, true);
  }
  const over = await createChallenge(store, ok, now);
  is(`past ${MAX_OPEN_CHALLENGES} not yet over, refused`, over.ok ? "made" : over.reason, "full");

  part("Joined before it starts; checked in only on its days");
  const ada = "adakey00000000000000000000000001";
  const bob = "bobkey00000000000000000000000002";
  is("checking in before the first day: not yet", await checkIn(id, c, ada, store, now), "notyet");
  is("nothing was written for it", room(slot), challengeBytes(c));
  is("joining before it starts", await joinChallenge(id, c, ada, store, now), "joined");
  is("joining twice", await joinChallenge(id, c, ada, store, now), "already");
  is("her place took its room once", room(slot), challengeBytes(c) + joinBytes(ada));
  const day0 = start + 9 * 3_600_000;
  is("on the first day she checks in", await checkIn(id, c, ada, store, day0), "checked");
  is("a second time the same day: already", await checkIn(id, c, ada, store, day0 + 3_600_000), "already");
  is("the check-in took its room once", room(slot), challengeBytes(c) + joinBytes(ada) + checkInBytes(ada, 0));
  is("Bob checks in without joining first: it joins him", await checkIn(id, c, bob, store, day0), "checked");
  is("the next day she checks in again", await checkIn(id, c, ada, store, day0 + DAY), "checked");
  const day3 = day0 + 3 * DAY;
  is("she misses day 2 and comes back on day 3", await checkIn(id, c, ada, store, day3), "checked");

  part("What each sees");
  const mine = (await memberProgress(id, [c], ada, day3)).get(c.id);
  is("her own check-ins, streak and today", mine && [mine.joined, mine.checkIns, mine.streak, mine.today, mine.days], [true, 3, 1, true, [true, true, false, true]]);
  const his = (await memberProgress(id, [c], bob, day3)).get(c.id);
  is("his", his && [his.joined, his.checkIns, his.streak, his.today], [true, 1, 0, false]);
  const nobody = (await memberProgress(id, [c], "carlkey0000000000000000000000003", day3)).get(c.id);
  is("someone who never joined", nobody && [nobody.joined, nobody.checkIns], [false, 0]);
  const counts = (await challengeCounts(id, [c], day3)).get(c.id);
  is("the creator's counts: joined, check-ins, today", counts && [counts.joined, counts.checkIns, counts.today], [2, 4, 1]);

  part("Over: no more joining or checking in");
  const after = start + 7 * DAY;
  is("checking in after the last day", await checkIn(id, c, ada, store, after), "ended");
  is("joining after the last day", await joinChallenge(id, c, "dankey00000000000000000000000004", store, after), "ended");
  is("an ended one no longer counts as open: one more can be made", (await createChallenge(store, { ...ok, start: after + DAY, end: after + 3 * DAY }, after)).ok, true);

  part("A person deleted from the store leaves every challenge");
  is("her copy shows the challenge and her days", (await challengesOf(id, ada)).map((x) => [x.challenge, x.checkIns]), [[c.id, ["2026-12-01", "2026-12-02", "2026-12-04"]]]);
  const before = room(slot);
  await forgetCommunityPerson(id, ada, "ada@example.com", [], store);
  is("her copy is empty", await challengesOf(id, ada), []);
  const left = (await memberProgress(id, [c], ada, day3)).get(c.id);
  is("she is no longer in it", left && [left.joined, left.checkIns], [false, 0]);
  const counted = (await challengeCounts(id, [c], day3)).get(c.id);
  is("the counts no longer hold her", counted && [counted.joined, counted.checkIns, counted.today], [1, 1, 0]);
  is("her room came back", before - room(slot), joinBytes(ada) + checkInBytes(ada, 0) + checkInBytes(ada, 1) + checkInBytes(ada, 3));

  part("Kept for a while after it ends, then let go");
  const gone = after + CHALLENGE_KEEP_DAYS * DAY + 1;
  is("still shown during the keep", (await keptChallenges(id, after + DAY)).some((x) => x.id === c.id), true);
  is("not shown after it", (await keptChallenges(id, gone)).some((x) => x.id === c.id), false);
  const fresh = await createChallenge(store, { ...ok, start: gone + DAY, end: gone + 2 * DAY }, gone);
  is("the next one made lets it go", fresh.ok, true);
  is("its slot is given back", room(slot), 0);
  is("and its keys are gone", redis.run(["EXISTS", `nl:cm:${id}:ch:${c.id}`]), 0);

  part("At most MAX_KEPT_CHALLENGES kept");
  redis.clear();
  await claimHandle(OWNER, "challengeshop", "Challenge Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Chal00001", subscriptionId: "sub_Chal00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const again = (await storeForEmail(OWNER))!;
  const cid = again.community!.id;
  let t = now;
  let kept = 0;
  let refused = "";
  for (let i = 0; i < MAX_KEPT_CHALLENGES + 2; i += 1) {
    // One day each, from the next midnight, one made a day: one open at a time, all still in their keep.
    const next = t + DAY - (t % DAY);
    const made2 = await createChallenge(again, { ...ok, start: next, end: next + DAY }, t);
    if (made2.ok) kept += 1;
    else refused = made2.reason;
    t += DAY;
  }
  is(`never more than ${MAX_KEPT_CHALLENGES} kept`, [kept, refused, (await keptChallenges(cid, t)).length], [MAX_KEPT_CHALLENGES, "full", MAX_KEPT_CHALLENGES]);

  part("Deleted by the creator, room and all");
  const target = (await keptChallenges(cid, t)).at(-1)!;
  is("she joins the last one", await joinChallenge(cid, target, ada, again, t), "joined");
  is("deleted", await deleteChallenge(again, target.id), "deleted");
  is("its slot is empty", Number(redis.run(["HGET", dataKey(again)!, `cm:ch:${target.id}`])) || 0, 0);
  is("and its members' list is gone", redis.run(["EXISTS", `nl:cm:${cid}:ch:${target.id}:in`]), 0);
  is("deleting again: gone", await deleteChallenge(again, target.id), "gone");

  part("An unknown reply fails, never reads as no (rule 24)");
  const first = t + DAY - (t % DAY);
  const fresh2 = await createChallenge(again, { ...ok, start: first, end: first + 7 * DAY }, t);
  if (!fresh2.ok) throw new Error("not made for the reply checks");
  const inside = first + DAY;
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((cmd, i) => (cmd[0] === "HSETNX" || cmd[0] === "HEXISTS" || cmd[0] === "HMGET" ? "?" : replies[i]));
  }) as typeof redis.pipeline;
  const failed = async (work: () => Promise<unknown>) => work().then(() => "answered", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
  is("a check-in", await failed(() => checkIn(cid, fresh2.challenge, bob, again, inside)), "unknown");
  is("a join", await failed(() => joinChallenge(cid, fresh2.challenge, bob, again, inside)), "unknown");
  is("what a member sees", await failed(() => memberProgress(cid, [fresh2.challenge], bob, inside)), "unknown");
  redis.pipeline = real;

  done();
}

void main();
