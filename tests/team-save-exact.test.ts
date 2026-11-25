/**
 * A team's record is kept only on an exact "OK" (CX-123 rule 24; #4188, Codex G, HIGH). saveTeam sent its SET and
 * never read the answer, so setRequireTwoStep logged "Required two-step sign-in for the team" and answered true while
 * the record could still have the rule off, and a teammate who signs in by the emailed link was let in although the
 * owner was told a second step is required. Now an answer that is not exactly one "OK" throws UnknownReplyError, and
 * nothing is said as done. Controls: an exact answer keeps the rule; the stand-in's own SET still writes.
 * Synthetic store, in-memory Redis (tests/redis-stub.ts), answers bent on purpose.
 */
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { putMember, readTeam, setRequireTwoStep } from "@/lib/team";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);

/** The team record's SET answered `answer` (and not written), while `work` runs. */
async function setAnswered<T>(sid: string, answer: unknown[], work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) =>
    commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === `nl:team:${sid}` ? answer : original(commands)) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const logLines = async (sid: string) => ((await original([["LRANGE", `nl:team:log:${sid}`, 0, -1]])) as [unknown[]])[0]?.length ?? 0;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner@team-save.example";
  await claimHandle(OWNER, "team-save-exact", "Team Save Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  await putMember(store, "mate@team-save.example", "editor");

  part("The owner turns on two-step sign-in for the team; the record's write answers in another shape");
  for (const [label, answer] of [["no reply", []], ["null", [null]], ["two replies", ["OK", "OK"]], ["an error text", ["ERR"]], ["1", [1]]] as [string, unknown[]][]) {
    const before = await logLines(store.sid);
    const outcome = await setAnswered(store.sid, answer, () => setRequireTwoStep(store, true, OWNER)).then(
      (value) => ({ value }),
      (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : String(error)),
    );
    is(`${label}: unknown, never "done"`, outcome, "unknown");
    is(`${label}: nothing logged as required, and the rule is still off`, [await logLines(store.sid) - before, (await readTeam(store.sid)).requireTwoStep === true], [0, false]);
  }

  part("Control: an exact answer");
  is("turned on, and read back on", [await setRequireTwoStep(store, true, OWNER), (await readTeam(store.sid)).requireTwoStep], [true, true]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
