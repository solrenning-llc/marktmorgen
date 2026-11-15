/**
 * #4796 (Codex V, transcribed by Claude 2): forgetChatPerson took any non-negative count as a confirmed deletion, so
 * a DEL of the one cooldown key answering 2, or a ZREM of their rows answering more rows than were sent, finished the
 * erasure of the room on a reply that confirms nothing. Each count must lie within what its command could delete:
 * DEL of one key 0..1, ZREM of n rows 0..n; anything else throws (rule 24) and the erasure stays to be repeated.
 * Synthetic Redis only (tests/redis-stub.ts).
 */
import { forgetChatPerson } from "@/lib/community-chat";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const base = `nl:cm:${COMMUNITY}`;
const ROOM = `${base}:ch`;
const SPOKE = `${base}:chs:${MEMBER}`;
const mine = JSON.stringify({ i: 1, a: MEMBER, text: "Mine", at: 100 });
const theirsToo = JSON.stringify({ i: 2, a: MEMBER, text: "Mine again", at: 101 });
const original: typeof redis.pipeline = redis.pipeline.bind(redis);

/** Runs the eraser with the room holding `rows` of the member's, the deletion's replies replaced by `reply`. */
async function outcome(rows: string[], reply: unknown[] | null): Promise<"threw" | number> {
  redis.clear();
  rows.forEach((row, i) => redis.run(["ZADD", ROOM, 100 + i, row]));
  redis.run(["SET", SPOKE, "1"]);
  let call = 0;
  redis.pipeline = (async (batch) => {
    call += 1;
    if (call === 1 || reply === null) return original(batch);
    await original(batch);
    return reply;
  }) as typeof redis.pipeline;
  try {
    return await forgetChatPerson(COMMUNITY, MEMBER);
  } catch {
    return "threw";
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Counts within what each command could delete are confirmed");
  is("control: the real replies erase both rows", await outcome([mine, theirsToo], null), 2);
  is("exact [1, 1] for one row", await outcome([mine], [1, 1]), 1);
  is("[0, 0]: nothing was there any more, still confirmed", await outcome([mine], [0, 0]), 1);
  is("[1, 2] for two rows", await outcome([mine, theirsToo], [1, 2]), 2);
  is("no rows of theirs: the cooldown alone, [1]", await outcome([], [1]), 0);

  part("A count above what was sent confirms nothing");
  is("DEL of one cooldown key cannot report two", await outcome([mine], [2, 1]), "threw");
  is("ZREM of one row cannot report two", await outcome([mine], [1, 2]), "threw");
  is("ZREM of two rows cannot report three", await outcome([mine, theirsToo], [1, 3]), "threw");
  is("DEL alone cannot report two", await outcome([], [2]), "threw");

  part("Other shapes still throw");
  is("a negative count", await outcome([mine], [1, -1]), "threw");
  is("a reply short of the commands sent", await outcome([mine], [1]), "threw");
  done();
}

main();
