/**
 * Rule 24 in a store's seven days of watched email (CX-123; the coordinator's sweep of `Number(x) || 0`,
 * 16 November 2026).
 *
 * listHealth summed each day's HMGET (sent, bounced, complained) as `Number(x) || 0`, and skipped a day whose reply
 * was not a list. A day that did not read so counted as nothing bounced: pauseIfOver could miss a store over the
 * bounce or spam line and let its list email go on, and the studio's email page showed fewer bounces than there were.
 * Now each day is read exactly (three slots, each a whole number or nil) and the pause's start day too; anything else
 * throws UnknownReplyError. The studio already shows a week that does not read as not read (catch to null).
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { listHealth, mailHealthDayKey } from "@/lib/mail-health";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  const real = (await original(commands)) as unknown[];
  return bend ? bend(commands, real) : real;
}) as typeof redis.pipeline;

const ID = "abcdef0123456789";
async function outcome(): Promise<unknown> {
  try {
    return await listHealth(ID);
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  const now = Date.now();
  await original([["HSET", mailHealthDayKey(ID, now), "s", "100", "b", "6", "c", "1"]]);

  part("A day that does not read is unknown, never a day with nothing bounced");
  for (const value of ["QUEUED", null, ["100", "6"], ["100", "x", "1"], ["100", "-6", "1"], [100, { error: "ERR" }, 1]]) {
    bend = (commands, real) => real.map((r, i) => (commands[i][0] === "HMGET" && String(commands[i][1]) === mailHealthDayKey(ID, now) ? value : r));
    is(`${JSON.stringify(value)}: unknown`, await outcome(), "unknown");
    bend = null;
  }

  part("The pause's start day that does not read is unknown");
  for (const value of [3, { error: "ERR" }, ["2026-11-01"]]) {
    bend = (commands, real) => real.map((r, i) => (commands[i][0] === "GET" ? value : r));
    is(`${JSON.stringify(value)}: unknown`, await outcome(), "unknown");
    bend = null;
  }
  bend = () => ["QUEUED"];
  is("a short reply: unknown", await outcome(), "unknown");
  bend = null;

  part("Control: real replies sum the week");
  is("today's figures", await outcome(), { sent: 100, bounced: 6, complained: 1 });
  bend = (commands, real) => real.map((r, i) => (commands[i][0] === "HMGET" && String(commands[i][1]) === mailHealthDayKey(ID, now) ? [100, 6, 1] : r));
  is("numbers as numbers read too", await outcome(), { sent: 100, bounced: 6, complained: 1 });
  bend = null;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
