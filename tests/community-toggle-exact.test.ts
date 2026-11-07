/**
 * A like in a community takes its room in the store's data room once and gives
 * back only what was taken, also when Redis answers in a shape that is not its
 * own, or another press of the same member lands in between (CX-123 rule 24).
 *
 * toggleIn (lib/community.ts, under toggleLike and toggleCommentLike) asks
 * SISMEMBER whether the member liked it, takes the room for a new like, SADDs
 * the like and its trace entry, and on a like already there SREMs both and
 * gives their room back. Read in their exact shapes:
 *
 *   - SISMEMBER: 0 or 1; anything else takes nothing, writes nothing and fails
 *     as unknown (UnknownReplyError), which the route says as "error";
 *   - SADD of the like: 1 on a new like is liked; unknown keeps what may be
 *     written and the room it took (never deleted or given back on a guess)
 *     and fails as unknown, and the next press reads the like as it is;
 *   - another press in between: one that liked first leaves this press's room
 *     to give back and the like to take back with its own room; one that took
 *     the like back first leaves this press's re-added like, which nobody paid
 *     for, to take out with nothing given;
 *   - SREM: room is given back only for an entry it took out, exactly 1, that
 *     somebody paid for; unknown gives nothing and fails as unknown.
 *
 * Synthetic store and community; nothing leaves the test.
 */
import { SET_ENTRY_BYTES, toggleCommentLike, toggleLike } from "@/lib/community";
import { TRACE_ENTRY, traceKey } from "@/lib/community-trace";
import { UnknownReplyError } from "@/lib/redis-reply";
import { dataKey } from "@/lib/store-data";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "k".repeat(32);
const POST = "aaaaaaaaaaaa";
const ADA = "adakey00000000000000000000000001";
const LIKES = `nl:cm:${ID}:l:${POST}`;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** What the next command `on` on the likes set answers instead of Redis's own reply; "missing" drops it. `before` runs first, as another press landing in between. */
let swap: { on: string; value?: unknown; before?: () => Promise<unknown> } | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const at = swap ? batch.findIndex((c) => c[0] === swap!.on && String(c[1]).includes(`:${ID}:l`)) : -1;
  if (at < 0 || !swap) return real(batch);
  const now = swap;
  swap = null;
  if (now.before) await now.before();
  const replies = await real(batch);
  if (!("value" in now)) return replies;
  if (now.value === "missing") return replies.slice(0, at).concat(replies.slice(at + 1));
  const out = [...replies];
  out[at] = now.value;
  return out;
}) as typeof redis.pipeline;

const UNKNOWN: [string, unknown][] = [
  ["null", null],
  ["missing from the pipeline", "missing"],
  ["the string \"1\"", "1"],
  ["the string \"0\"", "0"],
  ["2", 2],
  ["-1", -1],
  ["a list", [1]],
];

const roomOf = (slot: string) => Number(redis.run(["HGET", dataKey(ROOM)!, slot])) || 0;
/** The like's room in its post's slot, and its trace entry's in the members' slot. */
const room = () => [roomOf(`cm:p:${POST}`), roomOf(TRACE_ENTRY.slot)];
const liked = () => (redis.run(["SMEMBERS", LIKES]) as string[]).includes(ADA);
const traced = () => (redis.run(["SMEMBERS", traceKey(ID, ADA)]) as string[]).includes(`l:${POST}`);

async function outcome(run: () => Promise<boolean>): Promise<string> {
  try {
    return (await run()) ? "liked" : "unliked";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}
const press = () => outcome(() => toggleLike(ID, POST, ADA, ROOM));

async function main(): Promise<void> {
  redis.clear();
  const base = room();
  const one = [base[0] + SET_ENTRY_BYTES, base[1] + TRACE_ENTRY.bytes];

  part("The controls, with Redis's own answers");
  is("a press likes it", await press(), "liked");
  is("its room taken once, for the like and its trace entry", room(), one);
  is("written with its trace entry", [liked(), traced()], [true, true]);
  is("a second press takes it back", await press(), "unliked");
  is("its room given back", room(), base);
  is("taken out with its trace entry", [liked(), traced()], [false, false]);

  part("Not liked, the 'liked already?' read in another shape");
  for (const [name, value] of UNKNOWN) {
    swap = { on: "SISMEMBER", value };
    is(`${name}: said as unknown`, await press(), "unknown");
    is(`${name}: nothing taken, nothing written`, [room(), liked(), traced()], [base, false, false]);
  }

  part("Liked, the 'liked already?' read in another shape");
  await press();
  for (const [name, value] of UNKNOWN) {
    swap = { on: "SISMEMBER", value };
    is(`${name}: said as unknown`, await press(), "unknown");
    is(`${name}: nothing given back on a guess, still liked`, [room(), liked(), traced()], [one, true, true]);
  }
  await press();
  is("control: taken back, room back", [room(), liked()], [base, false]);

  part("A new like, its write answered in another shape");
  for (const [name, value] of UNKNOWN.filter(([n]) => n !== "the string \"0\"")) {
    swap = { on: "SADD", value };
    is(`${name}: said as unknown`, await press(), "unknown");
    is(`${name}: the like just written is kept, with its trace entry`, [liked(), traced()], [true, true]);
    is(`${name}: its room taken once, nothing given back that was not taken`, room(), one);
    is(`${name}: the next press reads it liked and takes it back`, await press(), "unliked");
    is(`${name}: room back where it was`, room(), base);
  }

  part("Another press of the same member in between");
  swap = { on: "SADD", before: () => toggleLike(ID, POST, ADA, ROOM) };
  is("the other liked first: this press takes it back", await press(), "unliked");
  is("the other liked first: both takes given back, nothing liked", [room(), liked(), traced()], [base, false, false]);
  await press();
  swap = { on: "SADD", before: () => toggleLike(ID, POST, ADA, ROOM) };
  is("the other took it back first: this press leaves it taken back", await press(), "unliked");
  is("the other took it back first: the re-added like, never paid for, is taken out with nothing given", [room(), liked(), traced()], [base, false, false]);

  part("A comment's like goes through the same reads");
  swap = { on: "SADD", value: null };
  const commentLikes = () => (redis.run(["SMEMBERS", `nl:cm:${ID}:lc:${POST}:cccccccccccc`]) as string[]).includes(ADA);
  is("a comment's like, its write unknown: said as unknown", await outcome(() => toggleCommentLike(ID, POST, "cccccccccccc", ADA, ROOM)), "unknown");
  is("the comment's like is kept, its room taken once", [commentLikes(), room()], [true, one]);
  is("the next press takes it back, room back", [await outcome(() => toggleCommentLike(ID, POST, "cccccccccccc", ADA, ROOM)), room()], ["unliked", base]);

  part("Taken back, the remove answered in another shape");
  for (const [name, value] of UNKNOWN) {
    await press();
    const before = room();
    swap = { on: "SREM", value };
    is(`${name}: said as unknown`, await press(), "unknown");
    // The stub did take it out: its room stays counted (more, never less), and the next press likes it again.
    is(`${name}: no room given back on a guess`, room(), before);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
