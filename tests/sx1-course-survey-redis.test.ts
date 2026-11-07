/**
 * 285 [SX1]: the course survey scripts that delete with their room
 * (lib/course-survey.ts DROP_SURVEY_ANSWER, DROP_ALL_SURVEY_ANSWERS, v2)
 * answer and leave the same state on a real Redis 7 as on MemoryRedis, which
 * the other tests run against. Only when REDIS_ARITY_SERVER names a
 * redis-server binary (tests/real-redis-compare.ts); skipped otherwise.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DROP_ALL_SURVEY_ANSWERS, DROP_SURVEY_ANSWER, SET_SURVEY_ANSWER } from "@/lib/course-survey";
import { MAX_COURSE_ANSWERS, SURVEY_ROOM_BYTES } from "@/lib/course-survey-rules";
import { TAKE_DATA } from "@/lib/store-data";
import { type Command, realAndMemory } from "./real-redis-compare";

const C = "c".repeat(32);
const ROOM = "nl:data:real-redis-test";
const ANSWERS = `nl:course:${C}:survey`;
const SLOT = `cs:${C}`;
const MONTH = "2026-11";
const LIMIT = 10_000_000;
const record = JSON.stringify({ score: 9, note: "Clear.", at: 1_000 });

/** An answer as answerSurvey writes it: its room taken first, then the answer. */
const answer = (who: string): Command[] => [
  ["EVAL", TAKE_DATA, 1, ROOM, LIMIT, "0", MONTH, "a", SLOT, SURVEY_ROOM_BYTES],
  ["EVAL", SET_SURVEY_ANSWER, 1, ANSWERS, who, record, MAX_COURSE_ANSWERS],
];
const dropOne = (who: string, each: string | number = SURVEY_ROOM_BYTES): Command => ["EVAL", DROP_SURVEY_ANSWER, 2, ROOM, ANSWERS, LIMIT, MONTH, SLOT, each, who];
const dropAll = (each: string | number = SURVEY_ROOM_BYTES): Command => ["EVAL", DROP_ALL_SURVEY_ANSWERS, 2, ROOM, ANSWERS, LIMIT, MONTH, SLOT, each];
const state: Command[] = [["HGETALL", ROOM], ["HGETALL", ANSWERS]];

test("the course survey drops answer and leave the same on Redis 7 as on MemoryRedis", { skip: !process.env.REDIS_ARITY_SERVER }, async () => {
  const commands: Command[] = [
    ...answer("ana"),
    ...answer("ben"),
    ...answer("cleo"),
    ...state,
    // One answer out with its room; again, nothing.
    dropOne("ana"),
    ...state,
    dropOne("ana"),
    ...state,
    // A room that cannot be counted deletes nothing.
    ["HSET", ROOM, "#", "not a count"],
    dropOne("ben"),
    dropAll(),
    ...state,
    ["HSET", ROOM, "#", "0"],
    // What each costs that is not a number deletes nothing.
    dropOne("ben", "x"),
    dropAll("-1"),
    ...state,
    // Every answer of the course with its room; again, nothing more.
    ...answer("ana"),
    dropAll(),
    ...state,
    dropAll(),
    ...state,
    ["EXISTS", ANSWERS],
  ];
  const { memory, real, version } = await realAndMemory(process.env.REDIS_ARITY_SERVER!, commands);
  const differences = commands.flatMap((command, i) =>
    JSON.stringify(memory[i]) === JSON.stringify(real[i]) ? [] : [{ step: i, command: [command[0], String(command[1]).split("\n")[0], ...command.slice(2, 4)], memory: memory[i], real: real[i] }],
  );
  console.log(`${version}: ${commands.length} commands, ${differences.length} differing`);
  for (const difference of differences) console.log(JSON.stringify(difference));
  // Held: every script's reply and every state read. Two differences of MemoryRedis's own, older than these scripts,
  // are only printed: its HSET answers 1 even for a field it overwrote (Redis: the new fields, 0 here), and a hash or
  // set read or emptied stays as a key there (EXISTS 1) where Redis deletes it; the reads above see both as empty.
  assert.deepEqual(differences.filter((difference) => ["EVAL", "HGETALL", "SMEMBERS"].includes(String(difference.command[0]))), []);
});
