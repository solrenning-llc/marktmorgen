/**
 * A partial Redis week is not a healthy week (CX-123 rule 24).
 *
 * The seven daily HMGET replies are paid reads used to decide whether list
 * email must pause. Every reply has to be present and every counter has to be
 * an exact non-negative whole number. Missing or malformed evidence is
 * unknown, never zero.
 */
import { heardFromSender, listHealth, pausedFor } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "a".repeat(32);
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const DAY = `nl:mail:health:${ID}:2026-11-05`;
const emptyDay = () => [null, null, null];

async function outcome(reply: unknown): Promise<"accepted" | "unknown"> {
  const original = redis.pipeline;
  try {
    redis.pipeline = async () => reply as unknown[];
    await listHealth(ID, NOW);
    return "accepted";
  } catch {
    return "unknown";
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  part("Only the complete seven-day Redis answer is health evidence");
  is("a short pipeline envelope is unknown", await outcome([null]), "unknown");
  is(
    "a short HMGET day is unknown",
    await outcome([null, ["1000"], ...Array.from({ length: 6 }, emptyDay)]),
    "unknown",
  );
  is(
    "a malformed counter is unknown, never zero",
    await outcome([null, ["1000", "not-a-count", "0"], ...Array.from({ length: 6 }, emptyDay)]),
    "unknown",
  );
  is(
    "the exact reply remains readable",
    await outcome([null, ["1000", "25", "1"], ...Array.from({ length: 6 }, emptyDay)]),
    "accepted",
  );
  part("The threshold event survives an unknown week read and its redelivery");
  redis.clear();
  await redis.pipeline([["HSET", DAY, "s", "1000", "b", "24", "c", "0"]]);
  const original = redis.pipeline;
  redis.pipeline = async commands => commands.some(command => command[0] === "HMGET")
    ? [null]
    : original.call(redis, commands);
  let refused = false;
  const notice = { kind: "bounced" as const, permanent: true, to: "threshold@example.test", store: ID, list: "" };
  try { await heardFromSender(notice, NOW); } catch { refused = true; }
  redis.pipeline = original;
  is("the first unknown health read is refused", refused, true);
  is("the bounce was counted once before that read", (await listHealth(ID, NOW)).bounced, 25);
  await heardFromSender(notice, NOW);
  is("the redelivery re-evaluates and establishes the threshold pause", (await pausedFor(ID, NOW))?.reason, "bounces");
  is("recovery never counts the same address twice", (await listHealth(ID, NOW)).bounced, 25);
  part("An accessor cannot borrow confirmed evidence from a descriptor prototype");
  let visits = 0;
  const outer = [null, ...Array.from({ length: 7 }, emptyDay)];
  const inner = ["1000", "25", "1"];
  Object.defineProperty(outer, "1", { get: () => { visits += 1; return inner; } });
  const innerReply = [null, inner, ...Array.from({ length: 6 }, emptyDay)];
  Object.defineProperty(inner, "1", { get: () => { visits += 1; return "25"; } });
  const descriptorBefore = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  let outerResult: "accepted" | "unknown" = "accepted";
  let innerResult: "accepted" | "unknown" = "accepted";
  try {
    Object.defineProperty(Object.prototype, "value", { value: ["1000", "25", "1"], configurable: true });
    outerResult = await outcome(outer);
    Object.defineProperty(Object.prototype, "value", { value: "25", configurable: true });
    innerResult = await outcome(innerReply);
  } finally {
    delete (Object.prototype as { value?: unknown }).value;
    if (descriptorBefore) Object.defineProperty(Object.prototype, "value", descriptorBefore);
  }
  is("an outer accessor with inherited descriptor value is unknown", outerResult, "unknown");
  is("a daily accessor with inherited descriptor value is unknown", innerResult, "unknown");
  is("no health accessor ran", visits, 0);
  done();
}

void main();
