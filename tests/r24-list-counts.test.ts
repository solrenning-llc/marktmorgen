/**
 * Rule 24 in the email list's counts (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * listCounts read the list's size (HLEN) and its two counters (GET agreed, GET unsubscribed) as `Number(x) || 0`. A
 * reply that did not read told the creator "0 people you can write to" on the studio's email page, the import page and
 * the MCP overview, and "full" as false at any size. Now each is read exactly (countOf; textCountOf, where an absent
 * counter is 0), and anything else throws UnknownReplyError; the pages say the list could not be counted just now.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { readFileSync } from "node:fs";
import { listCounts } from "@/lib/contacts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  const real = (await original(commands)) as unknown[];
  return bend ? bend(commands, real) : real;
}) as typeof redis.pipeline;

async function outcome(): Promise<unknown> {
  try {
    return await listCounts("list-r24");
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await original([["HSET", "nl:store:leads:list-r24", "a@example.com", "{}", "b@example.com", "{}"]]);

  for (const [what, at] of [["the list's size", 0], ["the agreed counter", 1], ["the unsubscribed counter", 2]] as const) {
    part(`${what} that does not read is unknown, never 0`);
    for (const value of ["QUEUED", "1.5", "01", { error: "ERR synthetic" }, ...(at === 2 ? [] : [-1, "-1"]), ...(at === 0 ? [null] : [])]) {
      bend = (_c, real) => real.map((r, i) => (i === at ? value : r));
      is(`${JSON.stringify(value)}: unknown`, await outcome(), "unknown");
      bend = null;
    }
  }
  part("A whole reply that does not read is unknown");
  bend = () => ["QUEUED"];
  is("short reply: unknown", await outcome(), "unknown");
  bend = null;

  part("Callers never show 0 for a list that did not count");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  const mcp = readFileSync("lib/mcp-tools.ts", "utf8");
  const route = readFileSync("app/api/store/mail/route.ts", "utf8");
  is("the email page catches it as null", /listCounts\(store\.listId\)\.catch\(\(\) => null\)/.test(page), true);
  is("the list card says it was not counted", /could not be counted just now/.test(studio), true);
  is("the MCP overview gives no figures for it", /listCounts\(store\.listId\)\.catch\(\(\) => null\)/.test(mcp), true);
  is("the import answer gives no figures for it", /listCounts\(store\.listId\)\.catch\(\(\) => null\)/.test(route), true);

  part("Control: real replies give the real counts");
  const counts = await outcome();
  is("two people, none agreed yet", counts, { total: 2, agreed: 0, left: 0, mailable: 0, full: false });
  part("Control: the unsubscribed counter below zero (a plain DECR) is none left, as before");
  for (const value of [-1, "-1"]) {
    bend = (_c, real) => real.map((r, i) => (i === 2 ? value : r));
    is(`${JSON.stringify(value)}: none left`, ((await outcome()) as { left?: number }).left, 0);
    bend = null;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
