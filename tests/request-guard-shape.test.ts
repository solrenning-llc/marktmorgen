/**
 * withinLimit and withinMonth (lib/request-guard.ts) let a request through
 * when Redis cannot be asked at all (it throws): these limits keep abuse
 * down, and a buyer is never kept from paying because a counter was out of
 * reach (Claude 1's decision of 05/11/2026, SG2 17). A reply that did come
 * back but is not the exact shape asked for is something else: an unknown
 * count, never room (CX-123 rule 24). So:
 *
 *   - the exact reply (a whole number of at least 1 for the INCR, 1 or 0 for
 *     the EXPIRE NX that gives the count its end where it has none) is read
 *     as before: within the limit, yes; past it, no;
 *   - any other reply (a missing or extra part, a count as text, null, 0,
 *     true, a fraction, a negative number, an object) is refused;
 *   - a pipeline that throws still lets the request through, as before.
 */
import { essentialLimitState, withinLimit, withinMonth } from "@/lib/request-guard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** The reply the counter gets instead of the real one; "throw" for a Redis that cannot be asked. */
let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  // Changed (rule 23, review of #2819): the counter was matched by its first command, SET; it is now INCR then EXPIRE NX.
  const counter = commands[0]?.[0] === "INCR" && commands[1]?.[0] === "EXPIRE" && /^nl:rlm?:shape-/.test(String(commands[0][1]));
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

// Changed (rule 23, review of #2819): each reply was [the SET's "OK" or null, the count]; it is now [the count,
// the EXPIRE NX's 1 or 0], and "a SET answered false" became "an EXPIRE answered other than 1 or 0".
const MALFORMED: [string, unknown][] = [
  ["an empty reply", []],
  ["only the count", [1]],
  ["a third answer", [1, 1, 1]],
  ["an EXPIRE answered other than 1 or 0", [1, "OK"]],
  ["an EXPIRE answered null", [1, null]],
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
    is(`${name}: the first of the window (count 1, its end given) is within`, await call(), true);
    reply = [5, 0];
    is(`${name}: the last within (count 5, its end kept) is within`, await call(), true);
    reply = [6, 0];
    is(`${name}: past the limit (count 6) is refused as before`, await call(), false);
    reply = "throw";
    is(`${name}: Redis that cannot be asked still lets the request through, as before`, await call(), true);
    reply = null;
    is(`${name}: the real counter still counts`, await call(), true);
  }

  // A count that never ends (review of #2819): SET NX EX and then INCR went as two commands of a pipeline, which
  // Upstash does not run as one step. When the window ended between them, the INCR made the key again with no end,
  // and the client was held for ever. The count is now given its end after the INCR, where it has none.
  const counters = async () => (await redis.keys()).filter((k: string) => /^nl:rlm?:ttl-/.test(k));
  const counted: [string, () => Promise<unknown>][] = [
    ["withinLimit", () => withinLimit("ttl-limit", "who", 5, 60)],
    ["withinEssentialLimit", () => essentialLimitState("ttl-essential", "who", 5, 60)],
    ["withinMonth", () => withinMonth("ttl-month", "who", 5, "2026-11")],
  ];
  for (const [name, call] of counted) {
    part(`${name}: no count is ever left without an end`);
    for (const key of await counters()) redis.run(["DEL", key]);
    // The window ends right after the pipeline's first command, as Redis drops a key when its time is up.
    const sends = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!commands.some((c) => /^nl:rlm?:ttl-/.test(String(c[1])))) return sends(commands);
      const answers: unknown[] = [];
      for (const [i, command] of commands.entries()) {
        answers.push(...(await sends([command])));
        if (i === 0) for (const key of await counters()) redis.run(["DEL", key]);
      }
      return answers;
    }) as typeof redis.pipeline;
    await call();
    redis.pipeline = sends;
    is(`${name}: a window that ends between the commands leaves no count without an end`, (await counters()).map((k: string) => Number(redis.run(["TTL", k])) > 0), (await counters()).map(() => true));
    // A count the earlier code left with no end gets one at the next request, and still counts on from where it was.
    for (const key of await counters()) redis.run(["DEL", key]);
    await call();
    const [key] = await counters();
    redis.run(["SET", key, "3"]);
    is(`${name}: a count with no end left from before is given one, and counts on`, [await call(), redis.run(["GET", key]), Number(redis.run(["TTL", key])) > 0], [name === "withinEssentialLimit" ? "within" : true, "4", true]);
    // Never a later end for a count that has one: the window still starts with its first request.
    redis.run(["EXPIRE", key, 10]);
    await call();
    is(`${name}: a count that has an end keeps it`, Number(redis.run(["TTL", key])) <= 10, true);
  }
  done();
}

void main();
