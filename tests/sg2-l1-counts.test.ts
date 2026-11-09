/**
 * Counters read only in their exact shape (audit SG2, CX-123 rule 24).
 *
 * Each of these read a Redis counter with Number(), which turns null into 0
 * and "5" into 5, and so let a malformed reply authorize something:
 *
 *   - takeCredit (lib/closing-credit.ts) and takeCalls (lib/closing-holds.ts)
 *     read a DECRBY/HINCRBY total of null as "0 left, taken": a closing email
 *     or a call to the creator's Stripe account was authorized on nothing.
 *     Now only a whole number is read; anything else throws UnknownReplyError,
 *     and nothing is given back, since it is not known whether the take ran.
 *   - freeDeliveryPaused (lib/delivery.ts) answered "not paused" to anything
 *     it could not read, and to an error. Free copies are paid for by nobody,
 *     so an unknown counter now pauses them; a key that does not exist yet
 *     (nothing sent this month) does not.
 *   - deliveredThisMonth (lib/delivery.ts) read an unknown counter as 0 bytes
 *     sent, a certain figure on the studio. It now answers null, and the
 *     studio leaves the card out.
 *   - orderWriteCharged (lib/order-data.ts) read a script's "charged" of null
 *     as 0 bytes charged to the plan's storage meter.
 *
 * The exact replies keep working as before.
 */
import { returnCredit, startClosingCredit, takeCredit } from "@/lib/closing-credit";
import { startCallBudget, takeCalls } from "@/lib/closing-holds";
import { deliveredThisMonth, freeDeliveryPaused, FREE_PAUSE_ABOVE_BYTES } from "@/lib/delivery";
import { orderWriteCharged } from "@/lib/order-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
/** The reply a matching pipeline gets instead of the real one; "throw" for a Redis that cannot be asked. */
let rule: Rule | null = null;
/** Every pipeline sent, so a test can see that nothing was given back. */
const sent: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  sent.push(commands);
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

const first = (name: string, prefix: string) => (commands: (string | number)[][]) =>
  commands[0]?.[0] === name && String(commands[0]?.[1]).startsWith(prefix);

/** "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

/** Whether any pipeline sent since `from` holds a command named `name` on a key starting with `prefix`. */
const sentSince = (from: number, name: string, prefix: string) =>
  sent.slice(from).some((commands) => commands.some((c) => c[0] === name && String(c[1]).startsWith(prefix)));

/** Replies a signed total (DECRBY, HINCRBY) must never be read from. */
const BAD_TOTALS: [string, unknown][] = [
  ["a total that is null", [null]],
  ["a total written as text", ["5"]],
  ["a total of zero written as text", ["0"]],
  ["a total that is true", [true]],
  ["a fractional total", [0.5]],
  ["a negative fractional total", [-0.5]],
  ["a total that is an object", [{ result: 3 }]],
  ["a total that is a list", [[3]]],
  ["an empty reply", []],
  ["a second, unasked-for reply", [3, 1]],
  ["a reply that is not a list", { result: 3 }],
];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("takeCredit: a closing's email is taken only on a whole number");
  for (const [label, reply] of [...BAD_TOTALS, ["a Redis that cannot be asked", "throw"] as [string, unknown]]) {
    await startClosingCredit("credit-shape", 10);
    rule = { when: first("DECRBY", "nl:closing:credit:"), reply };
    const from = sent.length;
    is(`takeCredit, ${label}: refused as unknown, never taken`, await outcome(() => takeCredit("credit-shape", 1)), "rejected");
    is(`takeCredit, ${label}: nothing given back, since the take may have run`, sentSince(from, "INCRBY", "nl:closing:credit:"), false);
  }
  rule = { when: first("DECRBY", "nl:closing:credit:"), reply: [0] };
  is("takeCredit: the last one left (0 after) is taken", await takeCredit("credit-shape", 1), true);
  rule = { when: first("DECRBY", "nl:closing:credit:"), reply: [-1] };
  {
    const from = sent.length;
    is("takeCredit: past what was left (-1 after) is refused", await takeCredit("credit-shape", 1), false);
    is("takeCredit: and what was taken past it is given back, as before", sentSince(from, "INCRBY", "nl:closing:credit:"), true);
  }
  rule = null;
  await startClosingCredit("credit-real", 2);
  is("takeCredit: the real counter still takes", [await takeCredit("credit-real", 1), await takeCredit("credit-real", 1), await takeCredit("credit-real", 1)], [true, true, false]);
  await returnCredit("credit-real", 1);
  is("takeCredit: and gives back", await takeCredit("credit-real", 1), true);

  part("takeCalls: a call to the creator's Stripe account is taken only on a whole number");
  for (const [label, reply] of [...BAD_TOTALS, ["a Redis that cannot be asked", "throw"] as [string, unknown]]) {
    await startCallBudget("calls-shape", 10);
    rule = { when: first("HINCRBY", "nl:closing:work:"), reply };
    const from = sent.length;
    is(`takeCalls, ${label}: refused as unknown, never taken`, await outcome(() => takeCalls("calls-shape", 2)), "rejected");
    is(`takeCalls, ${label}: nothing given back, since the take may have run`, sentSince(from + 1, "HINCRBY", "nl:closing:work:"), false);
  }
  rule = { when: first("HINCRBY", "nl:closing:work:"), reply: [0] };
  is("takeCalls: the last ones left (0 after) are taken", await takeCalls("calls-shape", 2), true);
  rule = { when: first("HINCRBY", "nl:closing:work:"), reply: [-1] };
  {
    const from = sent.length;
    is("takeCalls: past what was left is refused", await takeCalls("calls-shape", 2), false);
    is("takeCalls: and given back, as before", sentSince(from + 1, "HINCRBY", "nl:closing:work:"), true);
  }
  rule = null;
  await startCallBudget("calls-real", 3);
  is("takeCalls: the real budget still takes", [await takeCalls("calls-real", 2), await takeCalls("calls-real", 2), await takeCalls("calls-real", 1, "calls")], [true, false, true]);
  is("takeCalls: nothing asked is nothing taken, without asking Redis", await takeCalls("calls-real", 0), true);

  part("freeDeliveryPaused: an unknown counter pauses free copies");
  const over = String(FREE_PAUSE_ABOVE_BYTES + 1);
  const BAD_GETS: [string, unknown][] = [
    ["a count that is not a number", ["lots"]],
    ["a negative count", ["-5"]],
    ["a fractional count", ["1.5"]],
    ["a count with a space", [" 5"]],
    ["a count that is true", [true]],
    ["a count that is an object", [{ result: "5" }]],
    ["an empty reply", []],
    ["a second, unasked-for reply", ["5", "5"]],
    ["a reply that is not a list", { result: "5" }],
    ["a Redis that cannot be asked", "throw"],
  ];
  for (const [label, reply] of BAD_GETS) {
    rule = { when: first("GET", "nl:store:delivery:"), reply };
    is(`freeDeliveryPaused, ${label}: paused`, await freeDeliveryPaused("free-shape"), true);
  }
  rule = { when: first("GET", "nl:store:delivery:"), reply: [null] };
  is("freeDeliveryPaused: nothing sent this month (no key) is not paused", await freeDeliveryPaused("free-shape"), false);
  rule = { when: first("GET", "nl:store:delivery:"), reply: ["5"] };
  is("freeDeliveryPaused: a count below the line is not paused", await freeDeliveryPaused("free-shape"), false);
  rule = { when: first("GET", "nl:store:delivery:"), reply: [over] };
  is("freeDeliveryPaused: a count past the line is paused", await freeDeliveryPaused("free-shape"), true);

  part("deliveredThisMonth: an unknown counter is not shown as a figure");
  for (const [label, reply] of BAD_GETS) {
    rule = { when: first("GET", "nl:store:delivery:"), reply };
    is(`deliveredThisMonth, ${label}: unknown (null), never 0 bytes`, await deliveredThisMonth("seen-shape"), null);
  }
  rule = { when: first("GET", "nl:store:delivery:"), reply: [null] };
  is("deliveredThisMonth: nothing sent this month (no key) is 0 bytes", (await deliveredThisMonth("seen-shape"))?.bytes, 0);
  rule = { when: first("GET", "nl:store:delivery:"), reply: ["1024"] };
  is("deliveredThisMonth: a count is read", (await deliveredThisMonth("seen-shape"))?.bytes, 1024);
  rule = null;

  part("orderWriteCharged: what the storage meter was charged is read only as a whole number");
  const owner = { sid: "sg2-l1-order" };
  const command: (string | number)[] = ["HSETNX", "nl:sg2-l1:order", "p1", "1"];
  const SCRIPT = (commands: (string | number)[][]) => commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:order-write:v1");
  for (const [label, reply] of [
    ["a charge that is null", [[null, 1]]],
    ["a charge written as text", [["16", 1]]],
    ["a charge that is true", [[true, 1]]],
    ["a fractional charge", [[1.5, 1]]],
    ["a negative charge", [[-16, 1]]],
    ["a charge that is an object", [[{ n: 16 }, 1]]],
    ["a reply missing the command's answer", [[16]]],
    ["a script answer that is not a list", [{ charged: 16 }]],
    ["an empty pipeline reply", []],
    ["a Redis that cannot be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: SCRIPT, reply };
    is(`orderWriteCharged, ${label}: refused, never charged 0`, await outcome(() => orderWriteCharged(owner, [command])), "rejected");
  }
  rule = { when: SCRIPT, reply: [[16, 1]] };
  is("orderWriteCharged: the exact reply is read", await orderWriteCharged(owner, [command]), { charged: 16, replies: [1] });
  rule = null;
  is("orderWriteCharged: the real script still charges", (await orderWriteCharged(owner, [command])).charged > 0, true);

  done();
}

void main();
