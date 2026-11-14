/**
 * withinLimit and withinMonth (lib/request-guard.ts) let a request through
 * when Redis cannot be asked at all (it throws): these limits keep abuse
 * down, and a buyer is never kept from paying because a counter was out of
 * reach (Claude 1's decision of 05/11/2026, SG2 17). A reply that did come
 * back but is not the exact shape asked for is something else: an unknown
 * count, never room (CX-123 rule 24). So:
 *
 *   - the exact reply ("OK" or null for the SET, a whole number of at least
 *     1 for the INCR) is read as before: within the limit, yes; past it, no;
 *   - any other reply (a missing or extra part, a count as text, null, 0,
 *     true, a fraction, a negative number, an object) is never room:
 *     withinLimit throws UnknownReplyError, so its caller says it could not
 *     check rather than "too many" (tests/limit-unknown.test.ts), and
 *     withinMonth refuses;
 *   - a pipeline that throws still lets the request through, as before.
 */
import { withinLimit, withinMonth } from "@/lib/request-guard";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The reply the counter gets instead of the real one; "throw" for a Redis that cannot be asked. */
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const counter = commands[0]?.[0] === "SET" && /^nl:rlm?:/.test(String(commands[0][1]));
  if (counter && reply === "throw") throw new Error("the database did not answer");
  if (counter && reply !== null) return reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

// Codex Q's case on #2670: a list that came back but throws when its shape is looked at. A revoked proxy cannot
// be used for it: every promise resolution reads "then" first, so it would reject inside the pipeline itself,
// which is "Redis could not be asked". This one comes back through the promise ("then" reads as undefined) and
// throws only when its own properties are inspected.
const uninspectable = new Proxy([], {
  getOwnPropertyDescriptor() {
    throw new Error("this reply cannot be inspected");
  },
});

const MALFORMED: [string, unknown][] = [
  ["an empty reply", []],
  ["only the SET's answer", ["OK"]],
  ["a third answer", ["OK", 1, 1]],
  ["a SET answered false", [false, 1]],
  ["a count that is null", ["OK", null]],
  ["a count written as text", ["OK", "1"]],
  ["a count of zero", ["OK", 0]],
  ["a count that is true", ["OK", true]],
  ["a fractional count", ["OK", 1.5]],
  ["a negative count", ["OK", -1]],
  ["a reply that is not a list", { result: 1 }],
  ["a returned list whose shape cannot be inspected", uninspectable],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  /** What a counter answered, with an unknown count (UnknownReplyError) said as "unknown". */
  const read = async (call: () => Promise<boolean>): Promise<boolean | "unknown"> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof UnknownReplyError) return "unknown";
      throw error;
    }
  };
  for (const [name, call, refused] of [
    ["withinLimit", () => read(() => withinLimit("shape-test", "who", 5, 60)), "unknown"],
    ["withinMonth", () => read(() => withinMonth("shape-test", "who", 5, "2026-11")), false],
  ] as const) {
    part(`${name}: only the exact reply is read`);
    for (const [label, value] of MALFORMED) {
      reply = value;
      is(`${name}, ${label}: ${refused === "unknown" ? "unknown" : "refused"}, never room`, await call(), refused);
    }
    reply = ["OK", 1];
    is(`${name}: the first of the window (SET "OK", count 1) is within`, await call(), true);
    reply = [null, 5];
    is(`${name}: the last within (SET null, count 5) is within`, await call(), true);
    reply = [null, 6];
    is(`${name}: past the limit (count 6) is refused as before`, await call(), false);
    reply = "throw";
    is(`${name}: Redis that cannot be asked still lets the request through, as before`, await call(), true);
    reply = null;
    is(`${name}: the real counter still counts`, await call(), true);
  }
  done();
}

void main();
