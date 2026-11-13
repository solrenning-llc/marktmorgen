/**
 * lib/community-events.ts eventCount read ZCARD with `Number(n) || 0`: a reply in any other shape (no reply, an
 * error object, a text, a negative number) counted as no events, so a person's erasure (lib/person-erasure.ts
 * erasureSize) paid for fewer units than it then went through (MR; rule 24; Claude 4 nuvem R, forwarded to Claude 3
 * with the same finding in dealCount, conversationCount, dmCount and roomSize). Now it is ZCARD's own count, capped as
 * before, or UnknownReplyError; erasePerson then answers "unavailable" (its catch on erasureSize). Synthetic Redis only.
 */
import { eventCount } from "@/lib/community-events";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const real = redis.pipeline.bind(redis);
  part("a count in any other shape is unknown, never 0");
  for (const [label, reply] of [
    ["no reply", []],
    ["an error object", [{ error: "ERR synthetic" }]],
    ["a text", ["3"]],
    ["a negative number", [-1]],
    ["a fraction", [1.5]],
  ] as const) {
    redis.pipeline = (async () => reply) as never;
    let answer: unknown;
    try {
      answer = await eventCount("community-x");
    } catch (error) {
      answer = (error as Error).name;
    }
    is(`${label}: unknown`, answer, "UnknownReplyError");
  }
  redis.pipeline = real as never;
  part("control: ZCARD's own count");
  redis.pipeline = (async () => [4]) as never;
  is("four events read as four", await eventCount("community-x"), 4);
  redis.pipeline = (async () => [0]) as never;
  is("none read as none", await eventCount("community-x"), 0);
  redis.pipeline = real as never;
  done();
}

void main();
