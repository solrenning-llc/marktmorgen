/**
 * Claude 3 (cloud A), CX-123 rule 24 (lib/community-polls.ts vote): a
 * member's earlier vote is "none" only for Redis's null (no field) or the
 * empty string. A crooked HGET reply once read as no vote: the new choice was
 * counted again and the old one never taken off, so the tally grew by a vote
 * nobody cast. Now such a reply throws UnknownReplyError (the community
 * route answers "error"), with the tally and the vote untouched.
 */
import { vote, votesOf } from "@/lib/community-polls";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { readFileSync } from "node:fs";
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

  part("Concurrent votes from one member count once (Claude 1 cloud on #3820)");
  await real([["DEL", votes], ["DEL", tally]]);
  const together = await Promise.all([1, 2, 3].map(() => outcome(() => vote(ID, POST, POLL, WHO, ["0"], ROOM))));
  is("each burst vote either counted or refused as busy, never counted twice", together.every((one) => one === "returned true" || one === "LockBusyError"), true);
  is("tally after a burst: one Yes", await counts(), ["0", "1"]);
  is("the member's vote is Yes", await mine(), "0");

  part("An unproven lock answer: refused, nothing written");
  await real([["DEL", votes], ["DEL", tally]]);
  const wrapped = redis.pipeline;
  redis.pipeline = (async (batch: Command[]) => {
    if (batch[0]?.[0] === "SET" && String(batch[0][1]).includes(":pl:")) return [["QUEUED"]];
    return real(batch);
  }) as typeof redis.pipeline;
  const odd = await outcome(() => vote(ID, POST, POLL, WHO, ["0"], ROOM));
  redis.pipeline = wrapped;
  is("lock answered in an odd shape: busy", odd, "LockBusyError");
  is("lock answered in an odd shape: tally and vote untouched", [await counts(), await mine()], [[], null]);

  part("The empty string is still no vote");
  await real([["HSET", votes, WHO, ""], ["DEL", tally]]);
  is("a vote over an empty record counts once", await vote(ID, POST, POLL, WHO, ["0"], ROOM), true);
  is("tally: one Yes", await counts(), ["0", "1"]);

  part("votesOf, which feeds the person's data copy, reads each vote exactly (Claude 1's LEVE on #3820)");
  await real([["DEL", votes], ["DEL", tally]]);
  is("control: a cast vote is in the copy", (await vote(ID, POST, POLL, WHO, ["1"], ROOM), await votesOf(ID, WHO, [POST])), [{ post: POST, picked: ["1"] }]);
  is("control: no vote is no entry", await votesOf(ID, WHO, ["p2"]), []);
  for (const [what, reply] of [["a number", 7], ["an object", { a: 1 }], ["true", true]] as [string, unknown][]) {
    bend = reply;
    bending = true;
    const got = await outcome(() => votesOf(ID, WHO, [POST]));
    bending = false;
    is(`HGET answered ${what}: unknown, never left out of the copy`, got, "unknown");
  }
  const whole = redis.pipeline;
  redis.pipeline = (async (batch: Command[]) => (batch[0]?.[0] === "HGET" && batch[0][1] === votes ? [] : real(batch))) as typeof redis.pipeline;
  const short = await outcome(() => votesOf(ID, WHO, [POST]));
  redis.pipeline = whole;
  is("a pipeline with no reply for it: unknown", short, "unknown");

  part("A busy or unconfirmed vote tells the member so (Claude 1 cloud's LEVE on #3820)");
  const route = readFileSync("app/api/store/community/route.ts", "utf8");
  const voting = route.slice(route.indexOf('if (action === "vote")'), route.indexOf('if (action === "vote")') + 900);
  is("the vote's busy and unknown answers come back as their own notice", /LockBusyError[\s\S]*UnknownReplyError[\s\S]*"votebusy"/.test(voting), true);
  for (const [language, words] of Object.entries(COMMUNITY_WORDS)) {
    const notice = (words as { notices?: Record<string, string> }).notices?.votebusy ?? "";
    is(`${language}: the notice has words`, notice.length > 20, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
