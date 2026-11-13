/**
 * A poll's tally counts each person's vote once (lib/community-polls.ts,
 * vote). The vote kept and the tally moved with it were worked out from a
 * read made before the write, so two tabs voting at the same moment both
 * read "no vote yet" and both added one: the tally said 2 for the one vote
 * kept, for good. A read of the kept vote in a shape that cannot be read
 * (CX-123 rule 24) was taken as "no vote yet" too. Now the vote is written
 * only while it is still the one read, in one step, and an unknown read
 * changes nothing.
 *
 * Real vote and pollView against tests/redis-stub.ts. Synthetic data only.
 */
import { parsePoll, pollView, vote } from "@/lib/community-polls";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COMMUNITY = "b".repeat(32);
const POST = "post000001";
const ANA = "1".repeat(32);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const original = redis.pipeline;
  const poll = parsePoll({ options: ["Mornings", "Evenings"], multi: false, ends: 0, quiet: false });
  if (!poll) throw new Error("fixture poll");
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;

  part("Two tabs vote for the same answer at once: one vote, counted once");
  redis.clear();
  await Promise.all([vote(COMMUNITY, POST, poll, ANA, ["1"], ROOM), vote(COMMUNITY, POST, poll, ANA, ["1"], ROOM)]);
  let view = await pollView(COMMUNITY, POST, poll, ANA, false);
  is("the tally holds one vote", view.total, 1);
  is("for the answer chosen", view.counts, { "1": 1 });
  const once = await used();
  await vote(COMMUNITY, POST, poll, ANA, [], ROOM);
  view = await pollView(COMMUNITY, POST, poll, ANA, false);
  is("taken back, the tally is empty", view.total, 0);
  is("and the room is all given back", await used(), 0);
  is("the vote took room", once > 0, true);

  part("Two tabs pick different answers at once: one vote, the tally matches it");
  redis.clear();
  await Promise.all([vote(COMMUNITY, POST, poll, ANA, ["1"], ROOM), vote(COMMUNITY, POST, poll, ANA, ["2"], ROOM)]);
  view = await pollView(COMMUNITY, POST, poll, ANA, false);
  is("the tally holds one vote", view.total, 1);
  is("for the answer kept", Object.keys(view.counts), view.mine);

  part("The kept vote cannot be read: nothing is counted on a guess");
  redis.clear();
  await vote(COMMUNITY, POST, poll, ANA, ["1"], ROOM);
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "HGET") return [7];
    return original.call(redis, commands);
  };
  let outcome: string;
  try {
    outcome = String(await vote(COMMUNITY, POST, poll, ANA, ["1"], ROOM));
  } catch (error) {
    outcome = error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
  is("the vote is refused as unknown", outcome, "unknown");
  view = await pollView(COMMUNITY, POST, poll, ANA, false);
  is("the tally still holds one vote", view.total, 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
