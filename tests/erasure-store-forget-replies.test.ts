/**
 * Issues #4678 and #4665 (Codex L, HIGH, erasure): a deleted store's kept readings (lib/store-readings.ts
 * forgetStoreReadings) and its team and activity log (lib/team.ts dropTeam) were deleted without reading the reply, so
 * an answer of [] or another shape left them stored while the delete went on as done. Each reply is read exactly
 * (rule 24): a DEL of the readings answers 0 to 3, each SREM and DEL of the team 0 or 1; anything else throws
 * UnknownReplyError, the store goes in the durable line (lib/store-forget-retry.ts), and the daily try removes the
 * team, its log and the readings before the store leaves the line. Synthetic data, in-memory Redis.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { dropTeam, putMember } from "@/lib/team";
import { READING_KINDS, forgetStoreReadings } from "@/lib/store-readings";
import { UnknownReplyError } from "@/lib/redis-reply";
import { FORGET_TRY_COMMANDS, queueStoreForget, retryStoreForgets } from "@/lib/store-forget-retry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
/** How many of `keys` are there, one EXISTS each (the in-memory Redis answers one key an EXISTS). */
const present = async (keys: string[]) => ((await real(keys.map((key) => ["EXISTS", key]))) as number[]).reduce((a, b) => a + b, 0);

/** Answers `reply` to the first pipeline `match` picks, everything else as Redis would. */
function answerOnce(match: (commands: Commands) => boolean, reply: unknown): void {
  let used = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!used && match(commands)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other: ${String(error)}`;
  } finally {
    redis.pipeline = real;
  }
}

const STATS = "a".repeat(32);
const readingKeys = READING_KINDS.map((kind) => `nl:reading:${kind}:${STATS}`);
const isReadingsDel = (commands: Commands) => commands.length === 1 && commands[0][0] === "DEL" && String(commands[0][1]).startsWith("nl:reading:");
const isTeamDrop = (commands: Commands) => commands.some((c) => c[0] === "DEL" && String(c[1]).startsWith("nl:team"));

async function storeWithTeam(n: number) {
  const owner = `erase-4665-${n}@example.com`;
  await claimHandle(owner, `erase4665n${n}`, "Erase Team", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_Erase4665N${n}`, subscriptionId: `sub_Erase4665N${n}`, active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  await putMember(store, `erase-4665-mate-${n}@example.com`, "support");
  return store;
}

async function main(): Promise<void> {
  redis.clear();

  part("#4678: the store-wide readings' DEL is read exactly");
  for (const [label, reply] of [
    ["no reply", []],
    ["a hole", [undefined]],
    ["text", ["OK"]],
    ["a negative count", [-1]],
    ["more than the three copies", [4]],
    ["two replies", [3, 0]],
  ] as [string, unknown][]) {
    for (const key of readingKeys) await real([["SET", key, JSON.stringify({ buyer: "buyer@example.com" })]]);
    answerOnce(isReadingsDel, reply);
    is(`${label}: unknown, never done`, await outcome(() => forgetStoreReadings(STATS)), "unknown");
    is(`${label}: the three copies are still there for the next try`, await present(readingKeys), 3);
  }
  for (const key of readingKeys) await real([["SET", key, "{}"]]);
  is("an exact reply deletes them", [await outcome(() => forgetStoreReadings(STATS)), await present(readingKeys)], ["resolved", 0]);
  is("none there: 0 is an exact reply too", await outcome(() => forgetStoreReadings(STATS)), "resolved");

  part("#4665: the team's SREM and DEL are read exactly");
  let n = 0;
  for (const [label, reply] of [
    ["no reply", []],
    ["a hole in the replies", [1, undefined, 1]],
    ["text", [1, "OK", 1]],
    ["a negative count", [1, -1, 1]],
    ["a count above 1", [1, 2, 1]],
    ["a short reply", [1, 1]],
    ["an extra reply", [1, 1, 1, 1]],
  ] as [string, unknown][]) {
    n += 1;
    const store = await storeWithTeam(n);
    answerOnce(isTeamDrop, reply);
    is(`${label}: unknown, never done`, await outcome(() => dropTeam(store)), "unknown");
    is(`${label}: the team is still there for the next try`, (await real([["EXISTS", `nl:team:${store.sid}`]]))[0], 1);
  }
  n += 1;
  const exact = await storeWithTeam(n);
  is("an exact reply deletes the team", [await outcome(() => dropTeam(exact)), (await real([["EXISTS", `nl:team:${exact.sid}`]]))[0]], ["resolved", 0]);

  part("The durable line: the daily try removes the team, its log and the readings before the store leaves it");
  n += 1;
  const lined = await storeWithTeam(n);
  const lineReadings = READING_KINDS.map((kind) => `nl:reading:${kind}:${lined.statsId}`);
  for (const key of lineReadings) await real([["SET", key, "{}"]]);
  await real([["LPUSH", `nl:team:log:${lined.sid}`, "a line"]]);
  await queueStoreForget(lined.statsId ?? null, lined.sid);
  let sent = 0;
  redis.pipeline = (async (commands: Commands) => {
    sent += commands.length;
    return real(commands);
  }) as typeof redis.pipeline;
  const result = await retryStoreForgets(Date.now() + 60_000).finally(() => {
    redis.pipeline = real;
  });
  is(
    "done, and the team, its log and the readings are gone, within FORGET_TRY_COMMANDS",
    [result.done, await present([`nl:team:${lined.sid}`, `nl:team:log:${lined.sid}`, ...lineReadings]), sent - 1 <= FORGET_TRY_COMMANDS],
    [1, 0, true],
  );

  part("The delete route puts both in the durable line, never only a log line");
  const route = readFileSync("app/api/store/stores/route.ts", "utf8");
  const durable = /const forgetHooksAndKeys = async \(\) => \{([\s\S]*?)\n {6}\};/.exec(route)?.[1] ?? "";
  is("the team is forgotten in the durable step", /await dropTeam\(result\.store\);/.test(durable), true);
  is("the readings are forgotten in the durable step", /await forgetStoreReadings\(result\.store\.statsId\);/.test(durable), true);
  is("no longer awaited before it, where a throw skips every other forget", /\n {6}await dropTeam\(result\.store\);/.test(route.replace(durable, "")), false);
  is("no longer only logged with the integrations", /forgetStoreCalendar\(result\.store\.statsId\), forgetStoreReadings/.test(route), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
