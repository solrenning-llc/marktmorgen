/**
 * Rule 24 in the studio's "sent" counts (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * nudgesThisMonth, yearlyAsksThisMonth, winbacksSent and welcomesOffered read their counter with GET as
 * `Number(n) || 0`, and the studio caught any failure as 0: a counter that did not read told the creator "Sent this
 * month: 0" or "Offered so far: 0" while emails had gone out. Now each counter is read exactly (lib/redis-count.ts
 * textCountOf): absent is 0, a whole number is itself, anything else throws UnknownReplyError; the studio shows
 * "Not counted just now" instead of a number.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { readFileSync } from "node:fs";
import { nudgesThisMonth } from "@/lib/member-nudge";
import { yearlyAsksThisMonth } from "@/lib/yearly-ask";
import { winbacksSent } from "@/lib/winback-send";
import { welcomesOffered } from "@/lib/welcome-offer-send";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: unknown[] | null = null;
redis.pipeline = (async (commands: Cmd[]) => (bend ? bend : original(commands))) as typeof redis.pipeline;

const store = { statsId: "stats-r24-sent" } as Store;
const readers: [string, () => Promise<number>, string][] = [
  ["nudgesThisMonth", () => nudgesThisMonth(store), "nl:nudge:count:stats-r24-sent:"],
  ["yearlyAsksThisMonth", () => yearlyAsksThisMonth(store), "nl:yearask:count:stats-r24-sent:"],
  ["winbacksSent", () => winbacksSent(store), "nl:wb:n:stats-r24-sent"],
  ["welcomesOffered", () => welcomesOffered(store), "nl:wo:n:stats-r24-sent"],
];

async function outcome(run: () => Promise<number>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  for (const [name, run] of readers) {
    part(`${name}: a counter that does not read is unknown, never 0`);
    for (const reply of [[], ["QUEUED"], ["-1"], ["1.5"], [{ error: "ERR synthetic" }], [true]]) {
      bend = reply;
      is(`${JSON.stringify(reply)}: unknown`, await outcome(run), "unknown");
      bend = null;
    }
    part(`${name}: control`);
    is("absent is 0", await outcome(run), 0);
    bend = ["7"];
    is("a counter of 7 reads 7", await outcome(run), 7);
    bend = null;
  }

  part("The studio never shows 0 for a counter that did not read");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  for (const [name] of readers) is(`${name} is not caught as 0`, new RegExp(`${name}\\(store\\)\\.catch\\(\\(\\) => 0\\)`).test(page), false);
  for (const file of ["nudge-editor", "yearly-ask-editor", "winback-editor", "welcome-offer-editor"]) {
    const text = readFileSync(`components/${file}.tsx`, "utf8");
    is(`${file} says the count was not read`, /Not counted just now/.test(text), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
