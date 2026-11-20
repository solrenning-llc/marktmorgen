/**
 * withinLimit and withinMonth (lib/request-guard.ts) let a request through
 * when Redis cannot be asked at all (it throws): these limits keep abuse
 * down, and a buyer is never kept from paying because a counter was out of
 * reach (Claude 1's decision of 05/11/2026, SG2 17). A reply that did come
 * back but is not the exact shape asked for is something else: an unknown
 * count, never room (CX-123 rule 24). So:
 *
 *   - the exact reply (a whole number of at least 1 for the INCR, 0 or 1 for
 *     the EXPIRE NX; lib/window-count.ts) is read: within the limit, yes; past it, no;
 *   - any other reply (a missing or extra part, a count as text, null, 0,
 *     true, a fraction, a negative number, an object) is refused;
 *   - a pipeline that throws still lets the request through, as before.
 */
import { withinLimit, withinMonth } from "@/lib/request-guard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The reply the counter gets instead of the real one; "throw" for a Redis that cannot be asked. */
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const counter = commands[0]?.[0] === "INCR" && /^nl:rlm?:/.test(String(commands[0][1]));
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
  // The counter's two replies (lib/window-count.ts): the INCR's count, then the EXPIRE NX's 0 or 1.
  ["only the INCR's answer", [1]],
  ["a third answer", [1, 1, 1]],
  ["an EXPIRE answered false", [1, false]],
  ["a count that is null", [null, 1]],
  ["a count written as text", ["1", 1]],
  ["a count of zero", [0, 1]],
  ["a count that is true", [true, 1]],
  ["a fractional count", [1.5, 1]],
  ["a negative count", [-1, 1]],
  ["a reply that is not a list", { result: 1 }],
  ["a returned list whose shape cannot be inspected", uninspectable],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  for (const [name, call] of [
    ["withinLimit", () => withinLimit("shape-test", "who", 5, 60)],
    ["withinMonth", () => withinMonth("shape-test", "who", 5, "2026-11")],
  ] as const) {
    part(`${name}: only the exact reply is read`);
    for (const [label, value] of MALFORMED) {
      reply = value;
      is(`${name}, ${label}: refused, never room`, await call(), false);
    }
    reply = [1, 1];
    is(`${name}: the first of the window (count 1, its expiry set) is within`, await call(), true);
    reply = [5, 0];
    is(`${name}: the last within (count 5, expiry already set) is within`, await call(), true);
    reply = [6, 0];
    is(`${name}: past the limit (count 6) is refused as before`, await call(), false);
    reply = "throw";
    is(`${name}: Redis that cannot be asked still lets the request through, as before`, await call(), true);
    reply = null;
    is(`${name}: the real counter still counts`, await call(), true);
  }
  done();
}

void main();
