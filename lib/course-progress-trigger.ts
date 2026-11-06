/**
 * "Reaches a share of a course" as a workflow trigger (287 [H4-1]; added
 * 6 November 2026): what starts the workflows that start on it (lib/flows.ts,
 * trigger "progress") when a student has done at least the share of a
 * course's lessons the creator chose (PROGRESS_PERCENTS: a tenth, a quarter,
 * half, three quarters, nine tenths), so a creator can, say, offer coaching
 * to whoever is three quarters through.
 *
 * Progress is only what the server recorded: lessons marked done by a
 * button, by a quiz passed or by work approved. Each of those reaches
 * lib/course-finish.ts (noteIfFinished), which calls this before it checks
 * for the last lesson, so no route has a call of its own. Watching a video
 * to its end is not counted here (102 [E2-COURSE-COMPLIANCE] measures that,
 * and marks the lesson done when it does).
 *
 * Once per person per course per share: a hash of the shares a student
 * reached, one field each (HSETNX), kept 400 days like the finish mark, so a
 * lesson marked undone and done again starts nothing twice; and each workflow
 * starts once per person besides (lib/flows.ts, enroll's claim). Only the
 * shares a switched-on workflow of this course waits for are marked, so a
 * workflow added later still starts for whoever reaches its share after.
 * Only for somebody on the list who agreed to hear from the creator
 * (lib/flows.ts, enroll): reaching a share never puts anybody on the list.
 * The emails go out through the sequence's own sending, each taken from the
 * store's email allowance before it is sent.
 *
 * Unknown is never "reached": a reply of another shape from the workflows,
 * the lessons done or the mark starts nothing ("not_checked").
 *
 * What it costs: on a plan with workflows, one of the store's public
 * requests (PROGRESS_TRIGGER_UNITS, as a buyer's) is taken first, for every
 * lesson marked done, even when no workflow waits for a share: a bound on
 * the cost. The lessons are read and the mark written only when a workflow
 * of this course waits for a share; a run it starts counts in the day's runs
 * like every other (lib/flow-limits.ts). On a plan without workflows nothing
 * is read.
 *
 *   nl:course:<courseId>:pct:<student>   hash, share → "1", 400 days
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { emailKey } from "@/lib/learn";
import { activeFlowLimit, startableFlows } from "@/lib/flow-limits";
import { readFlowListStrict } from "@/lib/flow-list";
import { PROGRESS_PERCENTS } from "@/lib/flow-rules";
import { enroll } from "@/lib/flows";
import { exactReplies, plainList, UnknownReply } from "@/lib/redis-exact";
import type { Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";

/** Public requests a lesson marked done takes for checking the workflows a share may start. */
export const PROGRESS_TRIGGER_UNITS = 1;

const KEEP_SECONDS = 400 * 86_400;
const progressKey = (courseId: string, email: string) => `nl:course:${courseId}:pct:${emailKey(email)}`;
/** The lessons a student marked done: the set lib/learn.ts writes (markLesson), read here exactly. */
const doneKey = (courseId: string, email: string) => `nl:course:${courseId}:done:${emailKey(email)}`;

export type ProgressTrigger = { state: "none" | "checked" | "not_checked"; milestones: number[] };

/** The lessons done, exactly: one reply, a real list of strings; anything else is unknown. */
function doneOf(replies: unknown): Set<string> {
  const [raw] = exactReplies(replies, 1, "a student's lessons done");
  const list = plainList(raw);
  if (!list || !list.every((id) => typeof id === "string")) throw new UnknownReply("a student's lessons done");
  return new Set(list as string[]);
}

/**
 * After a lesson is marked done: starts the workflows of this course waiting
 * for a share the student has now reached, the first time they reach it.
 * `lessons` are the course's lessons, in order. Never throws.
 */
export async function noteProgress(store: Store, productId: string, courseId: string, email: string, lessons: readonly string[]): Promise<ProgressTrigger> {
  if (!email || !lessons.length || !store.listId || activeFlowLimit(store) === 0 || !isRedisConfigured()) return { state: "none", milestones: [] };
  try {
    if (!(await takePublicRequest(store, "buyer", Date.now(), PROGRESS_TRIGGER_UNITS))) {
      // The store's requests are used for now: the lesson stands, and no workflow starts for it.
      console.warn("a course share's workflows were not checked: no public request left");
      return { state: "not_checked", milestones: [] };
    }
    const flows = startableFlows(await readFlowListStrict(store.listId), activeFlowLimit(store));
    const waiting = [...new Set(flows.filter((f) => f.active && f.steps.length > 0 && f.trigger === "progress" && f.productId === productId && typeof f.percent === "number" && PROGRESS_PERCENTS.includes(f.percent)).map((f) => f.percent as number))].sort((a, b) => a - b);
    if (!waiting.length) return { state: "checked", milestones: [] };
    const done = doneOf(await redisPipeline([["SMEMBERS", doneKey(courseId, email)]]));
    const count = lessons.filter((id) => done.has(id)).length;
    // Reached when done / lessons >= share / 100, in whole numbers.
    const reached = waiting.filter((share) => count * 100 >= share * lessons.length);
    if (!reached.length) return { state: "checked", milestones: [] };
    const key = progressKey(courseId, email);
    const replies = exactReplies(await redisPipeline([...reached.map((share) => ["HSETNX", key, String(share), "1"]), ["EXPIRE", key, KEEP_SECONDS]]), reached.length + 1, "a student's course share marks");
    // Every claim a 0 or a 1, and the mark kept for its time: otherwise nothing is known to be new.
    if (replies.slice(0, -1).some((r) => r !== 0 && r !== 1) || replies.at(-1) !== 1) throw new UnknownReply("a student's course share marks");
    const fresh = reached.filter((_, i) => replies[i] === 1);
    if (fresh.length) await enroll(store, email, { joined: false, progress: { productId, percents: fresh } });
    return { state: "checked", milestones: fresh };
  } catch (error) {
    console.error("checking a course share's workflows failed", error);
    return { state: "not_checked", milestones: [] };
  }
}

/** Forgets the shares one person reached in these courses (lib/person-erasure.ts). */
export async function forgetProgressPerson(courseIds: string[], email: string): Promise<number> {
  if (!courseIds.length || !isRedisConfigured()) return 0;
  const what = "the deletion of a person's course share marks";
  const keys = [...new Set(courseIds.map((courseId) => progressKey(courseId, email)))];
  const [gone] = exactReplies(await redisPipeline([["DEL", ...keys]]), 1, what);
  if (typeof gone !== "number" || !Number.isSafeInteger(gone) || gone < 0 || gone > keys.length) throw new UnknownReply(what);
  return gone;
}
