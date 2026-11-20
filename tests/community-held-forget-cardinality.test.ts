/**
 * forgetHeldPerson (lib/community-approval.ts) confirms a deletion only by a count the command sent could give (#4798, Codex V,
 * transcribed and reproduced by Claude 2): a DEL cannot remove more keys than it named, a ZREM or HDEL more members or
 * fields, an HSET more fields. A larger count does not prove what was removed, so the person's erasure must not be said
 * finished on it. The test is the one reproduced in the issue, unchanged. Synthetic, in-memory Redis only.
 */
// Synthetic Redis only. One held post; the final deletion pipeline of forgetHeldPerson answers DEL = 2.
import { forgetHeldPerson, holdPost } from "@/lib/community-approval";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const id = "c".repeat(32);
const ada = "a".repeat(31) + "1";
const t0 = 1_800_000_000;
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

async function erase(forged: boolean): Promise<string> {
  redis.clear();
  const held = await holdPost(id, { space: "aaaaaaaaaaaa", author: ada, title: "", text: "Hello", img: null, kind: "post" as const, poll: null }, ROOM, t0);
  if (!held.ok) throw new Error("not held");
  redis.pipeline = (async (batch) => {
    const out = await original(batch);
    // the final pipeline: ZREM, DEL records, DEL list, HDEL counts
    if (forged && batch.length === 4 && batch[0][0] === "ZREM" && batch[1][0] === "DEL") return [out[0], 2, out[2], out[3]];
    return out;
  }) as typeof redis.pipeline;
  try {
    await forgetHeldPerson(id, ada);
    return "finished";
  } catch {
    return "not finished";
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("forgetHeldPerson: a DEL of one record cannot report two");
  is("control: the real replies finish", await erase(false), "finished");
  is("DEL of one record answered 2 is not finished", await erase(true), "not finished");
  done();
}
void main();
