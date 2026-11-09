/**
 * A community member's own record is read first and taken last (Claude 5's second review of #2576, items 2 and 3):
 * what it names elsewhere (their handle, their unsubscribe token, whose record holds their address) goes while the
 * record can still be found, so one failed step leaves everything for the next try; and a reply that is not exact is
 * unknown, never "no member". Synthetic records (MemoryRedis); no outside request.
 */
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

const ID = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c1";
const WHO = "whoabc";
const TOKEN = "ab".repeat(20);
const MEMBERS = `nl:cm:${ID}:m`;
const HANDLES = `nl:cm:${ID}:h`;
const UNSUB = `nl:cm:unsub:${TOKEN}`;
const member = { k: WHO, e: "member@example.test", n: "Ana", h: "ana", dir: true, mail: true, at: 1, seen: 1, muted: false, removed: false, t: TOKEN, q: [], qa: 0, qq: [] };

const seed = async () => {
  redis.clear();
  await redis.pipeline([
    ["HSET", MEMBERS, WHO, JSON.stringify(member)],
    ["HSET", HANDLES, "ana", WHO],
    ["SET", UNSUB, `community|${WHO}|ana`],
  ]);
};
const left = async () => redis.pipeline([["HEXISTS", MEMBERS, WHO], ["HEXISTS", HANDLES, "ana"], ["EXISTS", UNSUB]]);

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  const failOnce = (match: (cs: (string | number)[][]) => boolean) => {
    let once = true;
    redis.pipeline = (async (cs: (string | number)[][]) => {
      if (once && match(cs)) {
        once = false;
        throw new Error("Redis request failed with status 503");
      }
      return pipe(cs);
    }) as typeof redis.pipeline;
  };
  const run = () => forgetCommunityPerson(ID, WHO, member.e, []).then((n) => `done ${n}`, (error: Error) => error.name);

  part("Control: a healthy deletion");
  await seed();
  is("the person is deleted", (await run()).startsWith("done"), true);
  is("record, handle and unsubscribe token gone", await left(), [0, 0, 0]);

  for (const [label, match] of [
    ["the handle's deletion fails once", (cs: (string | number)[][]) => cs.some((c) => c[0] === "HDEL" && c[1] === HANDLES)],
    ["the unsubscribe token's deletion fails once", (cs: (string | number)[][]) => cs.some((c) => c[0] === "DEL" && c[1] === UNSUB)],
  ] as [string, (cs: (string | number)[][]) => boolean][]) {
    part(label);
    await seed();
    failOnce(match);
    const first = await run();
    redis.pipeline = pipe;
    is(`${label}: the first run reports the failure`, first, "Error");
    is(`${label}: the record is still there for the next try`, (await left())[0], 1);
    await run();
    is(`${label}: after a healthy retry, record, handle and token are all gone`, await left(), [0, 0, 0]);
  }

  part("The record's read answers nothing (an envelope cut short)");
  await seed();
  redis.pipeline = (async (cs: (string | number)[][]) => (cs.length === 1 && cs[0][0] === "HGET" && cs[0][1] === MEMBERS ? [] : pipe(cs))) as typeof redis.pipeline;
  const cut = await run();
  redis.pipeline = pipe;
  is("a cut reply is unknown, never \"no member\"", cut, "UnknownReply");
  is("nothing of the member was deleted", await left(), [1, 1, 1]);

  part("The record's deletion answers a count that is not exact");
  await seed();
  redis.pipeline = (async (cs: (string | number)[][]) => {
    const replies = await pipe(cs);
    return cs.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:hash-del-if:v1") && c[3] === MEMBERS) ? replies.map((r, i) => (i === replies.length - 1 ? "1" : r)) : replies;
  }) as typeof redis.pipeline;
  const odd = await run();
  redis.pipeline = pipe;
  is("a count that is text is unknown", odd, "UnknownReply");

  part("A member who is not there");
  redis.clear();
  is("no member: nothing to delete, and no error", await run(), "done 0");
  is("no outside request", fetches, 0);
  done();
}
void main();
