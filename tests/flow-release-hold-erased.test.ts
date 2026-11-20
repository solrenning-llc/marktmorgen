/**
 * The creator's choice on a held run never brings an erased person's run back.
 *
 * releaseHold read `open`, then cleared it, then wrote the choice in a third round trip: a person erased between the
 * clear and the writes had their run's record (running, 400 days), its index entry and a one-event history made
 * again, and resolveHeldRun would then queue the erased address (Claude 3 local's MEDIUM on #4234). Now one script
 * (RELEASE_IF_OPEN) checks the exact `open` and writes the choice in the same step. Synthetic Redis only.
 */
import { forgetPersonCommands, personOf, releaseHold } from "@/lib/flow-runs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIST = "b".repeat(32);
const FLOW = "flowreleasehold1";
const EMAIL = "oak@example.com";
const person = personOf(EMAIL);
const run = `nl:wf:run:${FLOW}:${person}`;
const log = `nl:wf:log:${FLOW}:${person}`;
const index = `nl:wf:runs:${FLOW}`;
const held = `nl:wf:held:${LIST}`;
const OPEN = `1:${"s".repeat(16)}:${"t".repeat(32)}`;
const NOW = 1_800_000_000;
const seed = () => {
  redis.run(["HSET", run, "email", EMAIL, "status", "held", "step", "1", "note", "", "updatedAt", String(NOW - 60), "gen", "g".repeat(32), "open", OPEN]);
  redis.run(["RPUSH", log, JSON.stringify({ at: NOW - 60, step: 1, stepId: "s".repeat(16), kind: "email", state: "attempted", note: "" })]);
  redis.run(["ZADD", index, String(NOW - 60), person]);
  redis.run(["ZADD", held, String(NOW - 60), `${FLOW}|${person}`]);
};
const traces = () => [redis.run(["EXISTS", run]), redis.run(["EXISTS", log]), redis.run(["ZSCORE", index, person]), redis.run(["ZSCORE", held, `${FLOW}|${person}`])];

async function main(): Promise<void> {
  part("Control: the hold is released once, with the choice written");
  redis.clear();
  seed();
  is("released", await releaseHold(LIST, FLOW, person, OPEN, "You chose to go on.", "running", 2, NOW), true);
  is("the choice is written and the hold let go", [redis.run(["HGET", run, "status"]), redis.run(["HGET", run, "step"]), redis.run(["HEXISTS", run, "open"]), redis.run(["ZSCORE", held, `${FLOW}|${person}`])], ["running", "2", 0, null]);
  is("a second caller with the same hold finds it taken", await releaseHold(LIST, FLOW, person, OPEN, "Again.", "running", 2, NOW), false);

  part("The person erased right after the hold is taken: nothing comes back");
  redis.clear();
  seed();
  const real = redis.pipeline.bind(redis);
  let erased = false;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const replies = await real(batch);
    // Right after the first write that takes the hold (the HDEL of `open`, or the script that does it with the rest).
    if (!erased && batch.some((c) => (c[0] === "HDEL" || c[0] === "EVAL") && c.includes(run))) {
      erased = true;
      await real(forgetPersonCommands(LIST, FLOW, person));
    }
    return replies;
  }) as typeof redis.pipeline;
  try {
    await releaseHold(LIST, FLOW, person, OPEN, "You chose to go on.", "running", 2, NOW);
  } finally {
    redis.pipeline = real as typeof redis.pipeline;
  }
  is("the erasure ran in the middle", erased, true);
  is("no record, no history, no index entry and no held entry", traces(), [0, 0, null, null]);

  part("A run erased before the choice: refused, nothing written");
  redis.clear();
  seed();
  for (const command of forgetPersonCommands(LIST, FLOW, person)) redis.run(command);
  redis.run(["DEL", log]);
  is("refused", await releaseHold(LIST, FLOW, person, OPEN, "You chose to go on.", "running", 2, NOW), false);
  is("and nothing is made again", traces(), [0, 0, null, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
