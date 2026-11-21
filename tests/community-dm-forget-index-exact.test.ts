/**
 * forgetDmPerson (lib/community-dm.ts) deletes the member's own conversation indexes only when every reference in them
 * is a conversation it can attribute to that member (#4806, Codex X5, transcribed and reproduced by Claude 2): a
 * reference that is not this person's canonical pair was dropped silently, its conversation kept, and then the indexes,
 * the only way back to it, were deleted with the erasure said done. Such a reference now makes the scope unknown: it
 * throws before anything is deleted, and the erasure is tried again. The test is the one reproduced in the issue,
 * unchanged. Synthetic, in-memory Redis only.
 */
// Synthetic Redis only.
import { forgetDmPerson } from "@/lib/community-dm";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c0ffee00c0ffee00c0ffee00c0ffee00";
const WHO = "erased-member";
const PAIR = "different.member";
const base = `nl:cm:${COMMUNITY}:dm`;
const INBOX = `${base}:i:${WHO}`;
const CHAT = `${base}:${PAIR}`;

async function main(): Promise<void> {
  part("an index member that is not this person's canonical pair keeps the erasure retryable");
  redis.clear();
  redis.run(["ZADD", INBOX, 1, PAIR]);
  redis.run(["RPUSH", CHAT, JSON.stringify({ a: WHO, text: "Private", at: 1 })]);
  const outcome = await forgetDmPerson(COMMUNITY, WHO).then((n) => `resolved ${n}`, () => "threw");
  is("the erasure does not say done", outcome, "threw");
  is("the person's index is kept", redis.run(["ZRANGEBYSCORE", INBOX, "-inf", "+inf"]), [PAIR]);
  is("the conversation is still stored", (redis.run(["LRANGE", CHAT, 0, -1]) as string[]).length, 1);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
