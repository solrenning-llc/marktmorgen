/**
 * A video's record read in another shape is not proof that there is no video
 * (CX-123 rule 24, audit round 7, finding 3). lookAt used to take any GET
 * reply that did not parse as "no record" and take the id out of the due
 * queue: an abandoned upload then stayed at the video service, and in the
 * store's room, until the store closed. Only an exact nil may take it out;
 * any other reply throws, keeps it queued and calls the service for nothing.
 * The five-minute job goes on to the next video and asks again later.
 *
 * Same function (rule 30): a lesson told its video writes the record as no
 * longer "upload". That write was not read either; had it not landed, the
 * lesson would keep the video while the record still said "upload", and two
 * days later the job would delete the lesson's video at the service. It is
 * read exactly now: anything but "OK" throws, and the lesson is not saved.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimUpload, lookAt, sweep } from "@/lib/stream";
import { ABANDONED_AFTER_MS } from "@/lib/stream-rules";
import { store as redis } from "./redis-stub";

const FOLDER = "0123456789abcdef0123456789abcdef";
const LESSON = "abcdefghij12";
const STUCK = "00000000-0000-4000-8000-000000000a01";
const HEALTHY = "00000000-0000-4000-8000-000000000a02";
const DUE = "nl:stream:due";
const NOW = Date.UTC(2026, 10, 8, 12);
const recordKey = (id: string) => `nl:stream:v:${id}`;

process.env.BUNNY_STREAM_LIBRARY_ID = "123456";
process.env.BUNNY_STREAM_API_KEY = "synthetic-api-key-0000000000";
process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-token-key-000000000";

const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  asked.push(`${init?.method ?? "GET"} ${String(input)}`);
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

/** An upload whose door was opened and never claimed, past the time it is taken away. */
async function abandoned(id: string): Promise<void> {
  const at = NOW - ABANDONED_AFTER_MS - 10 * 60_000;
  const record = { id, path: `stream/${FOLDER}/${LESSON}/${id}`, name: "Lesson.mp4", type: "video/mp4", bytes: 1000, state: "upload", at, seconds: 0, width: 0, height: 0 };
  await redis.pipeline([["SET", recordKey(id), JSON.stringify(record)], ["ZADD", DUE, at + ABANDONED_AFTER_MS + 60_000, id]]);
}

async function queued(id: string): Promise<boolean> {
  const [score] = await redis.pipeline([["ZSCORE", DUE, id]]);
  return score !== null && score !== undefined;
}

type Pipeline = typeof redis.pipeline;

async function withRecordReply(id: string, reply: unknown, run: () => Promise<void>): Promise<void> {
  const original = redis.pipeline.bind(redis) as Pipeline;
  let injected = 0;
  redis.pipeline = (async (commands) => {
    if (commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === recordKey(id)) {
      injected += 1;
      return reply as unknown[];
    }
    return original(commands);
  }) as Pipeline;
  try {
    await run();
    assert.ok(injected > 0, "the record read must be exercised");
  } finally {
    redis.pipeline = original;
  }
}

const UNKNOWN: [string, unknown][] = [
  ["no pipeline slot", []],
  ["an extra pipeline slot", [null, null]],
  ["a number", [1]],
  ["a list", [["x"]]],
  ["an object", [{}]],
  ["an undefined slot", [undefined]],
  ["text that is not JSON", ["{not json"]],
  ["JSON that is not a record", ['{"id":"x"}']],
  ["a pipeline that is not a list", "OK"],
];

for (const [label, reply] of UNKNOWN) {
  test(`lookAt keeps an abandoned upload queued when its record reads as ${label}`, async () => {
    redis.clear();
    asked.length = 0;
    await abandoned(STUCK);
    await withRecordReply(STUCK, reply, async () => {
      await assert.rejects(lookAt(STUCK, NOW), { name: "UnknownReplyError" });
    });
    assert.equal(await queued(STUCK), true, "the video stays in the due queue, to be asked about again");
    const [kept] = await redis.pipeline([["GET", recordKey(STUCK)]]);
    assert.equal(typeof kept, "string", "the record is not deleted");
    assert.deepEqual(asked, [], "the service is not called on a record that was not read");
  });
}

test("sweep goes on past a record that does not read, keeps it queued for later and deletes the next abandoned upload", async () => {
  redis.clear();
  asked.length = 0;
  await abandoned(STUCK);
  await abandoned(HEALTHY);
  await withRecordReply(STUCK, [1], async () => {
    await sweep(Date.now() + 5_000, NOW);
  });
  assert.equal(await queued(STUCK), true, "the unread one stays queued");
  const [score] = await redis.pipeline([["ZSCORE", DUE, STUCK]]);
  assert.ok(Number(score) > NOW, "and is asked about again later, not first in line at every run");
  assert.equal(await queued(HEALTHY), false, "the readable abandoned upload leaves the queue");
  const [gone] = await redis.pipeline([["GET", recordKey(HEALTHY)]]);
  assert.equal(gone, null, "its record is deleted");
  assert.ok(asked.some((call) => call.startsWith("DELETE ") && call.endsWith(`/videos/${HEALTHY}`)), "and the service is told to delete it");
  assert.ok(!asked.some((call) => call.includes(STUCK)), "nothing is asked of the service about the unread one");
});

test("an exact nil still takes the id out of the due queue (control)", async () => {
  redis.clear();
  asked.length = 0;
  await redis.pipeline([["ZADD", DUE, NOW - 1, STUCK]]);
  assert.equal(await lookAt(STUCK, NOW), null);
  assert.equal(await queued(STUCK), false);
  assert.deepEqual(asked, []);
});

test("a readable abandoned upload is still deleted at the service and forgotten (control)", async () => {
  redis.clear();
  asked.length = 0;
  await abandoned(HEALTHY);
  assert.equal(await lookAt(HEALTHY, NOW), null);
  assert.equal(await queued(HEALTHY), false);
  const [gone] = await redis.pipeline([["GET", recordKey(HEALTHY)]]);
  assert.equal(gone, null);
  assert.ok(asked.some((call) => call.startsWith("DELETE ") && call.endsWith(`/videos/${HEALTHY}`)));
});

/** A fresh upload whose door was just opened, not claimed yet. */
async function fresh(id: string): Promise<string> {
  const path = `stream/${FOLDER}/${LESSON}/${id}`;
  const record = { id, path, name: "Lesson.mp4", type: "video/mp4", bytes: 1000, state: "upload", at: NOW - 60_000, seconds: 0, width: 0, height: 0 };
  await redis.pipeline([["SET", recordKey(id), JSON.stringify(record)], ["ZADD", DUE, NOW + ABANDONED_AFTER_MS, id]]);
  return path;
}

async function withClaimWriteReply(id: string, reply: unknown, run: () => Promise<void>): Promise<void> {
  const original = redis.pipeline.bind(redis) as Pipeline;
  let injected = 0;
  redis.pipeline = (async (commands) => {
    if (commands[0]?.[0] === "SET" && commands[0]?.[1] === recordKey(id) && commands.length === 2) {
      injected += 1;
      return reply as unknown[];
    }
    return original(commands);
  }) as Pipeline;
  try {
    await run();
    assert.ok(injected > 0, "the claim's record write must be exercised");
  } finally {
    redis.pipeline = original;
  }
}

for (const [label, reply] of [
  ["nil", [null, 1]],
  ["a number", [1, 1]],
  ["no slot", []],
  ["a pipeline that is not a list", "OK"],
] as const) {
  test(`claimUpload refuses when the claimed record's write answers ${label}`, async () => {
    redis.clear();
    asked.length = 0;
    const path = await fresh(STUCK);
    await withClaimWriteReply(STUCK, reply, async () => {
      await assert.rejects(claimUpload(path, FOLDER, LESSON, NOW), { name: "UnknownReplyError" });
    });
  });
}

test("claimUpload still writes a claimed video as working (control)", async () => {
  redis.clear();
  asked.length = 0;
  const path = await fresh(HEALTHY);
  const claimed = await claimUpload(path, FOLDER, LESSON, NOW);
  assert.equal(claimed?.state, "working");
  const [raw] = await redis.pipeline([["GET", recordKey(HEALTHY)]]);
  assert.equal(JSON.parse(String(raw)).state, "working");
  assert.equal(await queued(HEALTHY), true);
});

/*
 * Fairness when the reschedule itself does not land (Codex Z's LOW on #3294, review 5819877532; the oracle "a
 * readable abandoned 41st must still be deleted" is his). The job reads 40 due videos a run. Had 40 records not read
 * and their move to five minutes later not been confirmed either, the same 40 would stay earliest, and the job would
 * spend every run on them while a readable abandoned upload behind them stayed at the video service. The move's reply
 * is read exactly (ZADD CH: 1, the one member moved), a move not confirmed is said in the log, and the job reads the
 * next due videos past the ones it could not move, never more than it lost to them, so it still looks at no more than
 * 40 records a run. Records that do not read are still never dropped and never asked about at the service.
 */
const unreadId = (n: number) => `00000000-0000-4000-8000-0000000b${String(n).padStart(4, "0")}`;
const healthyId = (n: number) => `00000000-0000-4000-8000-0000000c${String(n).padStart(4, "0")}`;

/** An abandoned upload due `seconds` after the earliest one, so the order in the due queue is set by the test. */
async function abandonedAt(id: string, seconds: number): Promise<number> {
  const at = NOW - ABANDONED_AFTER_MS - 10 * 60_000;
  const record = { id, path: `stream/${FOLDER}/${LESSON}/${id}`, name: "Lesson.mp4", type: "video/mp4", bytes: 1000, state: "upload", at, seconds: 0, width: 0, height: 0 };
  const due = NOW - 60 * 60_000 + seconds * 1_000;
  await redis.pipeline([["SET", recordKey(id), JSON.stringify(record)], ["ZADD", DUE, due, id]]);
  return due;
}

async function scoreOf(id: string): Promise<number | null> {
  const [score] = await redis.pipeline([["ZSCORE", DUE, id]]);
  return score === null || score === undefined ? null : Number(score);
}

/** Records in `unread` answer their GET in another shape; their reschedule answers `move` (null: the real write). */
async function withUnread(unread: Set<string>, move: unknown, run: (seen: { gets: number; moves: number; errors: string[] }) => Promise<void>): Promise<void> {
  const original = redis.pipeline.bind(redis) as Pipeline;
  const originalError = console.error;
  const seen = { gets: 0, moves: 0, errors: [] as string[] };
  console.error = (...args: unknown[]) => {
    seen.errors.push(args.map(String).join(" "));
  };
  redis.pipeline = (async (commands) => {
    const [command] = commands;
    if (commands.length === 1 && command?.[0] === "GET" && String(command[1]).startsWith("nl:stream:v:")) {
      seen.gets += 1;
      if (unread.has(String(command[1]).slice("nl:stream:v:".length))) return [1];
    }
    if (commands.length === 1 && command?.[0] === "ZADD" && command[1] === DUE && unread.has(String(command[command.length - 1]))) {
      seen.moves += 1;
      if (move !== null) return move as unknown[];
    }
    return original(commands);
  }) as Pipeline;
  try {
    await run(seen);
  } finally {
    redis.pipeline = original;
    console.error = originalError;
  }
}

const UNCONFIRMED_MOVES: [string, unknown][] = [
  ["0 (nothing moved)", [0]],
  ["nil", [null]],
  ["a string", ["1"]],
  ["no slot", []],
  ["a pipeline that is not a list", "OK"],
];

for (const [label, move] of UNCONFIRMED_MOVES) {
  test(`sweep still deletes a readable abandoned 41st upload when 40 unread records' moves answer ${label}`, async () => {
    redis.clear();
    asked.length = 0;
    const unread = new Set(Array.from({ length: 40 }, (_, n) => unreadId(n)));
    const before = new Map<string, number>();
    for (const [n, id] of [...unread].entries()) before.set(id, await abandonedAt(id, n));
    await abandonedAt(HEALTHY, 50);
    await withUnread(unread, move, async (seen) => {
      await sweep(Date.now() + 5_000, NOW);
      assert.equal(seen.moves, 40, "each unread record's move is tried once");
      assert.ok(seen.errors.some((line) => /could not be confirmed/.test(line)), "a move not confirmed is said in the log");
    });
    assert.equal(await queued(HEALTHY), false, "the readable abandoned upload behind them leaves the queue");
    const [gone] = await redis.pipeline([["GET", recordKey(HEALTHY)]]);
    assert.equal(gone, null, "its record is deleted");
    assert.ok(asked.some((call) => call.startsWith("DELETE ") && call.endsWith(`/videos/${HEALTHY}`)), "and the service is told to delete it");
    for (const id of unread) {
      assert.equal(await scoreOf(id), before.get(id), "an unread record is never dropped from the queue");
      const [kept] = await redis.pipeline([["GET", recordKey(id)]]);
      assert.equal(typeof kept, "string", "nor its record deleted");
    }
    assert.ok(!asked.some((call) => [...unread].some((id) => call.includes(id))), "nothing is asked of the service about an unread record");
  });
}

test("reading past unread records never looks at more than 40 records in a run", async () => {
  redis.clear();
  asked.length = 0;
  const unread = new Set(Array.from({ length: 40 }, (_, n) => unreadId(n)));
  for (const [n, id] of [...unread].entries()) await abandonedAt(id, n);
  const healthy = Array.from({ length: 41 }, (_, n) => healthyId(n));
  for (const [n, id] of healthy.entries()) await abandonedAt(id, 50 + n);
  await withUnread(unread, [0], async (seen) => {
    await sweep(Date.now() + 5_000, NOW);
    assert.equal(seen.gets, 80, "40 unread records read, then 40 more past them, never a third page");
  });
  const deleted = healthy.filter((id) => asked.some((call) => call.startsWith("DELETE ") && call.endsWith(`/videos/${id}`)));
  assert.equal(deleted.length, 40, "the 40 lost to unread records are made up, no more");
  assert.equal(await queued(healthy[40]), true, "the 41st readable one waits for the next run");
});

test("a confirmed move puts unread records five minutes later and the next run reaches the readable 41st (control)", async () => {
  redis.clear();
  asked.length = 0;
  const unread = new Set(Array.from({ length: 40 }, (_, n) => unreadId(n)));
  for (const [n, id] of [...unread].entries()) await abandonedAt(id, n);
  await abandonedAt(HEALTHY, 50);
  await withUnread(unread, null, async (seen) => {
    await sweep(Date.now() + 5_000, NOW);
    assert.equal(seen.gets, 40, "a full page of confirmed moves reads no further page");
    assert.deepEqual(seen.errors, [], "and logs nothing");
    for (const id of unread) assert.equal(await scoreOf(id), NOW + 5 * 60_000, "each unread record is asked about five minutes later");
    assert.equal(await queued(HEALTHY), true, "the 41st waits for the next run");
    await sweep(Date.now() + 5_000, NOW);
  });
  assert.equal(await queued(HEALTHY), false, "and the next run deletes it");
  assert.ok(asked.some((call) => call.startsWith("DELETE ") && call.endsWith(`/videos/${HEALTHY}`)));
  assert.ok(!asked.some((call) => [...unread].some((id) => call.includes(id))));
});
