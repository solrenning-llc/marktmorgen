/**
 * Review of #2998 (Claude 4 team), two findings on forgetWelcomePerson
 * (lib/welcome-offer-send.ts), the welcome offer's erasure part:
 *
 *   L1 (rule 24): a queue member that names this person (it holds their
 *   address hash) but does not read as a reminder was taken as "not this
 *   person", so the erasure answered done while the member, with the plain
 *   address, stayed. It must reject (UnknownReplyError), so the part is said
 *   as not finished. A corrupt member that does not name the person is not
 *   theirs and stays.
 *
 *   L2 (MR, cost): the erasure walked the global queue of every store with
 *   ZSCAN, one command per thousand reminders anywhere. The mark that a
 *   reminder was set now holds the reminder's time, so the erasure reads only
 *   the reminders of that one second (ZRANGEBYSCORE), a page of 100 at a time
 *   within a fixed number of rounds. A mark written before ("1") still falls
 *   back to the scan; such a mark ends within a day after its offer.
 *
 * Synthetic data only: the in-memory Redis stand-in.
 */
import { createHash } from "node:crypto";
import { forgetWelcomePerson } from "@/lib/welcome-offer-send";
import { store as redis, redisPipeline } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const DUE = "nl:wo:due";
const STATS = "5b1f0c3e2a7d4e9f8c6b5a4d3e2f1a0b";
const OTHER_STATS = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const EMAIL = "person@example.com";
const WHEN = 2_000_000_000;
const hash = (email: string) => createHash("sha256").update(`welcome:${email.toLowerCase()}`).digest("hex").slice(0, 32);
const member = (statsId: string, email: string, token: string) => JSON.stringify({ s: `sid-${statsId.slice(0, 6)}`, i: statsId, h: hash(email), e: email, t: token });
const markKey = `nl:wo:r:${STATS}:${hash(EMAIL)}`;
const startKey = `nl:wo:start:${STATS}:${hash(EMAIL)}`;

const sentCommands: string[] = [];
let bad: { command: string; reply: (commands: (string | number)[][]) => unknown[] } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) sentCommands.push(String(command[0]));
  if (bad && commands.some((command) => command[0] === bad!.command)) return bad.reply(commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return `rejected: ${error instanceof Error ? error.name : "?"}`;
  }
}

async function queued(): Promise<string[]> {
  const [all] = await redisPipeline([["ZRANGEBYSCORE", DUE, "-inf", "+inf"]]);
  return (all as string[]).slice().sort();
}

/** One person's reminder waiting, its mark as written now (its time) or before ("1"). */
async function seed(mark: string, extra: [number, string][] = []): Promise<void> {
  await redisPipeline([["DEL", DUE, markKey, startKey]]);
  await redisPipeline([
    ["ZADD", DUE, String(WHEN), member(STATS, EMAIL, "tok-mine")],
    ["ZADD", DUE, String(WHEN), member(STATS, "neighbor@example.com", "tok-same-second")],
    ["ZADD", DUE, String(WHEN + 100), member(OTHER_STATS, EMAIL, "tok-other-store")],
    ...extra.map(([score, m]): (string | number)[] => ["ZADD", DUE, String(score), m]),
    ["SET", startKey, "1"],
    ["SET", markKey, mark],
  ]);
}

void (async () => {
  part("L1: a member naming the person that does not read as a reminder");
  const h = hash(EMAIL);
  const corrupt: [string, string][] = [
    ["cut short", `{"s":"sid-5b1f0c","i":"${STATS}","h":"${h}","e":"${EMAIL}"`],
    ["a list, not a reminder", JSON.stringify([STATS, h, EMAIL])],
    ["fields of another type", JSON.stringify({ i: 7, h, e: EMAIL })],
  ];
  for (const [mark, path] of [["1", "the scan (a mark written before)"], [String(WHEN), "the reminder's second (a mark holding its time)"]] as const) {
    for (const [what, m] of corrupt) {
      await seed(mark, [[WHEN, m]]);
      is(`found through ${path}, ${what}: the part is not finished`, await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    }
    await seed(mark, [[WHEN, `{"broken": "${hash("stranger@example.com")}"`]]);
    is(`control, through ${path}: a corrupt member that does not name the person is not theirs`, await forgetWelcomePerson(STATS, EMAIL), 3);
  }

  part("L2: the erasure reads one second of the queue, never the whole queue");
  const crowd: [number, string][] = [];
  for (let i = 0; i < 2_000; i += 1) crowd.push([WHEN - 50_000 + i, member(OTHER_STATS, `p${i}@example.com`, `tok-${i}`)]);
  await seed(String(WHEN), crowd);
  sentCommands.length = 0;
  const removed = await forgetWelcomePerson(STATS, EMAIL);
  is("the receipt counts the two marks and the reminder taken out", removed, 3);
  is("no scan of the global queue", sentCommands.filter((c) => c === "ZSCAN").length, 0);
  is("one read of that second", sentCommands.filter((c) => c === "ZRANGEBYSCORE").length, 1);
  const left = await queued();
  is("the person's reminder is gone", left.includes(member(STATS, EMAIL, "tok-mine")), false);
  is("the same second's other reminder and the other store's stay", [left.includes(member(STATS, "neighbor@example.com", "tok-same-second")), left.includes(member(OTHER_STATS, EMAIL, "tok-other-store")), left.length], [true, true, 2_002]);

  const sameSecond: [number, string][] = [];
  for (let i = 0; i < 250; i += 1) sameSecond.push([WHEN, member(OTHER_STATS, `q${i}@example.com`, `tok-q${i}`)]);
  await seed(String(WHEN), sameSecond);
  is("more than a page in the same second: read page by page, the reminder found", await forgetWelcomePerson(STATS, EMAIL), 3);
  is("and taken out", (await queued()).includes(member(STATS, EMAIL, "tok-mine")), false);

  await seed(String(WHEN));
  await redisPipeline([["DEL", markKey]]);
  sentCommands.length = 0;
  is("no mark: no reminder was set, the queue is not read", [await forgetWelcomePerson(STATS, EMAIL), sentCommands.filter((c) => c === "ZSCAN" || c === "ZRANGEBYSCORE").length], [1, 0]);

  part("Every new reply read in its exact shape");
  const markBad: [string, unknown][] = [
    ["a number", 7],
    ["text that is not a time", "soon"],
    ["a time of 0", "0"],
    ["a list", ["1"]],
  ];
  for (const [what, value] of markBad) {
    await seed(String(WHEN));
    bad = { command: "GET", reply: () => [value, 2] };
    is(`the mark answered ${what}: the part is not finished`, await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }
  await seed(String(WHEN));
  bad = { command: "GET", reply: () => [String(WHEN)] };
  is("the mark and deletion answered with one reply missing: the part is not finished", await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
  bad = null;
  const rangeBad: [string, unknown[]][] = [
    ["null", [null]],
    ["not a list", ["x"]],
    ["a member not text", [[1]]],
    ["no reply", []],
  ];
  for (const [what, reply] of rangeBad) {
    await seed(String(WHEN));
    bad = { command: "ZRANGEBYSCORE", reply: () => reply };
    is(`the read of that second answered ${what}: the part is not finished`, await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
    bad = null;
  }
  await seed(String(WHEN));
  const filler = Array.from({ length: 100 }, (_, i) => member(OTHER_STATS, `r${i}@example.com`, `tok-r${i}`));
  bad = { command: "ZRANGEBYSCORE", reply: () => [filler] };
  is("a second that never ends within its rounds: the part is not finished", await outcome(() => forgetWelcomePerson(STATS, EMAIL)), "rejected: UnknownReplyError");
  bad = null;

  done();
})();
