/**
 * A lesson marked done takes its room in the store's data room once, also when
 * Redis answers in a shape that is not its own (CX-123 rule 24).
 *
 * markLesson (lib/learn.ts) asks SISMEMBER whether the lesson is already done,
 * takes the room, then SADDs; unmarking SREMs and gives the room back. Read in
 * their exact shapes:
 *
 *   - SISMEMBER: 1 is done already (nothing taken, nothing written), 0 takes
 *     the room once; anything else (null, a reply missing from the pipeline, a
 *     string, 2, -1, a list) is unknown: nothing is taken and nothing written,
 *     and the mark fails as unknown (UnknownReplyError), so the next try reads
 *     it again instead of taking the room a second time;
 *   - SADD: 1 was written; 0 means another try wrote it first and took its own
 *     room, so this one's is given back; unknown keeps the room taken (it may
 *     be written; room is never given back on a guess) and fails as unknown,
 *     and the next try reads it as done without taking more;
 *   - SREM: 1 gives the room back, 0 gives nothing; unknown gives nothing and
 *     fails as unknown.
 *
 * Synthetic store and course; nothing leaves the test.
 */
import { emailKey, markLesson } from "@/lib/learn";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COURSE = "m".repeat(32);
const EMAIL = "learner@example.com";
const DONE = `nl:course:${COURSE}:done:${emailKey(EMAIL)}`;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** What the next command `on` answers instead of Redis's own reply; "missing" drops it from the pipeline. */
let swap: { on: string; value: unknown } | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const replies = await real(batch);
  if (!swap) return replies;
  const at = batch.findIndex((c) => c[0] === swap!.on && String(c[1]).includes(":done:"));
  if (at < 0) return replies;
  if (swap.value === "missing") return replies.slice(0, at).concat(replies.slice(at + 1));
  const out = [...replies];
  out[at] = swap.value;
  return out;
}) as typeof redis.pipeline;

const UNKNOWN: [string, unknown][] = [
  ["null", null],
  ["missing from the pipeline", "missing"],
  ["the string \"1\"", "1"],
  ["the string \"0\"", "0"],
  ["2", 2],
  ["-1", -1],
  ["a list", [1]],
];

/** The bytes the course's done lessons hold in the store's data room. */
async function held(): Promise<number> {
  const [value] = await real([["HGET", "nl:data:room-test-store", `cd:${COURSE}`]]);
  return Number(value ?? 0);
}

async function isDone(lesson: string): Promise<boolean> {
  const [value] = await real([["SMEMBERS", DONE]]);
  if (!Array.isArray(value)) throw new Error("the stub keeps done lessons elsewhere");
  return (value as string[]).includes(lesson);
}

async function outcome(run: () => Promise<void>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("The controls, with Redis's own answers");
  is("marked done: ok", await outcome(() => markLesson(COURSE, EMAIL, "lesson000001", true, ROOM)), "ok");
  const one = await held();
  is("the room is taken for it", one > 0, true);
  is("it is written", await isDone("lesson000001"), true);
  is("marked done again: ok", await outcome(() => markLesson(COURSE, EMAIL, "lesson000001", true, ROOM)), "ok");
  is("no room taken a second time", await held(), one);

  part("Already done, the 'done already?' read in another shape");
  for (const [name, value] of UNKNOWN) {
    for (const always of [false, true]) {
      swap = { on: "SISMEMBER", value };
      const said = await outcome(() => markLesson(COURSE, EMAIL, "lesson000001", true, ROOM, always));
      swap = null;
      is(`${name}${always ? " (after a quiz)" : ""}: said as unknown`, said, "unknown");
      is(`${name}${always ? " (after a quiz)" : ""}: no room taken again`, await held(), one);
    }
  }

  part("Not done yet, the 'done already?' read in another shape");
  for (const [name, value] of UNKNOWN) {
    swap = { on: "SISMEMBER", value };
    const said = await outcome(() => markLesson(COURSE, EMAIL, "lesson000002", true, ROOM));
    swap = null;
    is(`${name}: said as unknown`, said, "unknown");
    is(`${name}: nothing taken`, await held(), one);
    is(`${name}: nothing written`, await isDone("lesson000002"), false);
  }
  is("the next try, read in its own shape: ok", await outcome(() => markLesson(COURSE, EMAIL, "lesson000002", true, ROOM)), "ok");
  const two = await held();
  is("its room taken once", two - one, one);

  part("The write answered in another shape, or written first by another try");
  swap = { on: "SADD", value: 0 };
  is("SADD 0 (another try wrote it first): ok", await outcome(() => markLesson(COURSE, EMAIL, "lesson000003", true, ROOM)), "ok");
  swap = null;
  is("SADD 0: this try's room is given back", await held(), two);
  await real([["SREM", DONE, "lesson000003"]]);
  swap = { on: "SADD", value: null };
  is("SADD unknown: said as unknown", await outcome(() => markLesson(COURSE, EMAIL, "lesson000003", true, ROOM)), "unknown");
  swap = null;
  is("SADD unknown: the room stays taken, never given back on a guess", await held(), two + one);
  is("the next try reads it done and takes nothing more", await outcome(() => markLesson(COURSE, EMAIL, "lesson000003", true, ROOM)), "ok");
  is("taken once in all", await held(), two + one);

  part("Unmarked, the remove answered in another shape");
  for (const [name, value] of UNKNOWN.filter(([n]) => n !== "the string \"0\"")) {
    swap = { on: "SREM", value };
    const said = await outcome(() => markLesson(COURSE, EMAIL, "lesson000003", false, ROOM));
    swap = null;
    is(`${name}: said as unknown`, said, "unknown");
    is(`${name}: no room given back on a guess`, await held(), two + one);
    await real([["SADD", DONE, "lesson000003"]]);
  }
  is("control: unmarked with Redis's own answer: ok", await outcome(() => markLesson(COURSE, EMAIL, "lesson000003", false, ROOM)), "ok");
  is("control: its room given back", await held(), two);
  is("control: unmarked again: nothing given", await outcome(() => markLesson(COURSE, EMAIL, "lesson000003", false, ROOM)), "ok");
  is("control: still the two lessons", await held(), two);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
