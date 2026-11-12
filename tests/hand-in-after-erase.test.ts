/**
 * A first hand-in whose person was erased between its read and its write
 * (Codex L's MEDIUM, reported in the coordination channel as Defect 4034;
 * lib/assignment.ts handIn and forgetTasksPerson). handIn reads the work
 * (none yet: ""), the person is erased (forgetTasksPerson deletes their work,
 * its places in the lists and its files), and then the conditional write
 * HAND_IN_WRITE_IF compares "" with "" and writes: the student's text, their
 * file and their places in the creator's lists come back after an erasure
 * said to be complete. The hand-in runs, as the route runs it, inside
 * oneHandInAtATime with that lock's token; the erasure takes the lock away
 * first and the write is made only while the lock is still the hand-in's, so
 * a hand-in that began before an erasure writes nothing (HandInChangedError,
 * whose file the route deletes), and one that begins after it is written as
 * always. Nothing is left behind that names the student. Synthetic in-memory
 * Redis only.
 */
import { HandInChangedError, forgetTasksPerson, handIn, oneHandInAtATime, submissionOf } from "@/lib/assignment";
import type { Task } from "@/lib/assignment-rules";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { ROOM as DATA } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
const COURSE = "c".repeat(12);
const LESSON = "l".repeat(12);
const WHO = "a".repeat(32);
const ROOM = "erase-room";
const TASK: Task = { prompt: "Write an essay.", review: true, gate: false, file: true };
const sub = `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`;
const filesKey = `nl:course:${COURSE}:task:${LESSON}:files`;
const waiting = `nl:course:${COURSE}:tasks:waiting`;
const all = `nl:course:${COURSE}:tasks:all`;
const member = `${LESSON}|${WHO}`;

const file = { path: `uploads/${WHO}/essay.pdf`, name: "essay.pdf", bytes: 100, type: "application/pdf" };

/** A hand-in as the route makes it (app/api/store/course/task/route.ts): under its lock, with the lock's token. */
const handInLocked = (text: string, withFile: boolean) =>
  oneHandInAtATime(COURSE, LESSON, WHO, (lock) => handIn({ data: DATA, courseId: COURSE, lessonId: LESSON, who: WHO, email: "", task: TASK, text, file: withFile ? file : null, lock }));

const real = redis.pipeline.bind(redis);
let beforeWrite: (() => Promise<void>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (beforeWrite && batch.some((c) => c[0] === "EVAL" && String(c[1]).includes("marktmorgen:hand-in-write-if"))) {
    const run = beforeWrite;
    beforeWrite = null;
    await run();
  }
  return real(batch);
}) as typeof redis.pipeline;

async function left() {
  const [work, file, inWaiting, inAll] = (await redisPipeline([
    ["GET", sub],
    ["HGET", filesKey, `uploads/${WHO}/essay.pdf`],
    ["ZSCORE", waiting, member],
    ["ZSCORE", all, member],
  ])) as unknown[];
  return { work: work !== null, file: file !== null, waiting: inWaiting !== null, all: inAll !== null };
}

const nothing = { work: false, file: false, waiting: false, all: false };

async function main(): Promise<void> {
  redis.clear();

  part("A first hand-in read before an erasure and written after it writes nothing");
  beforeWrite = async () => {
    await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM);
  };
  const raced = await handInLocked("My essay.", true).then(
    () => "written",
    (error: unknown) => (error instanceof HandInChangedError ? "changed" : `threw ${String(error)}`),
  );
  is("the hand-in is refused as changed meanwhile, so the route deletes its file", raced, "changed");
  is("no work, file entry or place in the creator's lists comes back", await left(), nothing);

  part("A hand-in again after the erasure is written as always");
  const again = await handInLocked("My essay, again.", true);
  is("written and waiting for the creator", [again.state, (await submissionOf(COURSE, LESSON, WHO))?.text, await left()], [
    "waiting",
    "My essay, again.",
    { work: true, file: true, waiting: true, all: true },
  ]);

  part("A hand-in over earlier work, read before an erasure, writes nothing either");
  beforeWrite = async () => {
    await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM);
  };
  const over = await handInLocked("Third try.", false).then(
    () => "written",
    (error: unknown) => (error instanceof HandInChangedError ? "changed" : `threw ${String(error)}`),
  );
  is("refused as changed", over, "changed");
  is("and nothing comes back", await left(), nothing);
  is("the erasure leaves no key of its own that names the student (the lock it took away is gone)", (await redisPipeline([["EXISTS", `${sub}:lock`]]))[0], 0);

  done();
}

void main();
