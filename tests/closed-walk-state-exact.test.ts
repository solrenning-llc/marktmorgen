/**
 * The walk that erases closed stores reads its own state exactly (rule 24/30; #4220, Codex U).
 *
 * eraseClosed (lib/closed-store-data.ts) read `HMGET nl:closed:walk cursor started phase unfinished` and turned
 * every slot that was not a string into "", then took "" as phase "idle" and cursor "0". A reply Redis never gives
 * (none, a short list, a number where a string belongs) restarted a walk in progress from the beginning: it wrote
 * "phase walk, cursor 0" over its saved place, scanned the whole database again and paid for it.
 *
 * Now a state that does not read throws UnknownReplyError before anything is scanned, deleted or written, and the
 * walk's saved phase and cursor are kept for the next run. A key Redis says is not there (four nils) is still a walk
 * that never ran. Synthetic data only, in-memory Redis.
 */
import { WALK_KEY, eraseClosed } from "@/lib/closed-store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipe = redis.pipeline.bind(redis);
/** The walk state's HMGET answered with this instead of Redis's own reply (undefined: as Redis would). */
let stateReply: { value: unknown } | undefined;
/** Every command run after the state was read, by name. */
let after: string[] = [];
/** The cursor each SCAN after the state was read started from. */
let scans: string[] = [];
let read = false;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === WALK_KEY) {
    read = true;
    if (stateReply) return stateReply.value as unknown[];
  } else if (read) {
    for (const c of commands) {
      after.push(String(c[0]));
      if (c[0] === "SCAN") scans.push(String(c[1]));
    }
  }
  return pipe(commands);
};

const saved = async () => (await pipe([["HMGET", WALK_KEY, "phase", "cursor", "started"]]))[0];
const finish = async () => {};

async function run(): Promise<string> {
  read = false;
  after = [];
  scans = [];
  try {
    await eraseClosed(Date.now() + 60_000, finish);
    return "ran";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `threw: ${(error as Error).message}`;
  }
}

async function main(): Promise<void> {
  const STARTED = String(Date.now() - 3_600_000);
  const seed = async () => {
    redis.clear();
    await pipe([["HSET", WALK_KEY, "phase", "walk", "cursor", "4242", "started", STARTED]]);
  };
  const shapes: [string, unknown][] = [
    ["no reply at all", []],
    ["a reply that is not a list", ["walk"]],
    ["a short list", [["4242", STARTED, "walk"]]],
    ["a number where the phase belongs", [["4242", STARTED, 7, null]]],
    ["a number where the cursor belongs", [[4242, STARTED, "walk", null]]],
    ["a phase no walk writes", [["4242", STARTED, "walking", null]]],
    ["a cursor that is not a number", [["4x2", STARTED, "walk", null]]],
  ];
  for (const [what, value] of shapes) {
    part(`a walk state read as ${what} is unknown, never a walk that never ran`);
    await seed();
    stateReply = { value };
    const outcome = await run();
    stateReply = undefined;
    is(`${what}: the run says it could not read its state`, outcome, "UnknownReplyError");
    is(`${what}: nothing is scanned, deleted or written after it`, after, []);
    is(`${what}: the saved phase, cursor and start are kept`, await saved(), ["walk", "4242", STARTED]);
  }

  part("control: the state as Redis gives it carries the walk on from its saved cursor");
  await seed();
  const healthy = await run();
  is("it runs", healthy, "ran");
  is("it scans from the saved cursor, never from 0", scans[0], "4242");

  part("control: no state at all (four nils) is a walk that never ran");
  redis.clear();
  is("it runs", await run(), "ran");
  done();
}

void main();
