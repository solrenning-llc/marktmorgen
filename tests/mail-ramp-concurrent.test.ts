/**
 * Issue #4134 (Codex T, email safety; Claude 6 block of the coordinator's split, 5437): rampRoom (lib/mail-health.ts)
 * read a store's open portion with a GET and wrote what was left with a plain SET. Two senders at once (the mail job's
 * list email and the imports job's welcome mail run under different locks) could both read the same `left` and each be
 * granted it, so an imported list's first portion of 100 went out as 200. A give-back (rampBack) racing a take wrote
 * over it the same way, putting back capacity already handed out.
 *
 * Now both write only over the very record they read (mail-ramp-swap), reading again when it changed; a write that
 * keeps losing grants nothing. Checked with both reads held until each has read: the grants never pass the portion,
 * and a give-back racing a take keeps the take. Synthetic store id; the in-memory Redis.
 */
import { RAMP_TRIES, rampBack, rampRoom, startRamp } from "@/lib/mail-health";
import { RAMP_FIRST, RAMP_LAST, RAMP_TRIGGER } from "@/lib/mail-health-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ||= "https://redis.example.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN ||= "test-token";

const ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const KEY = `nl:mail:ramp:${ID}`;
const real = redis.pipeline.bind(redis);
/** While set, every GET of the ramp waits until this many have read: two senders reading the same record. */
let gather = 0;
let reads = 0;
let wake: () => void = () => {};
let allRead = Promise.resolve();
/** While set, every swap of the ramp answers 0 (the record changed since it was read), and each round is counted. */
let losing = false;
let rounds = { gets: 0, swaps: 0 };
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (losing && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY) rounds.gets += 1;
  if (losing && commands.length === 1 && commands[0][0] === "EVAL" && commands[0][3] === KEY) {
    rounds.swaps += 1;
    return [0];
  }
  const answer = await real(commands);
  if (gather && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY) {
    reads += 1;
    if (reads >= gather) wake();
    else await allRead;
  }
  return answer;
}) as typeof redis.pipeline;
function holdReads(n: number) {
  gather = n;
  reads = 0;
  allRead = new Promise<void>((resolve) => (wake = resolve));
}
const left = () => (JSON.parse(String(redis.run(["GET", KEY]))) as { left: number }).left;

async function main(): Promise<void> {
  part("Two senders take from the same open portion at once: never more than it holds");
  redis.clear();
  await startRamp(ID, RAMP_TRIGGER);
  is("setup: the first portion is open", left(), RAMP_FIRST);
  holdReads(2);
  const both = await Promise.all([rampRoom(ID, RAMP_FIRST), rampRoom(ID, RAMP_FIRST)]);
  gather = 0;
  is(`granted ${both.join(" + ")}, never more than the ${RAMP_FIRST} the portion holds`, both[0] + both[1] <= RAMP_FIRST, true);
  is("and the whole portion is taken once", both[0] + both[1], RAMP_FIRST);
  is("nothing is left", left(), 0);

  part("A give-back racing a take keeps the take");
  redis.clear();
  await startRamp(ID, RAMP_TRIGGER);
  is("setup: 60 taken", await rampRoom(ID, 60), 60);
  holdReads(2);
  const [taken] = await Promise.all([rampRoom(ID, 40), rampBack(ID, 60)]);
  gather = 0;
  is("the take is granted", taken, 40);
  is("what is left is the portion less what is still out: 100 - 40, never the whole portion again", left(), RAMP_FIRST - 40);

  part("A swap that keeps losing (Claude 3 xvBY8's LEVE on #5463): nothing granted or given back, and never past RAMP_TRIES rounds");
  redis.clear();
  await startRamp(ID, RAMP_TRIGGER);
  // 60 taken first, so what is left (40) is below the portion and a give-back that wrote anything would show
  // (Claude 3's LEVE on 34f9536a1a: with the portion full, min(size, left + n) hid any write).
  is("setup: 60 taken", await rampRoom(ID, 60), 60);
  const record = redis.run(["GET", KEY]);
  losing = true;
  rounds = { gets: 0, swaps: 0 };
  is("a take whose every swap answers 0 is granted nothing", await rampRoom(ID, 40), 0);
  is(`in exactly RAMP_TRIES (${RAMP_TRIES}) rounds of a read and a swap, the bound the cost line prices`, rounds, { gets: RAMP_TRIES, swaps: RAMP_TRIES });
  is("and the record is as it was", redis.run(["GET", KEY]), record);
  rounds = { gets: 0, swaps: 0 };
  await rampBack(ID, 40);
  is(`a give-back whose every swap answers 0 stops after RAMP_TRIES (${RAMP_TRIES}) rounds`, rounds, { gets: RAMP_TRIES, swaps: RAMP_TRIES });
  losing = false;
  is("and leaves what is left as it was, 40 (the capacity stays taken, the safe way)", left(), RAMP_FIRST - 60);
  is("and the record is still as it was", redis.run(["GET", KEY]), record);

  part("A finished final portion is cleared only while it is the record read (Claude 3 xvBY8's LEVE on #5463)");
  redis.clear();
  const finished = JSON.stringify({ size: RAMP_LAST, left: 0, opens: 0 });
  redis.run(["SET", KEY, finished]);
  let importedMeanwhile = false;
  const plain = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The clean-up, as a plain DEL (before) or as the swap to "" (now).
    const cleanUp = commands.length === 1 && ((commands[0][0] === "DEL" && commands[0][1] === KEY) || (commands[0][0] === "EVAL" && commands[0][3] === KEY && commands[0][5] === ""));
    if (!importedMeanwhile && cleanUp) {
      importedMeanwhile = true;
      // An import's startRamp, between the read of the finished portion and its clean-up.
      await startRamp(ID, RAMP_TRIGGER);
    }
    return plain(commands);
  }) as typeof redis.pipeline;
  const afterImport = await rampRoom(ID, 5_000);
  redis.pipeline = plain;
  is("(the import came in between the read and the clean-up)", importedMeanwhile, true);
  is("the send is held to the new import's first portion, never the whole list", afterImport, RAMP_FIRST);
  const keptRamp = JSON.parse(String(redis.run(["GET", KEY]))) as { size: number; left: number };
  is("and the new portions are kept, the first one taken", [keptRamp.size, keptRamp.left], [RAMP_FIRST, 0]);
  redis.clear();
  redis.run(["SET", KEY, finished]);
  is("control: a finished final portion alone is cleared and the send goes whole", [await rampRoom(ID, 5_000), redis.run(["GET", KEY])], [5_000, null]);

  part("Control: one sender alone, as before");
  redis.clear();
  await startRamp(ID, RAMP_TRIGGER);
  is("a hundred first", await rampRoom(ID, 5_000), RAMP_FIRST);
  is("then nobody until the next portion opens", await rampRoom(ID, 5_000), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
