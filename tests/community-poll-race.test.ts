/**
 * One member sending the same vote, or the same take-back, several times at once (#3955, lib/community-polls.ts vote).
 * Synthetic only: the in-memory Redis double, through the real lib/community-polls.ts.
 *
 * vote read the member's earlier vote with HGET, then moved the tally with HINCRBY ±1 worked out from that read, in a
 * later command with no script or lock. Five votes for option 1 sent at once each read "no vote yet" and each added
 * one: the tally said 5 with a single voter. Four take-backs at once each read the vote and each took one off, so the
 * tally could go below zero and cancel other members' votes in the total. Now the vote record is swapped only while it
 * still holds what was read (POLL_VOTE_SWAP), with the tally moved in the same step, so each member counts once.
 *
 * Controls: a change moves the count, another member's vote stays, and the store's data room is given back exactly
 * once, not once per request.
 */
import { vote, type Poll } from "@/lib/community-polls";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const ID = "pollrace";
const POST = "p1";
const WHO = "mmmmmmmmmmmm";
const OTHER = "oooooooooooo";
const POLL: Poll = { options: [{ id: "1", text: "Yes" }, { id: "2", text: "No" }], multi: false, ends: 0, quiet: false };

const tally = async () => (await redis.pipeline([["HGETALL", `nl:cm:${ID}:pc:${POST}`]]))[0];
const mine = async () => (await redis.pipeline([["HGET", `nl:cm:${ID}:pv:${POST}`, WHO]]))[0];
const used = async () => (await dataUsed(ROOM))?.used ?? -1;

async function main() {
  part("five identical votes sent at once count the member once");
  const empty = await used();
  const cast = await Promise.all(Array.from({ length: 5 }, () => vote(ID, POST, POLL, WHO, ["1"], ROOM)));
  is("every request is answered as voted", cast, [true, true, true, true, true]);
  is("the tally holds one vote for option 1", await tally(), ["1", "1"]);
  is("the member's vote is option 1", await mine(), "1");
  const voted = await used();
  is("the vote took room", voted > empty, true);

  part("four take-backs sent at once leave the tally at zero, never below");
  const back = await Promise.all(Array.from({ length: 4 }, () => vote(ID, POST, POLL, WHO, [], ROOM)));
  is("every take-back is answered", back, [true, true, true, true]);
  is("the tally for option 1 is 0, not below", await tally(), ["1", "0"]);
  is("no vote is kept for the member", await mine(), null);
  is("the room the vote took is given back exactly once", await used(), empty);

  part("controls: a change moves the count, another member's vote stays");
  await vote(ID, POST, POLL, OTHER, ["2"], ROOM);
  await vote(ID, POST, POLL, WHO, ["1"], ROOM);
  await vote(ID, POST, POLL, WHO, ["2"], ROOM);
  is("the change moved the member's vote from 1 to 2", await tally(), ["1", "0", "2", "2"]);
  await Promise.all(Array.from({ length: 3 }, () => vote(ID, POST, POLL, WHO, [], ROOM)));
  is("parallel take-backs remove only this member's vote", await tally(), ["1", "0", "2", "1"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
