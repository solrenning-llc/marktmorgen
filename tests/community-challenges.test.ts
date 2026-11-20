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
  forgetChallengesPerson,
  joinBytes,
  joinChallenge,
  checkInBytes,
  keptChallenges,
  memberProgress,
  readChallenge,
  readChallengeInput,
} from "@/lib/community-challenges";
import { readFileSync } from "node:fs";
import { CHALLENGE_KEEP_DAYS, MAX_CHALLENGE_DAYS, MAX_KEPT_CHALLENGES, MAX_OPEN_CHALLENGES } from "@/lib/community-text";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { CHALLENGE_WORDS } from "@/lib/buyer-words/challenges";
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
  is("she had joined the last one", await joinChallenge(cid, target, ada, again, target.start), "joined");
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

  part("A record that cannot be read never hides a person's part (Claude 6's review of #3452, M1)");
  const ch2 = fresh2.challenge;
  const recordKey = `nl:cm:${cid}:ch:${ch2.id}`;
  const goodRecord = redis.run(["GET", recordKey]) as string;
  const slot2 = `cm:ch:${ch2.id}`;
  const room2 = () => Number(redis.run(["HGET", dataKey(again)!, slot2])) || 0;
  is("Bob checks in on its second day", await checkIn(cid, ch2, bob, again, inside), "checked");
  redis.run(["SET", recordKey, "{damaged"]);
  const copied = await challengesOf(cid, bob).then((xs) => xs.map((x) => [x.challenge, x.checkIns.length]), (e: unknown) => String(e));
  is("his copy still holds the challenge and his day", copied, [[ch2.id, 1]]);
  const roomBefore = room2();
  await forgetCommunityPerson(cid, bob, "bob@example.com", [], again);
  is("erasure takes his place out", redis.run(["HEXISTS", `${recordKey}:in`, bob]), 0);
  is("and his check-in", redis.run(["HEXISTS", `${recordKey}:k`, `${bob}|1`]), 0);
  is("and gives his room back", roomBefore - room2(), joinBytes(bob) + checkInBytes(bob, 1));
  is("the counts no longer hold him", redis.run(["HGET", `${recordKey}:n`, "all"]), "0");
  redis.run(["SET", recordKey, goodRecord]);
  is("Carl checks in", await checkIn(cid, ch2, "carlkey0000000000000000000000003", again, inside), "checked");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((cmd, i) => (cmd[0] === "GET" && String(cmd[1]) === recordKey ? 42 : replies[i]));
  }) as typeof redis.pipeline;
  is("a record read of an unknown shape: unknown, not gone", await failed(() => readChallenge(cid, ch2.id)), "unknown");
  is("his copy: unknown, never left out", await failed(() => challengesOf(cid, "carlkey0000000000000000000000003")), "unknown");
  is("erasure does not need the record", await failed(() => forgetCommunityPerson(cid, "carlkey0000000000000000000000003", "carl@example.com", [], again)), "answered");
  redis.pipeline = real;
  is("his check-in went", redis.run(["HEXISTS", `${recordKey}:k`, "carlkey0000000000000000000000003|1"]), 0);

  part("A delete that lands mid-write leaves nothing behind (Claude 6's review of #3452, L2)");
  const dan = "dankey00000000000000000000000004";
  let armed = "";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (armed && commands.some((cmd) => cmd[0] === "HSETNX" && String(cmd[1]) === armed)) {
      armed = "";
      await deleteChallenge(again, ch2.id);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  is("Dan joins", await joinChallenge(cid, ch2, dan, again, inside), "joined");
  armed = `${recordKey}:k`;
  is("a check-in the delete overtook: gone", await checkIn(cid, ch2, dan, again, inside), "gone");
  redis.pipeline = real;
  is("no check-in left behind", redis.run(["EXISTS", `${recordKey}:k`]), 0);
  is("no count left behind", redis.run(["EXISTS", `${recordKey}:n`]), 0);
  is("its slot stays empty", room2(), 0);
  const ch3 = await createChallenge(again, { ...ok, start: first, end: first + 7 * DAY }, t);
  if (!ch3.ok) throw new Error("not made for the join race");
  const key3 = `nl:cm:${cid}:ch:${ch3.challenge.id}`;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (armed && commands.some((cmd) => cmd[0] === "HSETNX" && String(cmd[1]) === armed)) {
      armed = "";
      await deleteChallenge(again, ch3.challenge.id);
    }
    return real(commands);
  }) as typeof redis.pipeline;
  armed = `${key3}:in`;
  is("a join the delete overtook: gone", await joinChallenge(cid, ch3.challenge, dan, again, inside), "gone");
  redis.pipeline = real;
  is("no place left behind", redis.run(["EXISTS", `${key3}:in`]), 0);
  is("its slot stays empty too", Number(redis.run(["HGET", dataKey(again)!, `cm:ch:${ch3.challenge.id}`])) || 0, 0);

  part("The studio and the members' page (Claude 6's review of #3452, L3 to L5)");
  const studioPage = readFileSync("app/studio/community/page.tsx", "utf8");
  is("an unreadable list is never read as no challenges", /keptChallenges\(id, now\)\.catch\(\(\) => \[\]\)/.test(studioPage), false);
  const studioPart = readFileSync("components/community-challenges-studio.tsx", "utf8");
  is("the studio says so", studioPart.includes("The challenges could not be read just now. Reload the page."), true);
  is("focus goes back to the Delete button when the question closes", /deleteRefs|focusDelete/.test(studioPart), true);
  const memberPart = readFileSync("components/community-challenges.tsx", "utf8");
  is("the days' summary is a 44 px target", /<summary className="[^"]*min-h-11[^"]*"/.test(memberPart), true);

  part("A delete takes the challenge off the list before its keys (Claude 6's focal on #3452, A)");
  const eve = "evekey00000000000000000000000005";
  const ch4 = await createChallenge(again, { ...ok, start: first, end: first + 7 * DAY }, t);
  if (!ch4.ok) throw new Error("not made for the delete-order check");
  const key4 = `nl:cm:${cid}:ch:${ch4.challenge.id}`;
  let gapArmed = true;
  let joinedInGap: string | null = null;
  // Upstash runs a pipeline's commands one after another, not as one step:
  // a join lands between the delete's first command and its second.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const letGo = commands.some((cmd) => cmd[0] === "DEL" && String(cmd[1]) === key4) && commands.some((cmd) => cmd[0] === "ZREM");
    if (!gapArmed || !letGo) return real(commands);
    gapArmed = false;
    const out: unknown[] = [];
    for (let i = 0; i < commands.length; i++) {
      out.push((await real([commands[i]]))[0]);
      if (i === 0) joinedInGap = await joinChallenge(cid, ch4.challenge, eve, again, inside);
    }
    return out;
  }) as typeof redis.pipeline;
  await deleteChallenge(again, ch4.challenge.id);
  redis.pipeline = real;
  is("a join between the delete's two steps: gone", joinedInGap, "gone");
  is("no place left behind", redis.run(["EXISTS", `${key4}:in`]), 0);
  is("its slot stays empty", Number(redis.run(["HGET", dataKey(again)!, `cm:ch:${ch4.challenge.id}`])) || 0, 0);

  part("A delete reads whether the challenge is listed exactly (Claude 6's focal on #3452, B)");
  const ch5 = await createChallenge(again, { ...ok, start: first, end: first + 7 * DAY }, t);
  if (!ch5.ok) throw new Error("not made for the exact-read check");
  const key5 = `nl:cm:${cid}:ch:${ch5.challenge.id}`;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((cmd, i) => (cmd[0] === "ZSCORE" && String(cmd[2]) === ch5.challenge.id ? ["?"] : replies[i]));
  }) as typeof redis.pipeline;
  is("a list read of an unknown shape: unknown, never deleted", await failed(() => deleteChallenge(again, ch5.challenge.id)), "unknown");
  // A score that is not a number (text, empty) is not Redis's ZSCORE answer either: unknown, never "still kept" (Codex Z's
  // residual LOW on #3452).
  for (const odd of ["not-a-score", "", "NaN"]) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      return commands.map((cmd, i) => (cmd[0] === "ZSCORE" && String(cmd[2]) === ch5.challenge.id ? odd : replies[i]));
    }) as typeof redis.pipeline;
    is(`a score that is not a number (${JSON.stringify(odd)}): unknown, never deleted`, await failed(() => deleteChallenge(again, ch5.challenge.id)), "unknown");
  }
  redis.pipeline = real;
  is("the challenge is still there", redis.run(["EXISTS", key5]), 1);

  part("After a delete the focus goes somewhere that stays (Claude 6's focal on #3452, C; 2.4.3)");
  is("the list's heading can take the focus", /<h3[^>]*ref=\{listHeadRef\}[^>]*tabIndex=\{-1\}|<h3[^>]*tabIndex=\{-1\}[^>]*ref=\{listHeadRef\}/.test(studioPart), true);
  is("a delete that worked sends the focus there, not to the Delete button that goes", /asked\.current = null;[\s\S]{0,200}listHeadRef\.current\?\.focus\(\)/.test(studioPart), true);

  part("A challenge deleted while a person is being erased leaves no count behind (Claude 1's LOW on #3452)");
  redis.clear();
  await claimHandle(OWNER, "challengeshop", "Challenge Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Chal00001", subscriptionId: "sub_Chal00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const raced = (await storeForEmail(OWNER))!;
  const rid = raced.community!.id;
  const racedMade = await createChallenge(raced, ok, now);
  if (!racedMade.ok) throw new Error("not made for the race");
  const rc = racedMade.challenge;
  is("(she checks in on the first day)", await checkIn(rid, rc, ada, raced, rc.start), "checked");
  const racedReal = redis.pipeline.bind(redis);
  let deletedMidway = "";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await racedReal(commands);
    // Right after the erasure's HDEL of her place, the creator deletes the challenge.
    if (!deletedMidway && commands.some((c) => c[0] === "HDEL" && c[1] === `nl:cm:${rid}:ch:${rc.id}:in`)) deletedMidway = await deleteChallenge(raced, rc.id);
    return replies;
  }) as typeof redis.pipeline;
  try {
    await forgetChallengesPerson(rid, ada, raced);
  } finally {
    redis.pipeline = racedReal;
  }
  is("deleted in between, and its counts are not made again", [deletedMidway, redis.run(["EXISTS", `nl:cm:${rid}:ch:${rc.id}:n`])], ["deleted", 0]);

  part("A check-in on the last day promises no tomorrow (Claude 1's LOW on #3452, VR item 2)");
  const tomorrow: Record<string, RegExp> = { en: /tomorrow/i, es: /mañana/i, fr: /demain/i, de: /morgen/i, it: /domani/i, nl: /morgen/i, pt: /amanhã/i };
  const comeBack: Record<string, RegExp> = { en: /each day/i, es: /cada día/i, fr: /chaque jour/i, de: /jeden Tag/i, it: /ogni giorno/i, nl: /elke dag/i, pt: /todos os dias/i };
  is("joining, in every language, promises no day past the last (Revisor 2's LOW on #3452)", Object.entries(CHALLENGE_WORDS).filter(([code, w]) => comeBack[code]?.test(w.notices.joined.text) ?? true).map(([code]) => code), []);
  is("the check-in notice, in every language, says it is done and nothing about tomorrow", Object.entries(CHALLENGE_WORDS).filter(([code, w]) => tomorrow[code]?.test(w.notices.checked.text) ?? true).map(([code]) => code), []);
  done();
}

void main();
