/**
 * The person's data copy reads the closing's members' payments exactly (follow-up to #4454, CX-123 rule 24).
 *
 * heldPaymentsOf (lib/closing-holds.ts) feeds the copy (lib/person-copy.ts, 619 [SZ3]) from the same list as
 * paidPeriods (`nl:closing:paid:<folder>`). Before this, a reply of another shape read as no payments and a row
 * that did not parse was skipped, so the copy said the person had no payments held. Now either throws
 * UnknownReplyError, which fails the whole copy (copyPerson): it is made again, never handed over with the part
 * missing. Against the Redis stand-in only; nothing real is reached.
 */
import { heldPaymentsOf, paidKey } from "@/lib/closing-holds";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
const NOW_S = Math.floor(Date.now() / 1000);
const MEMBER = "member@example.com";
const row = (inv: string, e: string) => JSON.stringify({ inv, amt: 1500, tot: 1500, cur: "usd", ps: NOW_S - 10 * 86400, pe: NOW_S + 20 * 86400, e });

async function outcome(run: () => Promise<unknown[]>): Promise<string> {
  try {
    return `read ${(await run()).length}`;
  } catch (error) {
    return error instanceof Error && error.name === "UnknownReplyError" ? "threw" : `other: ${String(error)}`;
  }
}

async function withPaidReply(key: string, reply: unknown, run: () => Promise<unknown[]>): Promise<string> {
  redis.pipeline = async (commands: Commands) => {
    const real = await realPipeline(commands);
    return commands.map((command, i) => (command[0] === "HGETALL" && command[1] === key ? reply : real[i]));
  };
  try {
    return await outcome(run);
  } finally {
    redis.pipeline = realPipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("held-exact@example.com", "heldexact", "Held Exact", "");
  const store = await storeForEmail("held-exact@example.com");
  if (!store) throw new Error("the test store was not made");
  const key = paidKey(await storeFolder(storeRef(store)));
  const mine = () => heldPaymentsOf(store, MEMBER);

  part("Control: only the person's own rows, matched by address");
  await redis.pipeline([["HSET", key, "sub_1HeldExactMine", row("in_1Mine", "Member@Example.com")], ["HSET", key, "sub_1HeldExactOther", row("in_1Other", "other@example.com")]]);
  is("their row, not the other member's", await outcome(mine), "read 1");
  is("it names its subscription", (await mine())[0]?.subscription, "sub_1HeldExactMine");
  is("an empty list is a confirmed empty hash", await withPaidReply(key, [], mine), "read 0");

  part("Rule 24: a reply in another shape is unknown, never no payments held");
  is("a string", await withPaidReply(key, "garbled", mine), "threw");
  is("a number", await withPaidReply(key, 1, mine), "threw");
  is("an odd-length list", await withPaidReply(key, ["sub_1HeldExactMine", row("in_1Mine", MEMBER), "extra"], mine), "threw");
  is("a list holding a number", await withPaidReply(key, ["sub_1HeldExactMine", 7], mine), "threw");
  is("an object", await withPaidReply(key, { sub_1HeldExactMine: row("in_1Mine", MEMBER) }, mine), "threw");

  part("Rule 24: a row that does not read is unknown, never skipped (it may be theirs)");
  await redis.pipeline([["HSET", key, "sub_2HeldExactBroken", "{not json"]]);
  is("a row that is not JSON", await outcome(mine), "threw");
  await redis.pipeline([["HSET", key, "sub_2HeldExactBroken", JSON.stringify({ inv: "in_2", amt: 900, cur: "usd" })]]);
  is("a row without its period or address", await outcome(mine), "threw");
  await redis.pipeline([["HDEL", key, "sub_2HeldExactBroken"], ["HSET", key, "not-a-sub", row("in_3", MEMBER)]]);
  is("a field that is not a subscription id", await outcome(mine), "threw");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
