/**
 * The stores visited in a month, read exactly (rule 24; audit F2 of lib/, 12 November 2026).
 *
 * visitedFolders (lib/traffic.ts) is the list the monthly, weekly and quiet-sales jobs walk and the visits meter
 * settles from (lib/traffic-billing.ts). A reply that cannot be read is unknown: never "no store had a visit",
 * which ends each of those runs as done with nobody looked at. Checked against the real code with an in-memory
 * Redis:
 *
 *   - a readable list: the stores, sorted, without anything that is not a folder;
 *   - SMEMBERS answered as a string, null, a number, or a list holding a member that is not text: it throws.
 */
import { visitedFolders } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const realPipeline: Pipeline = redis.pipeline.bind(redis);
function membersAnswer(change: ((reply: unknown) => unknown) | null): void {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const replies = await realPipeline(commands);
    return change ? replies.map((reply, i) => (commands[i][0] === "SMEMBERS" ? change(reply) : reply)) : replies;
  };
}

async function main(): Promise<void> {
  redis.clear();
  const month = "2026-10";
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  await realPipeline([["SADD", `nl:traffic:folders:${month}`, b, a, "not a folder"]]);

  part("A readable list");
  is("the stores, sorted, without what is not a folder", await visitedFolders(month), [a, b]);

  part("A list that cannot be read");
  const cases: [string, (reply: unknown) => unknown][] = [
    ["a string", () => "OK"],
    ["null", () => null],
    ["a number", () => 2],
    ["a member that is not text", (reply) => [...(reply as unknown[]), 7]],
  ];
  for (const [what, change] of cases) {
    membersAnswer(change);
    const outcome = await visitedFolders(month).then((folders) => `returned ${JSON.stringify(folders)}`, () => "threw");
    membersAnswer(null);
    is(`${what}: unknown, never no store`, outcome, "threw");
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
