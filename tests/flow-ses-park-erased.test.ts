/**
 * A park for room at Amazon SES is counted only while the run is there and is the run its step was taken for.
 *
 * countSesParks sent HINCRBY sesParks, HDEL waitAt and HGET sesAt, then an HSET of sesAt, with no look at the run
 * (#4246, on main): a park after the person was erased made the run's record again, with no expiry and outside the
 * run index, so nothing would ever erase it (the Defect 4083 class #4234 closes for every other write to a run); and
 * a late park of one run counted on the run the person started again (Claude 3 local's HIGH on #4234). Now one script
 * (PARK_IF_RUN) answers {-1} for both, and nothing is written. Synthetic Redis only.
 */
import { countSesParks, forgetPersonCommands, personOf } from "@/lib/flow-runs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIST = "a".repeat(32);
const FLOW = "flowsespark01";
const EMAIL = "ivy@example.com";
const run = `nl:wf:run:${FLOW}:${personOf(EMAIL)}`;
const NOW = 1_800_000_000;
const seed = (gen: string) => redis.run(["HSET", run, "email", EMAIL, "status", "running", "step", "1", "note", "", "updatedAt", String(NOW - 60), "gen", gen, "waitAt", `1:${NOW - 600}`]);

async function main(): Promise<void> {
  part("Control: a live run is counted, its day clock let go, and its first park kept");
  redis.clear();
  seed("g".repeat(32));
  const first = (await countSesParks(FLOW, [EMAIL], 1, NOW, new Map([[EMAIL, "g".repeat(32)]]))).get(EMAIL);
  const again = (await countSesParks(FLOW, [EMAIL], 1, NOW + 300, new Map([[EMAIL, "g".repeat(32)]]))).get(EMAIL);
  is("the first park counts one, from now", first, { parks: 1, since: NOW });
  is("a park again at the same step keeps its first second", again, { parks: 2, since: NOW });
  is("and the step's day clock is let go", redis.run(["HEXISTS", run, "waitAt"]), 0);

  part("A park after the person was erased makes no record again");
  for (const command of forgetPersonCommands(LIST, FLOW, personOf(EMAIL))) redis.run(command);
  const gone = (await countSesParks(FLOW, [EMAIL], 1, NOW + 600, new Map([[EMAIL, "g".repeat(32)]]))).get(EMAIL);
  is("unknown, never room for one more park", gone, null);
  is("and the run's record is not made again", redis.run(["EXISTS", run]), 0);

  part("A late park of the old run never counts on the run started again");
  seed("h".repeat(32));
  const late = (await countSesParks(FLOW, [EMAIL], 1, NOW + 900, new Map([[EMAIL, "g".repeat(32)]]))).get(EMAIL);
  is("unknown for the old run", late, null);
  is("and nothing counted on the new one", [redis.run(["HGET", run, "sesParks"]), redis.run(["HGET", run, "sesAt"])], [null, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
