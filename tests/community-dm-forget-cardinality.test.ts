/**
 * forgetDmPerson (lib/community-dm.ts) confirms a deletion only by a count the command sent could give (#4795, Codex V,
 * transcribed and reproduced by Claude 2): a DEL cannot remove more keys than it named, a ZREM or HDEL more members or
 * fields, an HSET more fields. A larger count does not prove what was removed, so the person's erasure must not be said
 * finished on it. The test is the one reproduced in the issue; its last check is adapted to the shape main sends now.
 * Synthetic, in-memory Redis only.
 */
import { forgetDmPerson } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const OTHER = "b".repeat(32);
const THIRD = "d".repeat(32);
const base = `nl:cm:${COMMUNITY}`;
const PAIR = `${MEMBER}.${OTHER}`;
const PAIR2 = `${MEMBER}.${THIRD}`;
const msg = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 100 });
type Command = (string | number)[];
const original = redis.pipeline.bind(redis);

function seed(): void {
  redis.clear();
  for (const pair of [PAIR, PAIR2]) {
    redis.run(["ZADD", `${base}:dm:${pair}`, 100, msg]);
    redis.run(["SET", `${base}:dm:r:${pair}`, "1"]);
  }
  redis.run(["ZADD", `${base}:dm:i:${MEMBER}`, 1, PAIR, 1, PAIR2]);
  redis.run(["ZADD", `${base}:dm:i:${OTHER}`, 1, PAIR]);
  redis.run(["ZADD", `${base}:dm:i:${THIRD}`, 1, PAIR2]);
}
async function outcome(answerFor: (batch: Command[]) => unknown[] | null): Promise<string> {
  seed();
  redis.pipeline = (async (batch: Command[]) => answerFor(batch) ?? original(batch)) as typeof redis.pipeline;
  try { await forgetDmPerson(COMMUNITY, MEMBER); return "resolved"; } catch (e) { return e instanceof Error ? e.name : "rejected"; } finally { redis.pipeline = original; }
}
async function main(): Promise<void> {
  console.error = () => {};
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  part("Private messages: deletion counts stay within the commands' cardinality");
  // The conversations' batch starts with a DEL of two keys (the chat and its read mark): it answers 3.
  is("DEL of two conversation keys cannot report three", await outcome((b) => (b.length > 2 && b[0][0] === "DEL" && b[0].length === 3 ? original(b).then((r) => [3, ...r.slice(1)]) as unknown as unknown[] : null)), "UnknownReplyError");
  // The final DEL of the member's own lists answers more than it named. On main since the declines' counts moved into the
  // same last pipeline, that DEL is the third of three commands and names two keys (inbox, requests): it answers 3. (The
  // issue's check matched an older shape, one DEL of three keys, which main no longer sends; adapted by Claude 5.)
  is("DEL of the own lists cannot report more than it named", await outcome((b) => (b.length === 3 && b[2][0] === "DEL" ? original(b).then((r) => [r[0], r[1], b[2].length]) as unknown as unknown[] : null)), "UnknownReplyError");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
