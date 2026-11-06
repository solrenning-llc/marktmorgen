/**
 * forgetAssistReminderPerson (lib/assistant-reminder.ts), the Store assistant
 * checkout reminder's erasure part, the sibling of the welcome reminder fixed
 * on #2998:
 *
 *   Race: it read the address's note of checkouts (SMEMBERS) and deleted the
 *   note and the yeses in a second round trip. A yes written between the two
 *   (keepAssistReminder: SET the yes, SADD its checkout to the note) lost its
 *   note with the DEL while the yes itself, holding the address, stayed for
 *   three days where no later erasure could find it. After an erasure, every
 *   yes is either gone or still noted under its address.
 *
 *   Rule 24: the replies were read loosely (`Number(gone) || 0`, a list that
 *   was not one taken as empty), so an unknown reply turned into "0 removed"
 *   and the erasure said done. Each reply is now read in its exact shape and
 *   anything else rejects (UnknownReplyError), so the part is said as not
 *   finished.
 *
 * Synthetic data only: the in-memory Redis stand-in.
 */
import { createHash } from "node:crypto";
import { forgetAssistReminderPerson } from "@/lib/assistant-reminder";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "5b1f0c3e2a7d4e9f8c6b5a4d3e2f1a0b";
const EMAIL = "person@example.com";
const KEEP = 3 * 86_400;
const who = `nl:assist:remindwho:${STATS}:${createHash("sha256").update(`nimbus-assist-remind:${STATS}:${EMAIL}`).digest("hex").slice(0, 32)}`;
const session = (c: string) => `cs_test_${c.repeat(24)}`;
const yes = (s: string) => `nl:assist:remind:${s}`;
const consent = (s: string) => JSON.stringify({ s: STATS, e: EMAIL, t: "Email me a reminder if I don't finish this order", v: "1", l: "en", at: 1_790_000_000_000 + s.length });

/** As keepAssistReminder writes one yes (lib/assistant-reminder.ts), without its queue line. */
function keepCommands(s: string): (string | number)[][] {
  return [
    ["SET", yes(s), consent(s), "EX", KEEP],
    ["SADD", who, s],
    ["EXPIRE", who, KEEP],
  ];
}

let between: string | null = null;
let bad: { commands: string[]; reply: () => unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (bad && commands.some((command) => bad!.commands.includes(String(command[0])))) return commands.map(() => bad!.reply());
  const replies = await pipeline(commands);
  // The race: a yes written right after the erasure read the note, before anything was deleted.
  if (between && commands.some((command) => command[0] === "SMEMBERS" && command[1] === who)) {
    const s = between;
    between = null;
    await pipeline(keepCommands(s));
  }
  return replies;
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function seed(...sessions: string[]): Promise<void> {
  redis.clear();
  for (const s of sessions) await redisPipeline(keepCommands(s));
}

async function exists(key: string): Promise<number> {
  const [n] = await redisPipeline([["EXISTS", key]]);
  return Number(n);
}

async function scard(): Promise<number> {
  const [n] = await redisPipeline([["SCARD", who]]);
  return Number(n);
}

async function noted(s: string): Promise<number> {
  const [n] = await redisPipeline([["SISMEMBER", who, s]]);
  return Number(n);
}

void (async () => {
  part("Control: nothing in between, the yeses and their note go");
  await seed(session("a"), session("b"));
  is("two yeses and the note", await forgetAssistReminderPerson(STATS, EMAIL), 3);
  is("all gone", [await exists(yes(session("a"))), await exists(yes(session("b"))), await scard()], [0, 0, 0]);
  // The stand-in's SMEMBERS leaves an empty set behind where Redis would not, so only "finished" is held here.
  is("nothing kept: the erasure finishes", typeof (await outcome(() => forgetAssistReminderPerson(STATS, EMAIL))), "number");

  part("Race: a yes written between the read of the note and the deletion");
  await seed(session("a"));
  between = session("c");
  const removed = await outcome(() => forgetAssistReminderPerson(STATS, EMAIL));
  is("the race ran", between, null);
  const orphan = (await exists(yes(session("c")))) === 1 && (await noted(session("c"))) === 0;
  is("the yes written in between is never left with the address and no note", orphan, false);
  is("the yes read before is gone", await exists(yes(session("a"))), 0);
  is("the erasure deleted it too, or said what it removed", removed, 3);
  is("a second erasure leaves nothing with the address", [await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), await exists(yes(session("c"))), await scard()], [0, 0, 0]);

  part("Rule 24: the deletion's reply read in its exact shape");
  const deletion: [string, unknown][] = [
    ["OK", "OK"],
    ["null", null],
    ["a fraction", 1.5],
    ["a number as text", "2"],
    ["a list", [2]],
    ["below zero", -2],
    ["more than the note and its yeses", 99],
  ];
  for (const [what, reply] of deletion) {
    await seed(session("a"));
    bad = { commands: ["DEL", "EVAL", "EVALSHA"], reply: () => reply };
    is(`a deletion answered ${what}: the part is not finished`, await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }

  part("Rule 24: the note's reply read in its exact shape");
  const note: [string, unknown][] = [
    ["null", null],
    ["text", "cs_test_x"],
    ["a list with a number", [7]],
    ["a list with null", [null]],
  ];
  for (const [what, reply] of note) {
    await seed(session("a"));
    bad = { commands: ["SMEMBERS"], reply: () => reply };
    is(`a note answered ${what}: the part is not finished`, await outcome(() => forgetAssistReminderPerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
    is(`and after a note answered ${what}, the yes is still found by the next erasure`, [await exists(yes(session("a"))), await noted(session("a"))], [1, 1]);
  }

  done();
})();
