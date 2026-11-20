/**
 * forgetTasksPerson (lib/assignment.ts) confirms the deletion of a student's work only by counts its commands could give
 * (#4794, Codex V, transcribed and reproduced by Claude 2): a DEL of one record answering 2, with an HDEL of a file
 * answering 1 although nothing was applied, was taken as done and the file's bytes given back. Such a count is unknown:
 * the files read go to the daily cleanup door, no bytes come back, and the erasure is not said done. The test is the
 * one reproduced in the issue, unchanged. Synthetic, in-memory Redis only.
 */
import { forgetTasksPerson } from "@/lib/assignment";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const COURSE = "crs_o5count";
const LESSON = "lsno5countaa";
const WHO = "0123456789abcdef";
const ROOM = "o5count-room";
const bytesKey = `nl:tasks:bytes:${ROOM}`;
type Command = (string | number)[];

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.run(["SET", bytesKey, "1100"]);
  redis.run(["HSET", `nl:course:${COURSE}:task:${LESSON}:files`, "a.pdf", "100"]);
  const sub = { text: "x", file: { path: "a.pdf", name: "a.pdf", bytes: 100, type: "application/pdf" }, at: 1, state: "waiting", feedback: "", reviewedAt: 0, tries: 1 };
  redis.run(["SET", `nl:course:${COURSE}:task:${LESSON}:sub:${WHO}`, JSON.stringify(sub)]);
  redis.run(["ZADD", `nl:course:${COURSE}:tasks:all`, 1, `${LESSON}|${WHO}`]);
  const original = redis.pipeline.bind(redis);
  // The deletion batch (DEL, ZREM, ZREM, HDEL) is answered [2, 0, 0, 1] without being applied.
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 4 && commands[0][0] === "DEL" && commands[3][0] === "HDEL") return [2, 0, 0, 1];
    return original(commands);
  }) as typeof redis.pipeline;
  part("A deletion batch answered with counts above what its commands could remove");
  let outcome = "resolved";
  try { await forgetTasksPerson(COURSE, [LESSON], WHO, ROOM); } catch (e) { outcome = e instanceof Error ? e.name : "rejected"; }
  redis.pipeline = original;
  is("forgetTasksPerson refuses the impossible counts", outcome, "UnknownReplyError");
  is("no bytes are given back from fabricated evidence", Number(redis.run(["GET", bytesKey])), 1100);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
