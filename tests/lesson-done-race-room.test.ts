/**
 * A lesson marked done from two tabs at once takes its room in the store's data room once (lib/learn.ts markLesson).
 * Synthetic only: the in-memory Redis double, through the real lib/learn.ts.
 *
 * markLesson read SISMEMBER, took the lesson's room with needData when it was not marked, then wrote it with SADD, in
 * separate steps with no lock. Two "Mark as done" presses for the same lesson (two tabs, a double click on a slow
 * page) both read SISMEMBER 0 and both took the room, for one member of the set: the second SADD answered 0 and the
 * room it took was never given back, not even when the lesson was marked not done again (that gives back one share).
 * Each such pair left the store's data room fuller than what it keeps, which counts against the plan's storage and
 * can refuse a later write as "full". A SISMEMBER reply that did not read did the same. Now the room taken by a press
 * whose SADD added nothing is given back.
 *
 * Controls: one press takes room once, a second press later takes none, marking it not done gives it all back.
 */
import { markLesson } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "lesson-race@example.com";
const STUDENT = "student@example.com";
const COURSE = "crsrace0001";
const LESSON = "lsnrace0001";

/** Runs `cut` once, just before a lesson's SADD reaches Redis: the last moment another press can land in. */
let cut: (() => Promise<void>) | null = null;
/** Answers the next SISMEMBER with this, once: a reply that does not read. */
let garble: unknown = undefined;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (commands.some((c) => c[0] === "SADD" && String(c[1]).startsWith(`nl:course:${COURSE}:done:`)) && cut) {
    const run = cut;
    cut = null;
    await run();
  }
  if (garble !== undefined && commands.length === 1 && commands[0][0] === "SISMEMBER") {
    const reply = garble;
    garble = undefined;
    return [reply];
  }
  return real(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lessonrace", "Lesson Race", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_lessonrace", subscriptionId: "sub_lessonrace", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const used = async () => (await dataUsed(store))?.used ?? -1;

  part("Control: one press takes room once, a second press takes none, undone gives it back");
  const empty = await used();
  await markLesson(COURSE, STUDENT, LESSON, true, store);
  const one = await used();
  is("a lesson marked done takes room", one > empty, true);
  await markLesson(COURSE, STUDENT, LESSON, true, store);
  is("marking it done again takes none", await used(), one);
  await markLesson(COURSE, STUDENT, LESSON, false, store);
  is("marking it not done gives it back", await used(), empty);

  part("Two presses at once for the same lesson: its room is taken once");
  cut = async () => {
    await markLesson(COURSE, STUDENT, LESSON, true, store);
  };
  await markLesson(COURSE, STUDENT, LESSON, true, store);
  is("(the second press ran in between)", cut, null);
  is("the lesson's room is counted once, not twice", await used(), one);
  await markLesson(COURSE, STUDENT, LESSON, false, store);
  is("marked not done, the store's room is back where it was", await used(), empty);

  part("A SISMEMBER reply that does not read, on a lesson already done: no room taken for nothing");
  await markLesson(COURSE, STUDENT, LESSON, true, store);
  is("(done, counted once)", await used(), one);
  garble = null;
  await markLesson(COURSE, STUDENT, LESSON, true, store);
  is("the press whose SADD added nothing gives its room back", await used(), one);

  done();
}

void main();
