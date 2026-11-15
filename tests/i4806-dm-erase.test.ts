/**
 * Erasing one member's private messages (lib/community-dm.ts, forgetDmPerson), two defects transcribed by Claude 2:
 *
 *   - #4806 (Codex X5, MEDIUM): a member of their inbox or request list that is not the canonical name of a pair holding
 *     exactly them was filtered out in silence, then their own lists were deleted and the step said done, while the
 *     conversation under that name stayed stored with no path left to find it. Now it is unknown: nothing is deleted.
 *   - #4795 (Codex V, MEDIUM): a DEL or ZREM count above what the command sent could delete (a DEL of two keys
 *     answering 3, the DEL of the three own lists answering 4) was taken as confirmed. Now it is unknown.
 *
 * Either way the erasure stays pending and is tried again; exact replies inside their bounds go on as before.
 * Synthetic Redis only.
 */
import { CREATOR } from "@/lib/community";
import { forgetDmPerson, pairOf } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c0ffee00c0ffee00c0ffee00c0ffee00";
const base = `nl:cm:${COMMUNITY}:dm`;
const WHO = "a".repeat(32);
const OTHER = "b".repeat(32);
const THIRD = "d".repeat(32);
const msg = JSON.stringify({ a: WHO, text: "Private", at: 1 });
type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
const outcome = (run: () => Promise<number>) => run().then((n) => `resolved ${n}`, (e: unknown) => (e instanceof Error ? e.name : "threw"));
const inbox = (who: string) => redis.run(["ZRANGEBYSCORE", `${base}:i:${who}`, "-inf", "+inf"]) as string[];

function seedPairs(): void {
  redis.clear();
  for (const other of [OTHER, THIRD]) {
    const pair = pairOf(WHO, other);
    redis.run(["RPUSH", `${base}:${pair}`, msg]);
    redis.run(["HSET", `${base}:r:${pair}`, WHO, 1]);
    redis.run(["ZADD", `${base}:i:${WHO}`, 1, pair]);
    redis.run(["ZADD", `${base}:i:${other}`, 1, pair]);
  }
}

async function main(): Promise<void> {
  console.error = () => {};
  // Review 5bNDa (LEVE 1, adopted): an erasure stuck for good fails the right to erasure. A member holding this person is
  // theirs, canonical or not: deleted under the very name stored, the other names' lists cleared of it, and logged.
  // One without them is somebody else's and stays. Only what cannot be read is unknown.
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  part("#4806: a member holding this person, canonical or not, is deleted under the name stored");
  const reversed = `${OTHER}.${WHO}`;
  for (const [label, member, others] of [
    ["this person and another, not in order", reversed, [OTHER]],
    ["three names", `${WHO}.${OTHER}.${THIRD}`, [OTHER, THIRD]],
    ["this person alone", WHO, []],
    ["this person with themselves", `${WHO}.${WHO}`, []],
  ] as [string, string, string[]][]) {
    redis.clear();
    logged.length = 0;
    redis.run(["ZADD", `${base}:i:${WHO}`, 1, member]);
    redis.run(["RPUSH", `${base}:${member}`, msg]);
    redis.run(["HSET", `${base}:r:${member}`, WHO, 1]);
    for (const other of others) redis.run(["ZADD", `${base}:q:${other}`, 1, member]);
    is(`${label}: done, one`, await outcome(() => forgetDmPerson(COMMUNITY, WHO)), "resolved 1");
    is(`${label}: the conversation and its read marks are gone`, [redis.run(["LLEN", `${base}:${member}`]), redis.run(["HLEN", `${base}:r:${member}`])], [0, 0]);
    is(`${label}: nobody's list names it`, [inbox(WHO), ...others.map((o) => redis.run(["ZRANGEBYSCORE", `${base}:q:${o}`, "-inf", "+inf"]))], [[], ...others.map(() => [])]);
    is(`${label}: the name not canonical is logged`, logged.some((line) => line.includes("not canonical")), true);
  }
  part("#4806: a member without this person is somebody else's, and stays");
  for (const [label, member] of [["another pair's name", pairOf(OTHER, THIRD)], ["a name without this person", "different.member"]] as [string, string][]) {
    redis.clear();
    redis.run(["ZADD", `${base}:i:${WHO}`, 1, member]);
    redis.run(["RPUSH", `${base}:${member}`, msg]);
    is(`${label}: done, none of theirs`, await outcome(() => forgetDmPerson(COMMUNITY, WHO)), "resolved 0");
    is(`${label}: the other people's conversation is kept`, redis.run(["LLEN", `${base}:${member}`]), 1);
    is(`${label}: this person's own list is deleted`, inbox(WHO), []);
  }
  part("#4806: a list that cannot be read is unknown, and nothing is deleted");
  redis.clear();
  redis.run(["ZADD", `${base}:i:${WHO}`, 1, pairOf(WHO, OTHER)]);
  redis.pipeline = (async (batch: Command[]) => (batch[0]?.[0] === "ZRANGEBYSCORE" ? [[7], []] : original(batch))) as typeof redis.pipeline;
  const unread = await outcome(() => forgetDmPerson(COMMUNITY, WHO));
  redis.pipeline = original;
  is("a member that is not text: unknown", unread, "UnknownReplyError");
  is("the person's list kept for the retry", inbox(WHO), [pairOf(WHO, OTHER)]);
  console.error = () => {};
  part("#4806 controls: exact empty lists finish; canonical pairs, the creator's included, are deleted for both people");
  redis.clear();
  is("nothing listed: done, none", await outcome(() => forgetDmPerson(COMMUNITY, WHO)), "resolved 0");
  seedPairs();
  const withCreator = pairOf(WHO, CREATOR);
  redis.run(["RPUSH", `${base}:${withCreator}`, msg]);
  redis.run(["ZADD", `${base}:q:${WHO}`, 1, withCreator]);
  redis.run(["ZADD", `${base}:i:${CREATOR}`, 1, withCreator]);
  is("three canonical pairs: done, three", await outcome(() => forgetDmPerson(COMMUNITY, WHO)), "resolved 3");
  const left = redis.keys().filter((k) => k.includes(WHO));
  is("nothing of them left", [left, inbox(OTHER), inbox(THIRD), inbox(CREATOR)], [[], [], [], []]);

  part("#4795: deletion counts stay within what each command could delete");
  const bent = async (answer: (batch: Command[], replies: unknown[]) => unknown[] | null) => {
    seedPairs();
    redis.pipeline = (async (batch: Command[]) => {
      const replies = await original(batch);
      return answer(batch, replies) ?? replies;
    }) as typeof redis.pipeline;
    try {
      return await outcome(() => forgetDmPerson(COMMUNITY, WHO));
    } finally {
      redis.pipeline = original;
    }
  };
  const isBatch = (b: Command[]) => b.length > 2 && b[0][0] === "DEL" && b[0].length === 3;
  const isOwn = (b: Command[]) => b.length === 1 && b[0][0] === "DEL" && b[0].length === 4;
  is("a DEL of two conversation keys reporting 3", await bent((b, r) => (isBatch(b) ? [3, ...r.slice(1)] : null)), "UnknownReplyError");
  is("the person's own lists kept for the retry", inbox(WHO).length, 2);
  is("a ZREM of one member reporting 2", await bent((b, r) => (isBatch(b) ? [r[0], 2, ...r.slice(2)] : null)), "UnknownReplyError");
  is("the DEL of the three own lists reporting 4", await bent((b) => (isOwn(b) ? [4] : null)), "UnknownReplyError");
  is("a negative count", await bent((b, r) => (isBatch(b) ? [-1, ...r.slice(1)] : null)), "UnknownReplyError");
  is("control: every count at its most is done", await bent((b, r) => (isBatch(b) ? r.map((_, i) => (i % 3 === 0 ? 2 : 1)) : isOwn(b) ? [3] : null)), "resolved 2");
  is("control: every count at none is done", await bent((b, r) => (isBatch(b) ? r.map(() => 0) : isOwn(b) ? [0] : null)), "resolved 2");
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
