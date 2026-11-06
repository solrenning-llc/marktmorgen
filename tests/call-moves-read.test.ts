/**
 * The bookings' moves are read a hundred keys at an MGET, every MGET in one
 * trip (lib/call-records.ts, readMoves; C3-82, MR, 4 November 2026), with the
 * same answer the one-GET-a-booking reading gave: a move for each session that
 * has a readable one, nothing for a key that is gone or holds no string. A
 * value that is not a move is unknown and refuses the read (CX-123 rule 24,
 * tests/call-moves-unknown.test.ts).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { movedKey, readMoves, writeMove } from "@/lib/call-records";
import { MOVES_PER_MGET, moveReads } from "@/lib/call-moves-read";
import { UnknownReplyError } from "@/lib/redis-reply";

/** Every pipeline the database is sent, as its commands. */
const trips: (string | number)[][][] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  trips.push(commands);
  return pipeline(commands);
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  trips.length = 0;
});

const session = (i: number) => `cs_test_${String(i).padStart(24, "0")}`;

test("five hundred bookings: five MGETs of a hundred in one trip, and every move as written", async () => {
  const sessions = Array.from({ length: 500 }, (_, i) => session(i));
  for (let i = 0; i < 500; i += 7) await writeMove(sessions[i], { s: 1_000 + i, e: 2_000 + i, n: i % 3 });
  trips.length = 0;
  const moves = await readMoves(sessions);
  assert.equal(trips.length, 1, "one trip to the database");
  assert.deepEqual(trips[0].map((c) => c[0]), Array(5).fill("MGET"));
  assert.ok(trips[0].every((c) => c.length - 1 <= MOVES_PER_MGET));
  assert.equal(trips[0].length, moveReads(500));
  assert.deepEqual(trips[0].flatMap((c) => c.slice(1)), sessions.map(movedKey), "every key once, in order");
  assert.equal(moves.size, Math.ceil(500 / 7));
  for (let i = 0; i < 500; i += 1) assert.deepEqual(moves.get(sessions[i]), i % 7 === 0 ? { s: 1_000 + i, e: 2_000 + i, n: i % 3 } : undefined, sessions[i]);
});

test("a key that is gone or holds no string is read as never moved; the others still are", async () => {
  const sessions = Array.from({ length: 250 }, (_, i) => session(i));
  await writeMove(sessions[0], { s: 10, e: 20, n: 1 });
  await writeMove(sessions[99], { s: 30, e: 40, n: 2 });
  await writeMove(sessions[100], { s: 50, e: 60, n: 0 });
  await writeMove(sessions[249], { s: 70, e: 80, n: 1 });
  // MGET answers null for a key that holds no string, as for one that is gone.
  await redis.pipeline([["HSET", movedKey(sessions[5]), "s", "10"]]);
  trips.length = 0;
  const moves = await readMoves(sessions);
  assert.deepEqual(trips[0].map((c) => c[0]), ["MGET", "MGET", "MGET"]);
  assert.deepEqual(
    [...moves.entries()].sort(),
    [
      [sessions[0], { s: 10, e: 20, n: 1 }],
      [sessions[99], { s: 30, e: 40, n: 2 }],
      [sessions[100], { s: 50, e: 60, n: 0 }],
      [sessions[249], { s: 70, e: 80, n: 1 }],
    ].sort(),
  );
});

test("a value at a move's key that is not a move refuses the whole read, in any MGET of the trip", async () => {
  const sessions = Array.from({ length: 250 }, (_, i) => session(i));
  await writeMove(sessions[0], { s: 10, e: 20, n: 1 });
  for (const [i, raw] of [[1, "{not json"], [2, JSON.stringify({ s: 20, e: 10, n: 1 })], [3, JSON.stringify({ s: 10, e: 20, n: 1.5 })], [4, "null"], [249, JSON.stringify({ s: 10, e: 20 })]] as const) {
    await redis.pipeline([["SET", movedKey(sessions[i]), raw]]);
    await assert.rejects(readMoves(sessions), (error: unknown) => error instanceof UnknownReplyError, raw);
    await redis.pipeline([["DEL", movedKey(sessions[i])]]);
  }
  assert.deepEqual([...(await readMoves(sessions)).entries()], [[sessions[0], { s: 10, e: 20, n: 1 }]]);
});

test("one booking is one MGET; none, or only empty sessions, reads nothing", async () => {
  await writeMove(session(1), { s: 1, e: 2, n: 1 });
  trips.length = 0;
  assert.deepEqual((await readMoves([session(1)])).get(session(1)), { s: 1, e: 2, n: 1 });
  assert.deepEqual(trips, [[["MGET", movedKey(session(1))]]]);
  trips.length = 0;
  assert.equal((await readMoves([])).size, 0);
  assert.equal((await readMoves(["", ""])).size, 0);
  assert.equal(trips.length, 0);
});

test("the same session twice is read twice and found once, as before", async () => {
  await writeMove(session(3), { s: 5, e: 9, n: 2 });
  trips.length = 0;
  const moves = await readMoves([session(3), "", session(3)]);
  assert.deepEqual([...moves.entries()], [[session(3), { s: 5, e: 9, n: 2 }]]);
  assert.deepEqual(trips, [[["MGET", movedKey(session(3)), movedKey(session(3))]]]);
});
