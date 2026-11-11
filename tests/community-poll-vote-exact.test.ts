/**
 * Claude 3 (cloud A), CX-123 rule 24 (lib/community-polls.ts vote): a
 * member's earlier vote is "none" only for Redis's null (no field) or the
 * empty string. A crooked HGET reply once read as no vote: the new choice was
 * counted again and the old one never taken off, so the tally grew by a vote
 * nobody cast. Now such a reply throws UnknownReplyError (the community
 * route answers "error"), with the tally and the vote untouched.
 */
import { vote } from "@/lib/community-polls";
import type { Poll } from "@/lib/community-polls";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const ID = "d".repeat(32);
const POST = "p1";
const WHO = "w".repeat(32);
const votes = `nl:cm:${ID}:pv:${POST}`;
const tally = `nl:cm:${ID}:pc:${POST}`;
const POLL: Poll = { options: [{ id: "0", text: "Yes" }, { id: "1", text: "No" }] as Poll["options"], multi: false, ends: 0, quiet: false };

const real = redis.pipeline.bind(redis);
let bend: unknown = undefined;
let bending = false;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return bending ? values.map((v, i) => (batch[i][0] === "HGET" && batch[i][1] === votes ? bend : v)) : values;
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    return `returned ${JSON.stringify(await run())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : (error as Error).name;
  }
}
const counts = async () => (await real([["HGETALL", tally]]))[0];
const mine = async () => (await real([["HGET", votes, WHO]]))[0];

async function main(): Promise<void> {
  redis.clear();

  part("Control: a vote, a change and a take-back keep the tally right");
  is("vote Yes", await vote(ID, POST, POLL, WHO, ["0"], ROOM), true);
  is("change to No", await vote(ID, POST, POLL, WHO, ["1"], ROOM), true);
  is("tally: one No, Yes back to zero", await counts(), ["0", "0", "1", "1"]);

  part("A crooked HGET of the earlier vote: unknown, never 'no vote yet'");
  for (const [what, reply] of [["a number", 7], ["an object", { a: 1 }], ["a list", ["1"]], ["true", true]] as [string, unknown][]) {
    const before = [await counts(), await mine()];
    bend = reply;
    bending = true;
    const got = await outcome(() => vote(ID, POST, POLL, WHO, ["1"], ROOM));
    bending = false;
    is(`HGET answered ${what}: unknown`, got, "unknown");
    is(`HGET answered ${what}: tally and vote untouched`, [await counts(), await mine()], before);
  }

  part("The empty string is still no vote");
  await real([["HSET", votes, WHO, ""], ["DEL", tally]]);
  is("a vote over an empty record counts once", await vote(ID, POST, POLL, WHO, ["0"], ROOM), true);
  is("tally: one Yes", await counts(), ["0", "1"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
