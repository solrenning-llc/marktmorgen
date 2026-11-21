import { MAX_REWARDS, award, pointsRecordOf } from "@/lib/community-points";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const PRODUCT = "course123";
const NOW = Date.UTC(2026, 10, 5, 12);
const TODAY = Math.floor(NOW / 86_400_000);
const DAY_READS = 33;

const original: typeof redis.pipeline = redis.pipeline.bind(redis);
let calls = 0;
let commands: (string | number)[][] = [];

async function read(reply: unknown): ReturnType<typeof pointsRecordOf> {
  calls = 0;
  commands = [];
  redis.pipeline = (async (batch) => {
    calls += 1;
    commands.push(...batch);
    return reply as unknown[];
  }) as typeof redis.pipeline;
  try {
    return await pointsRecordOf(COMMUNITY, MEMBER, NOW);
  } finally {
    redis.pipeline = original;
  }
}

async function refuses(reply: unknown): Promise<boolean> {
  try {
    await read(reply);
    return false;
  } catch {
    return true;
  }
}

async function concurrentRemovals(): Promise<{ total: number; today: number }> {
  let total = 1;
  let today = 1;
  let reads = 0;
  let releaseReads: (() => void) | null = null;
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
  redis.pipeline = (async (batch) => {
    if (batch.length === 2 && batch.every((command) => command[0] === "ZSCORE")) {
      const snapshot = [String(total), String(today)];
      reads += 1;
      if (reads === 2) releaseReads?.();
      await bothRead;
      return snapshot;
    }
    if (batch.every((command) => command[0] === "ZINCRBY")) {
      for (const command of batch) {
        if (String(command[1]).includes(":pts:d:")) today += Number(command[2]);
        else total += Number(command[2]);
      }
      return batch.map((command) => String(String(command[1]).includes(":pts:d:") ? today : total));
    }
    if (batch.length === 1 && batch[0]?.[0] === "EVAL") {
      const tookTotal = total > 0;
      const tookToday = today > 0;
      if (tookTotal) total -= 1;
      if (tookToday) today -= 1;
      return [[tookTotal ? 1 : 0, tookToday ? 1 : 0]];
    }
    throw new Error("Unexpected community points command");
  }) as typeof redis.pipeline;
  try {
    await Promise.all([
      award(COMMUNITY, MEMBER, -1, { sid: "points-copy-evidence" }, NOW),
      award(COMMUNITY, MEMBER, -1, { sid: "points-copy-evidence" }, NOW),
    ]);
    return { total, today };
  } finally {
    redis.pipeline = original;
  }
}

async function removalRefuses(reply: unknown[]): Promise<boolean> {
  redis.pipeline = (async () => reply) as typeof redis.pipeline;
  try {
    await award(COMMUNITY, MEMBER, -1, { sid: "points-copy-evidence" }, NOW);
    return false;
  } catch {
    return true;
  } finally {
    redis.pipeline = original;
  }
}

const empty = () => [null, [], ...Array(DAY_READS).fill(null)];
const populated = () => ["5", [PRODUCT, "123"], "2", ...Array(DAY_READS - 1).fill(null)];

async function main(): Promise<void> {
  part("Confirmed copies");
  is("confirmed absence is an empty points copy", await read(empty()), { total: 0, days: [], rewards: {} });
  is("confirmed points and one reward are copied", await read(populated()), {
    total: 5,
    days: [{ day: TODAY, points: 2 }],
    rewards: { [PRODUCT]: "123" },
  });
  await read(empty());
  is("the copy uses one existing pipeline", calls, 1);
  is("the whole fixed envelope is requested", commands.length, 2 + DAY_READS);
  is("the total is the first read", commands[0]?.[0], "ZSCORE");
  is("unlocked rewards are the second read", commands[1]?.[0], "HGETALL");
  is("all remaining reads are daily scores", commands.slice(2).every((command) => command[0] === "ZSCORE"), true);

  part("States produced by the points writer remain copyable");
  const negative = empty();
  negative[0] = "-1";
  negative[2] = "-1";
  is("legacy negative scores are represented conservatively instead of blocking the copy", await read(negative), {
    total: 0,
    days: [{ day: TODAY, points: 0 }],
    rewards: {},
  });
  const retainedRewards = empty();
  retainedRewards[1] = Array.from({ length: MAX_REWARDS + 1 }, (_, index) => [
    `course${String(index).padStart(3, "0")}`,
    String(100 + index),
  ]).flat();
  is("retained rewards beyond today's configuration limit remain in the copy", Object.keys((await read(retainedRewards)).rewards).length, MAX_REWARDS + 1);
  is("two simultaneous removals cannot make stored points negative", await concurrentRemovals(), { total: 0, today: 0 });
  for (const [name, reply] of [
    ["missing script reply", []],
    ["non-list script reply", [1]],
    ["partial script reply", [[1]]],
    ["extra script reply", [[1, 0, 0]]],
    ["coerced script reply", [["1", 0]]],
    ["impossible script reply", [[2, 0]]],
  ] as const) {
    is(`${name} is unknown`, await removalRefuses(reply as unknown as unknown[]), true);
  }

  part("The pipeline envelope is evidence");
  is("a non-list response is unknown", await refuses(null), true);
  is("a missing daily result is unknown", await refuses(empty().slice(0, -1)), true);
  is("an extra result is unknown", await refuses([...empty(), null]), true);

  part("The all-time score must be a Redis score or confirmed absence");
  for (const [name, total] of [
    ["missing", undefined],
    ["boolean", false],
    ["number instead of Redis text", 1],
    ["empty text", ""],
    ["fractional", "1.5"],
  ] as const) {
    const reply = empty();
    reply[0] = total as never;
    is(`${name} total is unknown`, await refuses(reply), true);
  }

  part("The reward hash must be whole and valid");
  for (const [name, rewards] of [
    ["null hash", null],
    ["odd hash", [PRODUCT]],
    ["invalid product", ["bad!", "123"]],
    ["invalid date", [PRODUCT, "later"]],
    ["non-string field", [7, "123"]],
    ["non-string value", [PRODUCT, 123]],
  ] as const) {
    const reply = empty();
    reply[1] = rewards as never;
    is(`${name} is unknown`, await refuses(reply), true);
  }

  part("Every daily score must be exact");
  for (const [name, score] of [
    ["missing", undefined],
    ["boolean", false],
    ["number instead of Redis text", 1],
    ["fractional", "1.5"],
  ] as const) {
    const reply = empty();
    reply[2] = score as never;
    is(`${name} daily score is unknown`, await refuses(reply), true);
  }

  done();
}

void main();
