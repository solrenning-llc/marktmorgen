/**
 * A vote taken back after the member's trace is already gone gives back only the vote's own room (#4006 merge with
 * main, Codex X4's MEDIUM). Synthetic only: the in-memory Redis double, through the real lib/community-polls.ts.
 *
 * Main gives a trace entry back only when its SREM took it out (a deletion of the member takes the whole trace and
 * gives its entries back itself). The atomic vote swap (POLL_VOTE_SWAP, #3955) runs the SREM inside its script, so the
 * script has to say whether it removed the entry: without that, the take-back gave the entry back a second time and
 * the room counted for another member's vote shrank.
 *
 * Controls: a plain take-back with the trace in place still gives the entry back once.
 */
import { vote, type Poll } from "@/lib/community-polls";
import { TRACE_ENTRY, traceKey } from "@/lib/community-trace";
import { dataUsed, giveData } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const ID = "pollswaptrace";
const POST = "p1";
const WHO = "mmmmmmmmmmmm";
const OTHER = "oooooooooooo";
const POLL: Poll = { options: [{ id: "1", text: "Yes" }, { id: "2", text: "No" }], multi: false, ends: 0, quiet: false };

const used = async () => (await dataUsed(ROOM))?.used ?? -1;

async function main() {
  part("a take-back after the member's trace was deleted gives back only the vote's room");
  is("another member's vote is counted", await vote(ID, POST, POLL, OTHER, ["2"], ROOM), true);
  const others = await used();
  is("the member votes", await vote(ID, POST, POLL, WHO, ["1"], ROOM), true);
  // What deleting the member does to the trace (lib/community-erasure.ts): the whole set goes, its entries come back.
  await redis.pipeline([["DEL", traceKey(ID, WHO)]]);
  await giveData(ROOM, [TRACE_ENTRY]);
  is("the member takes the vote back", await vote(ID, POST, POLL, WHO, [], ROOM), true);
  is("the room still holds the other member's vote, nothing given back twice", await used(), others);

  part("control: a take-back with the trace in place gives the entry back once");
  is("the member votes again", await vote(ID, POST, POLL, WHO, ["1"], ROOM), true);
  is("the member takes it back", await vote(ID, POST, POLL, WHO, [], ROOM), true);
  is("the room is back to the other member's vote", await used(), others);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
