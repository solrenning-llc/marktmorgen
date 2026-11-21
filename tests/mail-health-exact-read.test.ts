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
  const [rawBounces] = await redis.pipeline([["HGET", DAY, "b"]]);
  is("recovery never counts the same address twice", rawBounces, "25");
  part("A lost checkpoint answer is recovered without another count");
  redis.clear();
  await redis.pipeline([["HSET", DAY, "s", "1000", "b", "0", "c", "0"]]);
  let loseBegin = true;
  redis.pipeline = async commands => {
    const reply = await original.call(redis, commands);
    if (loseBegin && commands.some(command => command[0] === "EVAL")) {
      loseBegin = false;
      throw new Error("synthetic lost begin acknowledgement");
    }
    return reply;
  };
  const lostNotice = { ...notice, to: "lost-begin@example.test" };
  try { await heardFromSender(lostNotice, NOW); } catch { /* provider redelivers */ }
  redis.pipeline = original;
  is("the redelivery completes the counted event", await heardFromSender(lostNotice, NOW), "counted");
  const [afterLostBegin] = await redis.pipeline([["HGET", DAY, "b"]]);
  is("the lost begin acknowledgement still counts once", afterLostBegin, "1");
  let loseFinish = true;
  redis.pipeline = async commands => {
    const reply = await original.call(redis, commands);
    if (loseFinish && commands.some(command => command[0] === "SET" && command[2] === "done")) {
      loseFinish = false;
      throw new Error("synthetic lost finish acknowledgement");
    }
    return reply;
  };
  const finishedNotice = { ...notice, to: "lost-finish@example.test" };
  try { await heardFromSender(finishedNotice, NOW); } catch { /* provider redelivers */ }
  redis.pipeline = original;
  is("the redelivery recognizes the completed event", await heardFromSender(finishedNotice, NOW), "ignored");
  const [afterLostFinish] = await redis.pipeline([["HGET", DAY, "b"]]);
  is("the lost finish acknowledgement still counts once", afterLostFinish, "2");
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

  // Claude 6's review of #2687 (7057898559): the guards below fail open if removed, so each has its own case.
  part("LEVE 1: a restart day that does not read is unknown, never a clean week");
  const overWeek = ["1000", "30", "0"];
  is("a restart day that is not a date is unknown (bounces 30 of 1,000 never skipped)", await outcome(["garbage", overWeek, ...Array.from({ length: 6 }, emptyDay)]), "unknown");
  is("a restart day that is not text is unknown", await outcome([20261105, overWeek, ...Array.from({ length: 6 }, emptyDay)]), "unknown");
  is("an impossible calendar date is unknown", await outcome(["2026-02-31", overWeek, ...Array.from({ length: 6 }, emptyDay)]), "unknown");
  is("a real restart day still reads (control)", await outcome(["2026-11-01", overWeek, ...Array.from({ length: 6 }, emptyDay)]), "accepted");

  part("LEVE 2: a begin answer other than 0, 1 or 2 is unknown, never ignored");
  for (const [label, reply] of [["-1 (a seen mark in another shape)", [-1]], ["text", ["1"]], ["nothing", []]] as [string, unknown[]][]) {
    redis.clear();
    await redis.pipeline([["HSET", DAY, "s", "1000", "b", "0", "c", "0"]]);
    redis.pipeline = async commands => commands.some(command => command[0] === "EVAL") ? reply : original.call(redis, commands);
    let rejected = false;
    try { await heardFromSender({ ...notice, to: `begin-${label.length}@example.test` }, NOW); } catch { rejected = true; }
    redis.pipeline = original;
    is(`a begin answered with ${label} is refused, so the notice is heard again`, rejected, true);
  }

  part("LEVE 3: the pause's SET NX is read exactly");
  const overNotice = (to: string) => ({ ...notice, to });
  const pauseKey = `nl:mail:paused:${ID}`;
  const fromKey = `nl:mail:health:${ID}:from`;
  for (const [label, landed, expect] of [
    ["an answer in another shape that did not land", false, "refused"],
    ["an answer in another shape that landed (reply lost)", true, "paused"],
  ] as [string, boolean, string][]) {
    redis.clear();
    await redis.pipeline([["HSET", DAY, "s", "1000", "b", "24", "c", "0"]]);
    redis.pipeline = async commands => {
      if (commands.some(command => command[0] === "SET" && command[1] === pauseKey && command.includes("NX"))) {
        if (landed) await original.call(redis, commands);
        return [{ unexpected: true }];
      }
      return original.call(redis, commands);
    };
    let answer: string;
    try { answer = await heardFromSender(overNotice(`pause-${landed}@example.test`), NOW); } catch { answer = "refused"; }
    redis.pipeline = original;
    const [from] = await redis.pipeline([["GET", fromKey]]);
    is(`${label}: ${expect}`, [answer, from !== null], [expect, landed]);
  }
  redis.clear();
  await redis.pipeline([["HSET", DAY, "s", "1000", "b", "24", "c", "0"], ["SET", pauseKey, JSON.stringify({ reason: "bounces", until: 1, sent: 1, count: 1 })]]);
  is("a pause already running keeps its end and its restart day (null, control)", [await heardFromSender(overNotice("running@example.test"), NOW), (await redis.pipeline([["GET", fromKey]]))[0]], ["counted", null]);
  done();
}

void main();
