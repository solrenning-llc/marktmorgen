/**
 * essentialLimitState (lib/request-guard.ts): the same counter, key and TTL as
 * withinEssentialLimit, with three answers instead of two, so a caller can
 * tell "past the limit" (429, "slow down") from "the count is unknown" (503,
 * "try again in a moment") and never tell a visitor to slow down when the
 * counter could not be read (VR; Codex Z's LEVE on #2773, Codex N on #2674).
 *
 *   - the exact reply within the limit: "within"; past it: "exceeded";
 *   - any other reply, a pipeline that throws, or a limit/window that is
 *     not a positive whole number: "unknown" (Redis not configured takes
 *     the same first guard);
 *   - withinEssentialLimit stays exactly "within" or not, so its callers
 *     do not change.
 */
import { essentialLimitState, withinEssentialLimit } from "@/lib/request-guard";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let reply: unknown = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const counter = commands[0]?.[0] === "SET" && /^nl:rl:/.test(String(commands[0][1]));
  if (counter && reply === "throw") throw new Error("the database did not answer");
  if (counter && reply !== null) return reply;
  return pipeline(commands);
}) as typeof redis.pipeline;

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
  ["a Redis that cannot be asked", "throw"],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const state = () => essentialLimitState("state-test", "who", 5, 60);
  const within = () => withinEssentialLimit("state-test", "who", 5, 60);

  part("unknown is its own answer, never room and never \"slow down\"");
  for (const [label, value] of MALFORMED) {
    reply = value;
    is(`${label}: unknown`, await state(), "unknown");
    is(`${label}: withinEssentialLimit still says no`, await within(), false);
  }

  part("the exact reply");
  reply = ["OK", 1];
  is("the first of the window: within", await state(), "within");
  is("the first of the window: withinEssentialLimit yes", await within(), true);
  reply = [null, 5];
  is("the last within: within", await state(), "within");
  reply = [null, 6];
  is("past the limit: exceeded", await state(), "exceeded");
  is("past the limit: withinEssentialLimit no", await within(), false);

  part("arguments and configuration");
  reply = ["OK", 1];
  for (const [label, limit, window] of [
    ["a limit of 0", 0, 60],
    ["a fractional limit", 1.5, 60],
    ["a window of 0", 5, 0],
    ["a negative window", 5, -1],
  ] as const) {
    is(`${label}: unknown`, await essentialLimitState("state-test", "who", limit, window), "unknown");
  }
  // Redis not configured is the same first guard as the arguments above; the stub is always configured.

  part("the real counter");
  reply = null;
  redis.clear();
  const seen: string[] = [];
  for (let n = 0; n < 6; n += 1) seen.push(await essentialLimitState("state-real", "who", 5, 60));
  is("five within, then exceeded", seen.join(","), "within,within,within,within,within,exceeded");
  done();
}

void main();
