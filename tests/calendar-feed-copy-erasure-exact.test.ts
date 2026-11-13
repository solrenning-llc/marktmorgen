/**
 * #4477 (Codex L, 13/11/2026; transcribed by Claude 2): forgetFeedCopyPerson, a step of a person's erasure, read any
 * DEL reply it could not read as zero removed, so the step finished while the calendar copy that names buyers could
 * still be kept. The reply is now read exactly: a whole reply whose count is 0 or 1, anything else throws
 * UnknownReplyError and keeps the erasure pending; one of the day's makings is given back only on a confirmed 1.
 * Synthetic: the in-memory Redis, with the DEL's reply bent.
 */
import { forgetFeedCopyPerson } from "@/lib/calendar-sync";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let bent: { reply: unknown } | null = null;
let decrements = 0;
redis.pipeline = (async (commands: Command[]) => {
  if (commands.some((c) => c[0] === "DECRBY")) decrements += 1;
  const replies = await real(commands);
  if (bent && commands.length === 1 && commands[0][0] === "DEL") return bent.reply;
  return replies;
}) as typeof redis.pipeline;

const STATS = "b".repeat(32);
const NOW = Date.UTC(2026, 10, 13, 12);

async function main(): Promise<void> {
  part("A DEL reply that is not a whole count of 0 or 1 keeps the erasure pending");
  const unknown: [string, unknown][] = [
    ["text", ["synthetic-unknown-reply"]], ["empty list", []], ["missing", undefined], ["null", null],
    ["missing slot", [undefined]], ["null slot", [null]], ["two replies", [1, 1]], ["count 2", [2]],
    ["negative", [-1]], ["fraction", [0.5]], ["numeric text", ["1"]], ["an error object", [new Error("boom")]],
  ];
  for (const [name, reply] of unknown) {
    redis.clear();
    await redis.pipeline([["SET", `nl:cal:out:${STATS}`, "BEGIN:VCALENDAR"]]);
    bent = { reply }; decrements = 0;
    let error: unknown = null;
    try { await forgetFeedCopyPerson(STATS, NOW); } catch (caught) { error = caught; }
    bent = null;
    is(`${name}: throws UnknownReplyError, gives no making back`, [error instanceof UnknownReplyError, decrements], [true, 0]);
  }

  part("A confirmed answer");
  redis.clear();
  await redis.pipeline([["SET", `nl:cal:out:${STATS}`, "BEGIN:VCALENDAR"], ["SET", `nl:cal:builds:${STATS}:2026-11-13`, 3]]);
  decrements = 0;
  is("a kept copy: 1 removed", await forgetFeedCopyPerson(STATS, NOW), 1);
  const [copy, builds] = await redis.pipeline([["GET", `nl:cal:out:${STATS}`], ["GET", `nl:cal:builds:${STATS}:2026-11-13`]]);
  is("the copy is gone and one making is given back", [copy, Number(builds), decrements], [null, 2, 1]);
  decrements = 0;
  is("no copy: 0 removed, no making given back", [await forgetFeedCopyPerson(STATS, NOW), decrements], [0, 0]);
  is("no store: nothing to do", await forgetFeedCopyPerson(null, NOW), 0);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
