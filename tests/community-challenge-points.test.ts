/**
 * 19 [E2], unit 2: points for community challenges. A challenge can give the
 * community's own points (lib/community-points.ts, the same board, levels and
 * rewards as a like) for each day's check-in and, once, for checking in on
 * every one of its days. The creator sets both, each from 0 (the default:
 * nothing changes unless they choose) up to its cap.
 *
 * Held here: the creator's numbers are read and bounded; a record from
 * before unit 2 reads as 0 and 0, and a record holding numbers out of shape
 * does not read; points are given only by the press that wrote the day's
 * check-in, so two presses at once give them once (rule 25); the bonus only
 * on the last day and only with every day checked in; a reply that cannot
 * be read gives no points and never says "0 points" (rule 24); a challenge a
 * delete overtook gives none; the person's erasure takes them with their
 * other points (rule 28) and the copy of their data says how many each
 * challenge gave; the commands are held under the community line (rule 26).
 */
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { CHALLENGE_DAY_MS } from "@/lib/community-challenge-rules";
import {
  challengePointsOf,
  challengesOf,
  checkIn,
  createChallenge,
  readChallenge,
  readChallengeInput,
} from "@/lib/community-challenges";
import { MAX_CHALLENGE_DAY_POINTS, MAX_CHALLENGE_DONE_POINTS } from "@/lib/community-text";
import { awardPoints, pointsOf, pointsRecordOf } from "@/lib/community-points";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { UnknownReplyError } from "@/lib/redis-reply";
import { challengeWords } from "@/lib/buyer-words/challenges";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "pointsowner@example.com";
const DAY = CHALLENGE_DAY_MS;

async function main(): Promise<void> {
  const now = Date.UTC(2026, 10, 20, 15);
  const start = Date.UTC(2026, 11, 1);
  const good = { title: "Write every day", about: "", task: "Write 200 words.", from: "2026-12-01", to: "2026-12-03" };
  const read = (over: Record<string, unknown>) => readChallengeInput({ ...good, ...over }, now);

  part("What the creator sets");
  const plain = read({});
  is("nothing set: no points at all", typeof plain === "string" ? plain : [plain.dayPoints, plain.donePoints], [0, 0]);
  const set = read({ dayPoints: "3", donePoints: 20 });
  is("set as text or a number", typeof set === "string" ? set : [set.dayPoints, set.donePoints], [3, 20]);
  is("empty fields are 0", (() => { const r = read({ dayPoints: "", donePoints: "" }); return typeof r === "string" ? r : [r.dayPoints, r.donePoints]; })(), [0, 0]);
  is(`at most ${MAX_CHALLENGE_DAY_POINTS} for a day`, read({ dayPoints: MAX_CHALLENGE_DAY_POINTS + 1 }), "points");
  is(`at most ${MAX_CHALLENGE_DONE_POINTS} for every day`, read({ donePoints: MAX_CHALLENGE_DONE_POINTS + 1 }), "points");
  is("never below 0", read({ dayPoints: -1 }), "points");
  is("never a fraction", read({ dayPoints: "1.5" }), "points");
  is("never anything else", read({ donePoints: "ten" }), "points");
  is("exactly the caps is fine", typeof read({ dayPoints: MAX_CHALLENGE_DAY_POINTS, donePoints: MAX_CHALLENGE_DONE_POINTS }), "object");

  redis.clear();
  await claimHandle(OWNER, "pointsshop", "Points Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Pts000001", subscriptionId: "sub_Pts000001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  if (typeof set === "string") throw new Error("no input");

  part("Kept with the challenge; an older record reads as no points");
  const made = await createChallenge(store, set, now);
  if (!made.ok) throw new Error("not made");
  const c = made.challenge;
  is("kept", [(await readChallenge(id, c.id))?.dayPoints, (await readChallenge(id, c.id))?.donePoints], [3, 20]);
  const key = `nl:cm:${id}:ch:${c.id}`;
  const record = JSON.parse(redis.run(["GET", key]) as string) as Record<string, unknown>;
  const { dayPoints: _d, donePoints: _p, ...older } = record;
  redis.run(["SET", key, JSON.stringify(older)]);
  is("a record from before unit 2: 0 and 0", [(await readChallenge(id, c.id))?.dayPoints, (await readChallenge(id, c.id))?.donePoints], [0, 0]);
  redis.run(["SET", key, JSON.stringify({ ...record, dayPoints: 999 })]);
  is("a record with points out of shape does not read", await readChallenge(id, c.id), null);
  redis.run(["SET", key, JSON.stringify(record)]);

  part("Each check-in gives the day's points, once");
  const ada = "ada00000000000000000000000000001";
  const bob = "b0b00000000000000000000000000002";
  const day0 = start + 9 * 3_600_000;
  is("Ada checks in on the first day", await checkIn(id, c, ada, store, day0), "checked");
  is("three points", (await pointsOf(id, [ada])).get(ada), 3);
  is("again the same day: already, no more points", await checkIn(id, c, ada, store, day0 + 60_000), "already");
  is("still three", (await pointsOf(id, [ada])).get(ada), 3);
  const both = await Promise.all([checkIn(id, c, bob, store, day0), checkIn(id, c, bob, store, day0)]);
  is("two presses at once: one checked, one already", both.slice().sort(), ["already", "checked"]);
  is("Bob got the day's points once", (await pointsOf(id, [bob])).get(bob), 3);
  is("they count on the day's board too", Number(redis.run(["ZSCORE", `nl:cm:${id}:pts:d:${Math.floor(day0 / DAY)}`, ada])), 3);

  part("The bonus: only on the last day, only with every day checked in");
  is("Ada checks in on the second day", await checkIn(id, c, ada, store, day0 + DAY), "checked");
  is("six, no bonus yet", (await pointsOf(id, [ada])).get(ada), 6);
  is("Ada checks in on the last day", await checkIn(id, c, ada, store, day0 + 2 * DAY), "checked");
  is("every day: 9 for the days and 20 more", (await pointsOf(id, [ada])).get(ada), 29);
  is("Bob missed the second day; on the last he gets the day only", await checkIn(id, c, bob, store, day0 + 2 * DAY), "checked");
  is("Bob: 6, no bonus", (await pointsOf(id, [bob])).get(bob), 6);

  part("No points set: nothing changes");
  const zero = await createChallenge(store, typeof plain === "string" ? (() => { throw new Error("no input"); })() : plain, now);
  if (!zero.ok) throw new Error("not made");
  const carl = "ca710000000000000000000000000003";
  is("Carl checks in", await checkIn(id, zero.challenge, carl, store, day0), "checked");
  is("no points, and not on the board", [(await pointsOf(id, [carl])).get(carl), redis.run(["ZSCORE", `nl:cm:${id}:pts`, carl])], [0, null]);

  part("A reply that cannot be read gives no points (rule 24)");
  const real = redis.pipeline.bind(redis);
  const dan = "da000000000000000000000000000004";
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((cmd, i) => (cmd[0] === "HSETNX" ? "?" : replies[i]));
  }) as typeof redis.pipeline;
  const failed = async (work: () => Promise<unknown>) => work().then(() => "answered", (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)));
  is("a check-in whose write cannot be read: unknown", await failed(() => checkIn(id, c, dan, store, day0)), "unknown");
  redis.pipeline = real;
  is("and no points", redis.run(["ZSCORE", `nl:cm:${id}:pts`, dan]), null);
  is("points are given in whole numbers only", await failed(() => awardPoints(id, dan, 0, store, day0)), "Error: Points must be a whole number from 1 to 110");
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    // The points go through the store's charged write (lib/order-data.ts): one script, one reply per command in it.
    return commands.map((cmd, i) => (cmd[0] === "EVAL" && cmd.includes(`nl:cm:${id}:pts`) && Array.isArray(replies[i]) ? (replies[i] as unknown[]).map((r, j) => (j === 1 ? ["?"] : r)) : replies[i]));
  }) as typeof redis.pipeline;
  is("a point write that cannot be read: unknown, never said given", await failed(() => awardPoints(id, dan, 3, store, day0)), "unknown");
  redis.pipeline = real;

  part("The copy of a person's data, and their erasure (rules 27 and 28)");
  const copy = await challengesOf(id, ada);
  is("her copy says what each challenge gave", copy.map((x) => [x.challenge, x.points]), [[c.id, 29]]);
  is("the same as challengePointsOf", challengePointsOf(c, [0, 1, 2]), 29);
  is("a challenge with no points gave none", challengePointsOf(zero.challenge, [0]), 0);
  is("an unreadable record: unknown, never 0", challengePointsOf(null, [0]), null);
  await forgetCommunityPerson(id, ada, "ada@example.com", [], store);
  const left = await pointsRecordOf(id, ada, day0 + 2 * DAY);
  // Her all-time total is what the boards and levels read; the day boards are erased for the days kept back from
  // the erasure's own clock (lib/community-points.ts forgetPointsPerson), which here is today, before these days.
  is("her points went with her", [left.total, redis.run(["ZSCORE", `nl:cm:${id}:pts`, ada])], [0, null]);

  part("What members and the creator read");
  const words = challengeWords("en");
  is("the card says what a check-in gives", words.pointsLine(3, 20), "Each check-in: 3 points. Check in on every day: 20 points more.");
  is("one point", words.pointsLine(1, 0), "Each check-in: 1 point.");
  is("only the bonus", words.pointsLine(0, 5), "Check in on every day: 5 points.");
  is("none: nothing is said", words.pointsLine(0, 0), "");
  for (const lang of ["es", "fr", "de", "it", "nl", "pt"] as const) {
    is(`${lang}: the card is translated`, words.pointsLine(3, 20) !== challengeWords(lang).pointsLine(3, 20) && challengeWords(lang).pointsLine(0, 0) === "", true);
  }
  const studio = readFileSync("components/community-challenges-studio.tsx", "utf8");
  is("the studio asks for both, with their caps", studio.includes("Points for each check-in") && studio.includes("Points for checking in on every day") && studio.includes("MAX_CHALLENGE_DAY_POINTS") && studio.includes("MAX_CHALLENGE_DONE_POINTS"), true);
  is("the studio explains a refusal", studio.includes("points:"), true);
  const studioCommunity = readFileSync("components/community-studio.tsx", "utf8");
  is("the studio's points rule names challenges", studioCommunity.includes("and the points a challenge gives for checking in"), true);
  const features = readFileSync("lib/feature-pages.ts", "utf8");
  is("the feature page says so too", features.includes("plus the points a challenge gives for checking in"), true);
  const member = readFileSync("components/community-challenges.tsx", "utf8");
  is("the members' card shows the points line", member.includes("pointsLine("), true);

  done();
}

void main();
