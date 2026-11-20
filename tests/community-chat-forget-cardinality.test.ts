/**
 * forgetChatPerson (lib/community-chat.ts) confirms a deletion only by a count the command sent could give (#4796, Codex V,
 * transcribed and reproduced by Claude 2): a DEL cannot remove more keys than it named, a ZREM or HDEL more members or
 * fields, an HSET more fields. A larger count does not prove what was removed, so the person's erasure must not be said
 * finished on it. The test is the one reproduced in the issue, unchanged. Synthetic, in-memory Redis only.
 */
// Synthetic Redis only (tests/redis-stub.ts).
import { forgetChatPerson } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const base = `nl:cm:${COMMUNITY}`;
const ROOM = `${base}:ch`;
const SPOKE = `${base}:chs:${MEMBER}`;
const mine = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 100 });
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

async function threw(reply: unknown[]): Promise<boolean> {
  redis.clear();
  redis.run(["ZADD", ROOM, 100, mine]);
  redis.run(["SET", SPOKE, "1"]);
  let call = 0;
  redis.pipeline = (async (batch) => {
    call += 1;
    if (call === 1) return original(batch);
    await original(batch);
    return reply;
  }) as typeof redis.pipeline;
  try {
    await forgetChatPerson(COMMUNITY, MEMBER);
    return false;
  } catch {
    return true;
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Room: deletion counts stay within the commands' cardinality");
  is("control: the exact [1, 1] is accepted", await threw([1, 1]), false);
  is("DEL of one cooldown key cannot report two", await threw([2, 1]), true);
  is("ZREM of one room row cannot report two", await threw([1, 2]), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
