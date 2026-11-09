/**
 * A like in a community is one step (CX-123 rule 24; the pre-review of
 * claude5/community-toggle-exact, 9 November 2026): whether the member liked
 * it, the like and its trace entry written or taken out, their room in the
 * store's data room taken or given back, and the point (+1 or -1) that goes
 * with it all come from one atomic script, so no other press can land in
 * between.
 *
 *   - Exact: the room counts exactly what is stored, never less, whichever
 *     presses of the same member cross; the point each press answers is
 *     exactly what the likes set moved by (a like given +1, one taken back -1).
 *   - The route applies the point the script answered, never one it deduces
 *     (app/api/store/community/route.ts). Applying it (award) is a separate
 *     step outside the script, so the author's points can still drift from
 *     the likes by at most 1 for each answer lost before award (a timeout
 *     after the script ran) and for each -1 that lands at zero (REMOVE_POINT
 *     stops at zero, then the crossing +1 lands on top).
 *   - Unknown: a reply in any other shape throws UnknownReplyError and the
 *     route applies no point; what the script did is read by the next press.
 *   - Full: a new like past the room is refused (DataRoomError) with nothing
 *     written; taking one back always works.
 *
 * Carried from claude5/community-toggle-exact (890015630b), rule 23, each
 * changed check says why: the old per-command swaps (SISMEMBER, SADD, SREM
 * answered in another shape) and "another press in between" checks pinned
 * the old four-step flow; a single script has no in-between, so they become
 * the reply checks of the one script and the interleaving matrix below,
 * which drives another press before every batch a press sends. The old
 * "the remove answered in another shape: no room given back on a guess"
 * now reads "room equals what is stored": the script gives back exactly what
 * it took out, in the same step. Added: the pre-review's proof (two unlike
 * presses crossing moved the author by -2; three presses left a like
 * uncharged) and the route's use of the answered point.
 *
 * Synthetic store and community; nothing leaves the test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SET_ENTRY_BYTES, toggleCommentLike, toggleLike } from "@/lib/community";
import { TRACE_ENTRY, traceKey } from "@/lib/community-trace";
import { UnknownReplyError } from "@/lib/redis-reply";
import { DataRoomError, dataKey } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "k".repeat(32);
const POST = "aaaaaaaaaaaa";
const ADA = "adakey00000000000000000000000001";
const BOB = "bobkey00000000000000000000000002";
const LIKES = `nl:cm:${ID}:l:${POST}`;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** Another press landing before this press's `at`-th batch that touches the likes set (top level only). */
let hooks: { at: number; before: () => Promise<unknown> }[] = [];
/** What the next batch touching the likes set answers instead, at its slot; "missing" drops it. */
let swap: { value: unknown } | null = null;
let depth = 0;
let seen = 0;
const touches = (batch: Command[]) => batch.some((c) => c.some((part) => String(part) === LIKES || String(part).startsWith(`nl:cm:${ID}:lc:`)));
redis.pipeline = (async (batch: Command[]) => {
  if (!touches(batch)) return real(batch);
  if (depth === 0) {
    seen += 1;
    const due = hooks.filter((h) => h.at === seen);
    hooks = hooks.filter((h) => h.at !== seen);
    for (const h of due) {
      depth += 1;
      try {
        await h.before();
      } finally {
        depth -= 1;
      }
    }
  }
  const replies = await real(batch);
  if (!swap || depth !== 0) return replies;
  const { value } = swap;
  swap = null;
  if (value === "missing") return replies.slice(1);
  return [value, ...replies.slice(1)];
}) as typeof redis.pipeline;

const roomOf = (slot: string) => Number(redis.run(["HGET", dataKey(ROOM)!, slot])) || 0;
/** The likes' room in their post's slot, and their trace entries' in the members' slot. */
const room = () => [roomOf(`cm:p:${POST}`), roomOf(TRACE_ENTRY.slot)];
const members = (key: string) => redis.run(["SMEMBERS", key]) as string[];
const liked = () => members(LIKES).includes(ADA);
const traced = () => members(traceKey(ID, ADA)).includes(`l:${POST}`);
/** What is stored, at what it is counted at: each like and each trace entry of a like on this post. */
const stored = () => [
  members(LIKES).length * SET_ENTRY_BYTES,
  [ADA, BOB].filter((who) => members(traceKey(ID, who)).includes(`l:${POST}`)).length * TRACE_ENTRY.bytes,
];

/** The point the route gives the author for one press: what the toggle answered (or, for a yes/no, what the route used to deduce). */
function pointOf(result: unknown): number {
  if (typeof result === "boolean") return result ? 1 : -1;
  return (result as { points: number }).points;
}
/** The sum of the points the presses answered (what the route hands to award), from presses that answered only. */
let points = 0;
async function press(who = ADA): Promise<string> {
  try {
    const result = await toggleLike(ID, POST, who, ROOM);
    points += pointOf(result);
    const now = typeof result === "boolean" ? result : (result as { liked: boolean }).liked;
    return now ? "liked" : "unliked";
  } catch (error) {
    if (error instanceof DataRoomError) return "full";
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  const base = room();
  const one = [base[0] + SET_ENTRY_BYTES, base[1] + TRACE_ENTRY.bytes];

  part("The controls, with Redis's own answers");
  is("a press likes it", await press(), "liked");
  is("the author gets exactly +1", points, 1);
  is("its room taken once, for the like and its trace entry", room(), one);
  is("written with its trace entry", [liked(), traced()], [true, true]);
  const first = await toggleLike(ID, POST, ADA, ROOM);
  is("a second press answers taken back, with the author's -1", first, { liked: false, points: -1 });
  is("its room given back", room(), base);
  is("taken out with its trace entry", [liked(), traced()], [false, false]);

  part("The pre-review's proof: two unlike presses crossing");
  redis.clear();
  await press();
  points = 0;
  seen = 0;
  hooks = [{ at: 2, before: () => press() }];
  await press();
  hooks = [];
  is("like gone", liked(), false);
  is("the answered points sum to exactly -1 (one like taken back)", points, -1);
  is("room back to base", room(), base);

  part("The pre-review's proof: three presses, another member's like stays paid");
  redis.clear();
  await press(BOB);
  const bob = room();
  await press();
  seen = 0;
  hooks = [{ at: 2, before: () => press() }, { at: 3, before: () => press() }];
  await press();
  hooks = [];
  is("Bob's like still stored", members(LIKES).includes(BOB), true);
  is("room counts exactly what is stored (never less)", room(), stored());

  part("Every crossing: another press before each batch, one or two of them");
  const plans: number[][] = [[1], [2], [3], [1, 2], [1, 3], [2, 3], [2, 2], [1, 2, 3]];
  for (const start of [false, true]) {
    for (const withBob of [false, true]) {
      for (const plan of plans) {
        redis.clear();
        if (withBob) await press(BOB);
        if (start) await press();
        const before = liked();
        points = 0;
        seen = 0;
        hooks = plan.map((at) => ({ at, before: () => press() }));
        const outcome = await press();
        hooks = [];
        const name = `${start ? "liked" : "not liked"}${withBob ? ", Bob's like there" : ""}, others before batch ${plan.join("+")}`;
        is(`${name}: answered`, outcome === "liked" || outcome === "unliked", true);
        is(`${name}: the answered points sum to exactly what the likes moved`, points, Number(liked()) - Number(before));
        is(`${name}: room equals what is stored`, room(), stored());
        is(`${name}: like and trace entry together`, liked(), traced());
      }
    }
  }

  part("The script's reply in another shape: unknown, no point applied, room still what is stored");
  const UNKNOWN: [string, unknown][] = [
    ["null", null],
    ["missing from the pipeline", "missing"],
    ["the string \"1\"", "1"],
    ["a number", 1],
    ["the room's own two items", [1, 0]],
    ["an extra item", [1, 0, 1, 1]],
    ["a point as text", [1, 0, "1"]],
    ["a point of 2", [1, 0, 2]],
    ["taken with no point", [1, 0, 0]],
    ["full with a point", [0, 0, 1]],
    ["not readable", [-1, 0, 0]],
    ["a negative total", [1, -5, 1]],
    ["a fraction of a byte", [1, 1.5, 1]],
  ];
  for (const start of [false, true]) {
    for (const [name, value] of UNKNOWN) {
      redis.clear();
      if (start) await press();
      points = 0;
      seen = 0;
      swap = { value };
      const outcome = await press();
      swap = null;
      is(`${start ? "liked" : "not liked"}, ${name}: said as unknown`, outcome, "unknown");
      is(`${start ? "liked" : "not liked"}, ${name}: no point applied`, points, 0);
      is(`${start ? "liked" : "not liked"}, ${name}: room equals what is stored`, room(), stored());
      const next = await press();
      is(`${start ? "liked" : "not liked"}, ${name}: the next press reads it as it is`, [next, room()], [liked() ? "liked" : "unliked", stored()]);
    }
  }

  part("A full room: a new like refused with nothing written; taking one back always works");
  redis.clear();
  await press();
  const limit = contentRoomFor(ROOM, Date.now() / 1000);
  redis.run(["HSET", dataKey(ROOM)!, "#", limit]);
  points = 0;
  is("Bob's new like: refused as full", await press(BOB), "full");
  is("Bob's like not written, no trace entry, no point", [members(LIKES).includes(BOB), members(traceKey(ID, BOB)).length, points], [false, 0, 0]);
  is("Ada takes hers back while full", await press(), "unliked");
  is("the author's -1", points, -1);

  part("A comment's like goes through the same script");
  redis.clear();
  const commentLikes = () => members(`nl:cm:${ID}:lc:${POST}:cccccccccccc`).includes(ADA);
  is("a comment's like", await toggleCommentLike(ID, POST, "cccccccccccc", ADA, ROOM), { liked: true, points: 1 });
  is("its room taken once", [commentLikes(), room()], [true, one]);
  swap = { value: null };
  let comment = "";
  try {
    await toggleCommentLike(ID, POST, "cccccccccccc", ADA, ROOM);
  } catch (error) {
    comment = error instanceof UnknownReplyError ? "unknown" : String(error);
  }
  is("its reply unknown: said as unknown", comment, "unknown");
  is("taken back by the script all the same, room back", [commentLikes(), room()], [false, base]);

  part("The route applies the point the toggle answered, never one it deduces");
  const route = readFileSync(join(process.cwd(), "app/api/store/community/route.ts"), "utf8");
  is("no point deduced from a yes or a no", /\? 1 : -1/.test(route), false);
  is("a post's like: the answered point", /const like = await toggleLike\(id, post\.id, key, store\);\s*if \(post\.a !== key\) await award\(id, post\.a, like\.points, store\);/.test(route), true);
  is("a comment's like: the answered point", /const like = await toggleCommentLike\(id, post\.id, comment\.id, key, store\);\s*if \(comment\.a !== key\) await award\(id, comment\.a, like\.points, store\);/.test(route), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
