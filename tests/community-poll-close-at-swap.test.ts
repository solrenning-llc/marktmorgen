/**
 * A poll vote checked against the poll's close at the swap itself (Codex L's LEVE on #4006), and the swap refused when
 * the member's record changed between the read and the write (Claude 3's LOW on #4006). Synthetic only: the in-memory
 * Redis double, through the real lib/community-polls.ts.
 *
 * vote checked the close once, before waiting on the member's lock. A vote that passed that check and then waited, or
 * read the record again, could land after the close and move the count people had already read. The close is now
 * checked inside POLL_VOTE_SWAP, on Redis's own clock, on every try: past it nothing is written, the room the vote took
 * goes back and vote answers false.
 *
 * The refused swap (0) had no test: the parallel-vote test passes with the member's lock alone. Here the record is
 * changed by hand right before the first swap, so the vote reads again and ends with the right tally, record and room;
 * a record that changes before every swap throws after the five tries and leaves the tally and the room as they were.
 *
 * Controls: a poll with no close (0) and a poll still open take the vote as before.
 */
import { POLL_VOTE_SWAP, vote, type Poll } from "@/lib/community-polls";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const ID = "pollclose";
const WHO = "mmmmmmmmmmmm";
const OTHER = "oooooooooooo";
const OPTIONS = [{ id: "1", text: "Yes" }, { id: "2", text: "No" }];
const now = () => Math.floor(Date.now() / 1000);
const poll = (ends: number): Poll => ({ options: OPTIONS, multi: false, ends, quiet: false });

const tally = async (post: string) => (await redis.pipeline([["HGETALL", `nl:cm:${ID}:pc:${post}`]]))[0];
const mine = async (post: string, who = WHO) => (await redis.pipeline([["HGET", `nl:cm:${ID}:pv:${post}`, who]]))[0];
const used = async () => (await dataUsed(ROOM))?.used ?? -1;

type Pipeline = typeof redis.pipeline;
const real: Pipeline = redis.pipeline.bind(redis);
let swaps = 0;
/** Runs `before` right before each vote swap reaches the double; the swaps are counted. */
function beforeSwap(before: () => Promise<void> | void): void {
  swaps = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((command) => command[0] === "EVAL" && command[1] === POLL_VOTE_SWAP)) {
      swaps += 1;
      await before();
    }
    return real(commands);
  }) as Pipeline;
}
const plain = () => {
  redis.pipeline = real;
};

async function main() {
  part("a vote whose poll closes before its swap is not counted, and its room goes back");
  const empty = await used();
  const ends = now() + 60;
  beforeSwap(() => redis.advance(120_000));
  const late = await vote(ID, "p1", poll(ends), WHO, ["1"], ROOM);
  plain();
  is("vote answers false (closed)", late, false);
  is("one swap was tried", swaps, 1);
  is("the tally is untouched", await tally("p1"), []);
  is("no vote is kept for the member", await mine("p1"), null);
  is("the room the vote took is given back", await used(), empty);

  part("a change after the close is refused at the swap too, and the earlier vote stays");
  // Redis's clock is already 2 minutes ahead (the part above); this poll closes in 10 minutes, then the clock passes it.
  const open = now() + 600;
  is("a vote while open is counted", await vote(ID, "p2", poll(open), WHO, ["1"], ROOM), true);
  const voted = await used();
  beforeSwap(() => redis.advance(1_200_000));
  const change = await vote(ID, "p2", poll(open), WHO, ["2"], ROOM);
  plain();
  is("the late change answers false", change, false);
  is("the tally still holds the vote cast while open", await tally("p2"), ["1", "1"]);
  is("the member's vote is still option 1", await mine("p2"), "1");
  is("the room is as it was after the first vote", await used(), voted);

  part("a record changed between the read and the swap is read again, and counted once");
  const before = await used();
  let once = true;
  beforeSwap(async () => {
    if (!once) return;
    once = false;
    await real([["HSET", `nl:cm:${ID}:pv:p3`, WHO, "2"], ["HINCRBY", `nl:cm:${ID}:pc:p3`, "2", 1]]);
  });
  const again = await vote(ID, "p3", poll(0), WHO, ["1"], ROOM);
  plain();
  is("vote answers true", again, true);
  is("the swap ran twice: refused, then written over what was read again", swaps, 2);
  is("the tally moved from option 2 to option 1, once", await tally("p3"), ["2", "0", "1", "1"]);
  is("the member's vote is option 1", await mine("p3"), "1");
  is("what the refused try took went back (the vote read again is the same size and takes none)", await used(), before);

  part("a record that changes before every swap throws after the five tries, and nothing is counted");
  const start = await used();
  let n = 0;
  beforeSwap(async () => {
    n += 1;
    // Never the vote being cast, so every try reads a record that has changed again by its swap.
    await real([n % 2 ? ["HSET", `nl:cm:${ID}:pv:p5`, WHO, "2"] : ["HDEL", `nl:cm:${ID}:pv:p5`, WHO]]);
  });
  const threw = await vote(ID, "p5", poll(0), WHO, ["1"], ROOM).then(() => false, () => true);
  plain();
  is("vote throws", threw, true);
  is("five swaps were tried", swaps, 5);
  is("the tally is untouched", await tally("p5"), []);
  is("the room is as it was", await used(), start);

  part("controls: no close, and a poll still open, take the vote as before");
  is("a poll with no close", await vote(ID, "p6", poll(0), OTHER, ["2"], ROOM), true);
  is("its tally", await tally("p6"), ["2", "1"]);
  is("a poll closing in an hour", await vote(ID, "p7", poll(now() + 3_600), OTHER, ["1"], ROOM), true);
  is("its tally", await tally("p7"), ["1", "1"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
