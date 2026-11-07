/**
 * 296 [SQ7]: the lesson rating scripts that delete with their room
 * (lib/lesson-rating.ts DROP_LESSON_RATING, DROP_LESSON_RATINGS, v2) answer
 * and leave the same state on a real Redis 7 as on MemoryRedis, which the
 * other tests run against. Only when REDIS_ARITY_SERVER names a
 * redis-server binary (tests/real-redis-compare.ts); skipped otherwise.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DROP_LESSON_RATING, DROP_LESSON_RATINGS, SET_LESSON_RATING } from "@/lib/lesson-rating";
import { RATING_ROOM_BYTES, serializeRating } from "@/lib/lesson-rating-rules";
import { TAKE_DATA } from "@/lib/store-data";
import { type Command, realAndMemory } from "./real-redis-compare";

const C = "c".repeat(32);
const ROOM = "nl:data:real-redis-test";
const INDEX = `nl:lr:${C}:ls`;
const SLOT = `lr:${C}`;
const MONTH = "2026-11";
const LIMIT = 10_000_000;
const lesson = (id: string) => `nl:lr:${C}:l:${id}`;
const [A, B, Z] = ["lessonaaaa01", "lessonbbbb02", "lessonzzzz99"];
const record = serializeRating({ score: 4, note: "Clear.", at: 1_000 });

/** A rating as rateLesson writes it: its room taken first, then the rating. */
const rate = (who: string, id: string): Command[] => [
  ["EVAL", TAKE_DATA, 1, ROOM, LIMIT, "0", MONTH, "a", SLOT, RATING_ROOM_BYTES],
  ["EVAL", SET_LESSON_RATING, 2, lesson(id), INDEX, who, record, 500, id],
];
const dropMine = (who: string, ids: string[], each: string | number = RATING_ROOM_BYTES): Command => ["EVAL", DROP_LESSON_RATING, 2 + ids.length, ROOM, INDEX, ...ids.map(lesson), LIMIT, MONTH, SLOT, each, who, ...ids];
const dropLessons = (ids: string[], each: string | number = RATING_ROOM_BYTES): Command => ["EVAL", DROP_LESSON_RATINGS, 2 + ids.length, ROOM, INDEX, ...ids.map(lesson), LIMIT, MONTH, SLOT, each, ...ids];
const state: Command[] = [["HGETALL", ROOM], ["SMEMBERS", INDEX], ["HGETALL", lesson(A)], ["HGETALL", lesson(B)], ["HGETALL", lesson(Z)]];

test("the lesson rating drops answer and leave the same on Redis 7 as on MemoryRedis", { skip: !process.env.REDIS_ARITY_SERVER }, async () => {
  const commands: Command[] = [
    ...rate("ana", A),
    ...rate("ben", A),
    ...rate("ana", B),
    ...state,
    // One person's ratings over every lesson, one with none of theirs.
    dropMine("ana", [A, B, Z]),
    ...state,
    dropMine("ana", [A, B, Z]),
    // A lesson with none left is tidied out of the index even when nothing of theirs is there.
    ["SADD", INDEX, Z],
    dropMine("nobody", [Z]),
    ...state,
    // A room that cannot be counted deletes nothing.
    ...rate("ana", B),
    ["HSET", ROOM, "#", "not a count"],
    dropMine("ana", [B]),
    dropLessons([A, B]),
    ...state,
    ["HSET", ROOM, "#", "0"],
    // What each costs that is not a number, or keys and lessons that do not match, deletes nothing.
    dropMine("ana", [B], "x"),
    dropLessons([A, B], "-1"),
    ["EVAL", DROP_LESSON_RATINGS, 4, ROOM, INDEX, lesson(A), lesson(B), LIMIT, MONTH, SLOT, RATING_ROOM_BYTES, A],
    ["EVAL", DROP_LESSON_RATING, 2, ROOM, INDEX, LIMIT, MONTH, SLOT, RATING_ROOM_BYTES, "ana"],
    ...state,
    // The removed lessons' every rating, the room level after; again, nothing more.
    dropLessons([A, B]),
    ...state,
    dropLessons([A, B]),
    ...state,
    ["EXISTS", INDEX],
    ["EXISTS", lesson(A)],
    ["EXISTS", lesson(B)],
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
