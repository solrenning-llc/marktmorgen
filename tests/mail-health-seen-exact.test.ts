/**
 * A bounce or a complaint from the sender (lib/mail-health.ts, heardFromSender)
 * is counted once per address a week, by a SET NX. It is counted only when
 * Redis answered exactly "OK", ignored only on exactly null, and any other
 * reply is unknown: it throws, so the sender's notice is retried and the same
 * address is never counted twice toward pausing a store's list (issue #4287,
 * item 9; Codex P).
 */
import { heardFromSender } from "@/lib/mail-health";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE = "d".repeat(32);
const original = redis.pipeline.bind(redis);
let seenReply: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (seenReply && commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith(`nl:mail:health:${STORE}:seen:`)) {
    const reply = seenReply;
    seenReply = null;
    return reply;
  }
  return original(commands);
}) as typeof redis.pipeline;

async function told(to: string, reply: unknown[] | null): Promise<string> {
  seenReply = reply;
  try {
    return await heardFromSender({ kind: "bounced", permanent: true, to, store: STORE, list: "" });
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  } finally {
    seenReply = null;
  }
}

async function main(): Promise<void> {
  redis.clear();
  part("Controls: Redis's own answers decide as before");
  is("a first bounce is counted", await told("one@example.com", null), "counted");
  is("the same address again is ignored", await told("one@example.com", null), "ignored");

  for (const [label, reply] of [
    ["no reply", []],
    ["two replies", ["OK", "OK"]],
    ["a number", [1]],
    ["a string other than OK", ["QUEUED"]],
  ] as const) {
    part(`The SET NX answers ${label}`);
    is("unknown: never counted, never ignored", await told(`${label.replace(/ /g, "")}@example.com`, [...reply]), "unknown");
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
