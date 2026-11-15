/**
 * #4798: the erasure of a member's community items waiting for approval
 * (forgetHeldPerson) reads each count of its final deletion exactly (rule 24):
 * a ZREM, DEL or HDEL count is a whole number from 0 up to the number of
 * members, keys or fields it was sent. A larger, negative, fractional or
 * misshapen count proves nothing, so the step throws UnknownReplyError and the
 * erasure says it did not finish, to be retried; never "finished".
 * Synthetic Redis only (./redis-stub).
 */
import { forgetHeldPerson, holdPost } from "@/lib/community-approval";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const ada = "a".repeat(31) + "1";
const t0 = 1_800_000_000;
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

type Forge = (out: unknown[]) => unknown[];

/** One held post, then the final deletion pipeline (ZREM, DEL records, DEL list, HDEL counts) answered by `forge`. */
async function erase(forge: Forge | null): Promise<string> {
  redis.clear();
  const held = await holdPost(id, { space: "aaaaaaaaaaaa", author: ada, title: "", text: "Hello", img: null, kind: "post" as const, poll: null }, ROOM, t0);
  if (!held.ok) throw new Error("not held");
  redis.pipeline = (async (batch) => {
    const out = await original(batch);
    if (forge && batch.length === 4 && batch[0][0] === "ZREM" && batch[1][0] === "DEL") return forge(out as unknown[]);
    return out;
  }) as typeof redis.pipeline;
  try {
    await forgetHeldPerson(id, ada);
    return "finished";
  } catch (error) {
    return error instanceof UnknownReplyError ? "not finished (unknown reply)" : `not finished (${String(error)})`;
  } finally {
    redis.pipeline = original;
  }
}

/** Nothing held: the final pipeline is only DEL list and HDEL counts. */
async function eraseNothing(forge: Forge | null): Promise<string> {
  redis.clear();
  redis.pipeline = (async (batch) => {
    const out = await original(batch);
    if (forge && batch.length === 2 && batch[0][0] === "DEL" && batch[1][0] === "HDEL") return forge(out as unknown[]);
    return out;
  }) as typeof redis.pipeline;
  try {
    await forgetHeldPerson(id, ada);
    return "finished";
  } catch (error) {
    return error instanceof UnknownReplyError ? "not finished (unknown reply)" : `not finished (${String(error)})`;
  } finally {
    redis.pipeline = original;
  }
}

/**
 * One held post with a picture named by its record only, not by the member's picture list (review of the same family):
 * the final deletion gains an HSET that writes the picture into the list (sent 1 field), answered by `forge`.
 */
async function eraseUnlisted(forge: Forge | null): Promise<string> {
  redis.clear();
  const img = { path: `community/${"f".repeat(24)}/held-unlisted.png`, w: 100, h: 100, alt: "A drawing" };
  const held = await holdPost(id, { space: "aaaaaaaaaaaa", author: ada, title: "", text: "Hello", img, kind: "post" as const, poll: null }, ROOM, t0);
  if (!held.ok) throw new Error("not held");
  await original([["DEL", `nl:cm:${id}:ap:f`]]);
  let seen = 0;
  redis.pipeline = (async (batch) => {
    const out = await original(batch);
    if (batch.length === 5 && batch[0][0] === "ZREM" && batch[4][0] === "HSET") {
      seen += 1;
      if (forge) return forge(out as unknown[]);
    }
    return out;
  }) as typeof redis.pipeline;
  try {
    await forgetHeldPerson(id, ada);
    return seen ? "finished" : "the unlisted picture's HSET was never sent";
  } catch (error) {
    return error instanceof UnknownReplyError ? "not finished (unknown reply)" : `not finished (${String(error)})`;
  } finally {
    redis.pipeline = original;
  }
}

const at = (i: number, value: unknown): Forge => (out) => out.map((v, j) => (j === i ? value : v));
const NOT = "not finished (unknown reply)";

async function main(): Promise<void> {
  part("forgetHeldPerson: each count of the final deletion is within what was sent");
  is("control: the real replies finish", await erase(null), "finished");
  is("control: exact counts at their maximum finish", await erase((out) => [1, 1, 1, 2, ...out.slice(4)]), "finished");
  is("control: zero counts finish", await erase((out) => [0, 0, 0, 0, ...out.slice(4)]), "finished");
  is("ZREM of one item answered 2", await erase(at(0, 2)), NOT);
  is("DEL of one record answered 2", await erase(at(1, 2)), NOT);
  is("DEL of the member's list answered 2", await erase(at(2, 2)), NOT);
  is("HDEL of two counts answered 3", await erase(at(3, 3)), NOT);
  is("DEL answered -1", await erase(at(1, -1)), NOT);
  is("DEL answered 0.5", await erase(at(1, 0.5)), NOT);
  is("DEL answered \"1\"", await erase(at(1, "1")), NOT);
  is("DEL answered null", await erase(at(1, null)), NOT);
  is("a reply missing", await erase((out) => out.slice(0, 3)), NOT);

  part("forgetHeldPerson with a picture named by its record only: the HSET that lists it (sent 1)");
  is("control: the real replies finish", await eraseUnlisted(null), "finished");
  is("the picture's HSET answered 2", await eraseUnlisted(at(4, 2)), NOT);
  is("the picture's HSET answered -1", await eraseUnlisted(at(4, -1)), NOT);
  is("the picture's HSET answered \"1\"", await eraseUnlisted(at(4, "1")), NOT);

  part("forgetHeldPerson with nothing held: the list's DEL and the counts' HDEL");
  is("control: the real replies finish", await eraseNothing(null), "finished");
  is("control: DEL 1 and HDEL 2 finish", await eraseNothing(() => [1, 2]), "finished");
  is("DEL of the list answered 2", await eraseNothing(at(0, 2)), NOT);
  is("HDEL of two counts answered 3", await eraseNothing(at(1, 3)), NOT);
  done();
}
void main();
