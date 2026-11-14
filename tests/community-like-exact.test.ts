/**
 * Claude 3 (cloud A), CX-123 rule 24 (lib/community.ts toggleIn): a like is
 * "taken back" only when Redis said the member was already in the set. A
 * crooked SADD reply once read as "already there": the like just written was
 * removed, its room given back twice (the store's data room counted less than
 * it holds) and the route took a point away from the post's author. Every
 * reply of a like is now read exactly; one that is not is unknown and throws
 * (the route answers "error" and awards nothing), with nothing removed and no
 * room given back.
 */
import { readFileSync } from "node:fs";
import * as community from "@/lib/community";
import { TRACE_ENTRY } from "@/lib/community-trace";
import { SET_ENTRY_BYTES, toggleCommentLike, toggleLike } from "@/lib/community";
import { REMOVE_POINT, award, pointsOf } from "@/lib/community-points";
import { dataUsed, giveData } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const ID = "c".repeat(32);
const POST = "p1";
const WHO = "m".repeat(32);
const likes = `nl:cm:${ID}:l:${POST}`;
const trace = `nl:cm:${ID}:tr:${WHO}`;

const real = redis.pipeline.bind(redis);
/** Replaces the reply of the first command named `name` on `key` while set. */
let bend: { name: string; key: string; reply: unknown } | null = null;
/**
 * Holds a batch the test names (hold) until what it waits for has run (ran), to play two presses in a set order; never
 * longer than 400 ms, so a press that cannot reach it (it waits on a lock) is let through rather than hung.
 */
let gate: { hold: (batch: Command[]) => boolean; ran: () => boolean } | null = null;
const seen: Command[][] = [];
redis.pipeline = (async (batch: Command[]) => {
  if (gate && gate.hold(batch)) {
    const g = gate;
    for (let waited = 0; waited < 400 && !g.ran(); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // The memory Redis has no Lua: lib/community-points.ts REMOVE_POINT is played here as tests/community-points.test.ts does.
  const one = batch[0];
  if (batch.length === 1 && one?.[0] === "EVAL" && one[1] === REMOVE_POINT) {
    seen.push(batch);
    const [total, today] = await real([["ZSCORE", String(one[3]), String(one[5])], ["ZSCORE", String(one[4]), String(one[5])]]);
    const n = (raw: unknown) => (raw === null ? 0 : Number(raw));
    const writes: Command[] = [];
    if (n(total) > 0) writes.push(["ZINCRBY", String(one[3]), -1, String(one[5])]);
    if (n(today) > 0) writes.push(["ZINCRBY", String(one[4]), -1, String(one[5])]);
    if (writes.length) await real(writes);
    return [[n(total) > 0 ? 1 : 0, n(today) > 0 ? 1 : 0]];
  }
  const values = await real(batch);
  seen.push(batch);
  if (!bend) return values;
  const b = bend;
  return values.map((v, i) => (batch[i][0] === b.name && batch[i][1] === b.key ? b.reply : v));
}) as typeof redis.pipeline;

async function threw(run: () => Promise<unknown>): Promise<string> {
  try {
    return `returned ${JSON.stringify(await run())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : (error as Error).name;
  }
}
const members = async (key: string) => ((await real([["SMEMBERS", key]]))[0] as string[]).sort();
const used = async () => (await dataUsed(ROOM))?.used ?? null;

async function main(): Promise<void> {
  redis.clear();

  part("Control: a press adds the like, a second takes it back, room returns to where it was");
  const start = await used();
  is("first press: added", await toggleLike(ID, POST, WHO, ROOM), true);
  const one = await used();
  is("room taken for the like", (one ?? 0) > (start ?? 0), true);
  is("second press: taken back", await toggleLike(ID, POST, WHO, ROOM), false);
  is("room back where it was", await used(), start);

  const CROOKED: [string, unknown][] = [["null", null], ["a string", "1"], ["2", 2], ["-1", -1], ["an object", {}]];

  part("A crooked SADD of a new like: unknown, never taken back");
  for (const [what, reply] of CROOKED) {
    await real([["DEL", likes, trace]]);
    const before = await used();
    bend = { name: "SADD", key: likes, reply };
    const answer = await threw(() => toggleLike(ID, POST, WHO, ROOM));
    bend = null;
    is(`SADD answered ${what}: unknown`, answer, "unknown");
    is(`SADD answered ${what}: the like that was written stays`, await members(likes), [WHO]);
    is(`SADD answered ${what}: no room given back below what is kept`, ((await used()) ?? 0) >= (before ?? 0), true);
  }

  part("A crooked SISMEMBER: unknown before anything is taken or written");
  for (const [what, reply] of CROOKED) {
    await real([["DEL", likes, trace]]);
    const before = await used();
    bend = { name: "SISMEMBER", key: likes, reply };
    const answer = await threw(() => toggleLike(ID, POST, WHO, ROOM));
    bend = null;
    is(`SISMEMBER answered ${what}: unknown`, answer, "unknown");
    is(`SISMEMBER answered ${what}: nothing written`, await members(likes), []);
    is(`SISMEMBER answered ${what}: no room taken`, await used(), before);
  }

  part("A crooked SREM when a like is taken back: unknown, room kept until it is confirmed");
  await real([["DEL", likes, trace]]);
  is("setup: liked", await toggleLike(ID, POST, WHO, ROOM), true);
  const liked = await used();
  bend = { name: "SREM", key: likes, reply: null };
  is("SREM answered null: unknown", await threw(() => toggleLike(ID, POST, WHO, ROOM)), "unknown");
  bend = null;
  is("no room given back for a removal not confirmed", ((await used()) ?? 0) >= (liked ?? 0), true);

  part("Claude 1's MEDIUM on #3819: two un-likes at once give the room back once, and only one of them takes a like back");
  await real([["DEL", likes, trace, `nl:cm:${ID}:tr:${"a".repeat(32)}`]]);
  const A = "a".repeat(32);
  const base = await used();
  is("setup: A likes", await toggleLike(ID, POST, A, ROOM), true);
  const withA = await used();
  is("setup: M likes", await toggleLike(ID, POST, WHO, ROOM), true);
  const both = await Promise.all([toggleLike(ID, POST, WHO, ROOM), toggleLike(ID, POST, WHO, ROOM)]);
  is("only A's like is left", await members(likes), [A]);
  is("the room is A's like alone: given back once, never twice", await used(), withA);
  is("exactly one press took M's like back; the other changed nothing (no point taken from the author twice)", [both.filter((b) => b === false).length, both.filter((b) => b === null).length], [1, 1]);
  is("(the room was taken for A's like)", (withA ?? 0) > (base ?? 0), true);
  // The point moved with the like into pressLike (lib/community.ts), which both of the route's like actions call.
  const route = readFileSync("app/api/store/community/route.ts", "utf8");
  is("a press that changed nothing awards nothing, for a post's like and a comment's", [readFileSync("lib/community.ts", "utf8").includes("if (added !== null && author !== who)"), route.includes("pressLike(id, post.id, null, key, post.a,"), route.includes("pressLike(id, post.id, comment.id, key, comment.a,")], [true, true, true]);
  await real([["DEL", likes, trace, `nl:cm:${ID}:tr:${A}`]]);

  part("Codex P on #3819: a like whose trace entry was already there gives back the trace room it took");
  await real([["DEL", likes, trace]]);
  is("setup: liked", await toggleLike(ID, POST, WHO, ROOM), true);
  const complete = await used();
  // An earlier attempt left only the trace entry: the like itself is gone (and its room given back), the trace stays.
  await real([["SREM", likes, WHO]]);
  await giveData(ROOM, [{ slot: `cm:p:${POST}`, bytes: SET_ENTRY_BYTES }]);
  is("(only the trace entry is left)", await members(trace), [`l:${POST}`]);
  is("liked again", await toggleLike(ID, POST, WHO, ROOM), true);
  is("the room is a like and one trace entry, as before: the trace room taken again is given back", await used(), complete);
  await toggleLike(ID, POST, WHO, ROOM);
  await real([["DEL", likes, trace]]);

  part("Codex T and Codex U on #3819: two presses at once of one member never leave a point or a like the other did not");
  // What the route does with a press: the like, then the author's point. pressLike (lib/community.ts) holds both under
  // one lock per member and liked thing; before it, the route ran them as two steps, as this stand-in does.
  type Press = (id: string, post: string, comment: string | null, who: string, author: string, room: typeof ROOM, owner: typeof ROOM) => Promise<boolean | null>;
  const press: Press = ((community as Record<string, unknown>).pressLike as Press | undefined) ?? (async (id, post, comment, who, author, room, owner) => {
    const added = comment ? await toggleCommentLike(id, post, comment, who, room) : await toggleLike(id, post, who, room);
    if (added !== null && author !== who) await award(id, author, added ? 1 : -1, owner);
    return added;
  });
  const AUTHOR = "a".repeat(32);
  const authorPoints = async () => (await pointsOf(ID, [AUTHOR])).get(AUTHOR) ?? 0;
  const isSadd = (batch: Command[]) => batch.some((c) => c[0] === "SADD" && c[1] === likes);
  const isSrem = (batch: Command[]) => batch.some((c) => c[0] === "SREM" && c[1] === likes);
  const reset = async () => { await real([["DEL", likes, trace, `nl:cm:${ID}:pts`]]); seen.length = 0; };

  // Codex T: no like yet; one press likes, the other, at the same moment, takes it back. The point of the like must
  // never be left after its taking back has run: hold the like's point until a point was taken off.
  await reset();
  const before = await authorPoints();
  gate = { hold: (batch) => batch.some((c) => c.includes("ZINCRBY") || c[0] === "ZINCRBY"), ran: () => seen.some((b) => b.some((c) => c[0] === "EVAL" && c[1] === REMOVE_POINT)) };
  await Promise.all([press(ID, POST, null, WHO, AUTHOR, ROOM, ROOM), press(ID, POST, null, WHO, AUTHOR, ROOM, ROOM)]);
  gate = null;
  const likeThere = (await members(likes)).includes(WHO);
  is("Codex T: like and take-back at once: the author has a point only if the like is there", (await authorPoints()) - before, likeThere ? 1 : 0);

  // Codex U: the like is there; two presses at once both read it as held. One takes it back and gives its room back;
  // the other must never write it again without taking its room: hold a second write of the like until a removal ran.
  await reset();
  await press(ID, POST, null, WHO, AUTHOR, ROOM, ROOM);
  const withLike = await used();
  let adds = 0;
  gate = { hold: (batch) => isSadd(batch) && ++adds > 1, ran: () => seen.some(isSrem) };
  await Promise.all([press(ID, POST, null, WHO, AUTHOR, ROOM, ROOM), press(ID, POST, null, WHO, AUTHOR, ROOM, ROOM)]);
  gate = null;
  const there = (await members(likes)).includes(WHO);
  is("Codex U: two presses on a like that is there: the room counts the like exactly when it is there", await used(), there ? withLike : (withLike ?? 0) - SET_ENTRY_BYTES - TRACE_ENTRY.bytes);
  is("and the route serializes each press under the like's lock", [readFileSync("app/api/store/community/route.ts", "utf8").includes("pressLike("), /withLock\(likeLockKey\(/.test(readFileSync("lib/community.ts", "utf8"))], [true, true]);
  await reset();

  part("The comment's like reads the same way (rule 30)");
  const clikes = `nl:cm:${ID}:lc:${POST}:k1`;
  bend = { name: "SADD", key: clikes, reply: "1" };
  const c = await threw(() => toggleCommentLike(ID, POST, "k1", WHO, ROOM));
  bend = null;
  is("comment like, SADD answered a string: unknown", c, "unknown");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
