/**
 * A person's erasure is never reported done on a count its command cannot give (rows 70, 71 and 72 of #5010; Codex
 * G-20261120-0325, G-20261120-0130 and G-20261120-0235). Each forget below read a DEL, HDEL or ZREM with countOf
 * alone, so a reply larger than the keys or members it named (a DEL of one key answering 7) was taken as removed. Each
 * now reads it with countWithin (lib/redis-reply.ts): a count above what the command can return is unknown and throws,
 * as any other shape does, so the erasure is pressed again. The in-memory Redis only; the impossible replies are
 * written by a stand-in pipeline.
 */
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { forgetGrantPerson } from "@/lib/chat-grant";
import { forgetVoicePerson } from "@/lib/customer-voice";
import { forgetAccessPerson } from "@/lib/community-access";
import { forgetRsvpsPerson } from "@/lib/community-events";
import { forgetPointsPerson } from "@/lib/community-points";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
// The shapes the forgets accept (lib/community-points.ts COMMUNITY and MEMBER): 32 hex characters each.
const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const STATS = "s_erasure_counts_0001";

/** The forget's answer, or "threw" when it threw: an erasure is never "done" on a count it cannot trust. */
const outcome = (p: Promise<number>) => p.then((n) => n, () => "threw" as const);

/**
 * Runs `run` with every DEL, UNLINK, HDEL and ZREM answered `count`, and every list read answered `listed` (so a
 * forget that reads its events first finds some), the rest as Redis answers.
 */
async function answering<T>(count: number, run: () => Promise<T>, listed: string[] = []): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => {
    const replies = await real(commands);
    return commands.map((c, i) => {
      const op = String(c[0]).toUpperCase();
      if (op === "DEL" || op === "UNLINK" || op === "HDEL" || op === "ZREM") return count;
      if (op === "ZRANGEBYSCORE" && listed.length) return listed;
      return replies[i];
    });
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("Row 70: a calendar feed copy, a room leave and the customer voice summaries");
  is("the feed copy: a DEL of one key answering 1 is a count", await outcome(answering(1, () => forgetFeedCopyPerson(STATS))), 1);
  is("the feed copy: a DEL of one key answering 7 is never taken", await outcome(answering(7, () => forgetFeedCopyPerson(STATS))), "threw");
  is("the room leave: a DEL of one key answering 1 is a count", await outcome(answering(1, () => forgetGrantPerson(COMMUNITY, MEMBER))), 1);
  is("the room leave: a DEL of one key answering 7 is never taken", await outcome(answering(7, () => forgetGrantPerson(COMMUNITY, MEMBER))), "threw");
  is("the voice summaries: each DEL within its keys is a count", typeof (await outcome(answering(1, () => forgetVoicePerson(STATS)))), "number");
  is("the voice summaries: a DEL answering more than its keys is never taken", await outcome(answering(999, () => forgetVoicePerson(STATS))), "threw");

  part("Row 71: a member's community access answers");
  const spaces = ["space00000001"];
  const products = ["prod00000001"];
  // The DEL names the ok key, the holdings key, one space key and one course door: 4 keys; the HDEL names one field.
  is("within: a DEL of 4 keys answering 1 and an HDEL of one field answering 1", await outcome(answering(1, () => forgetAccessPerson(COMMUNITY, "member@example.com", spaces, products))), 2);
  is("an HDEL of one field answering 2 is never taken", await outcome(answering(2, () => forgetAccessPerson(COMMUNITY, "member@example.com", spaces, products))), "threw");
  is("a DEL of 4 keys answering 9 is never taken", await outcome(answering(9, () => forgetAccessPerson(COMMUNITY, "member@example.com", [], []))), "threw");

  part("Row 72: a member's RSVPs and community points");
  const events = ["event0000001", "event0000002"];
  is("RSVPs: each HDEL of one field and the DEL within their counts", await outcome(answering(1, () => forgetRsvpsPerson(COMMUNITY, MEMBER, "member@example.com"), events)), 2);
  is("RSVPs: an HDEL of one field answering 2 is never taken", await outcome(answering(2, () => forgetRsvpsPerson(COMMUNITY, MEMBER, "member@example.com"), events)), "threw");
  const points = await outcome(answering(1, () => forgetPointsPerson(COMMUNITY, MEMBER)));
  is("points: each ZREM of one member and the DEL within their counts (the forget ran)", typeof points === "number" && points > 0, true);
  is("points: a ZREM of one member answering 2 is never taken", await outcome(answering(2, () => forgetPointsPerson(COMMUNITY, MEMBER))), "threw");
  done();
}

void main();
