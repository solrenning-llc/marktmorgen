/**
 * The Redis scripts of lib/meet-connect.ts, read from the file itself, answer the same on the stand-in
 * (lib/redis-memory.ts) as on Redis (CX-123 rules 24 and 30): KEEP_UNLESS_GONE keeps a store's new meeting
 * connection, indexed first, only while the renewal lock is the writer's and no deletion of that account was
 * confirmed since its consent flow began (forgetUser's mark) and, when it replaces another account's, takes the store
 * out of that account's index and forgets the test meeting made on it in the same step; KEEP_TEST_UNLESS_GONE keeps a test meeting
 * (lib/meet-test.ts) only while the store's connection is there and listed under the account it was made on, no
 * deletion of that account was confirmed since the make or the move began, and the record is still the one read.
 *
 * It refuses a call of the wrong shape (key or argument count, a cutoff that is not a time, an empty token,
 * connection or store) with -1 before touching anything, so a caller's slip is an unknown reply
 * (UnknownReplyError), never a connection kept. An index of another type is Redis's own error, with no connection
 * kept outside it. The test meeting's script refuses its own wrong shapes the same way; an index, a mark or a record of
 * another type is Redis's own error, with nothing written.
 *
 * With REDIS_ARITY_SERVER naming a Redis 7 server binary, the same cases are run on a private one (a Unix socket in
 * the temporary directory, no TCP port) and must answer exactly as the stand-in does. The harness is the one of
 * tests/meta-redis-scripts.test.ts (#3322).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { MemoryRedis } from "@/lib/redis-memory";

const source = readFileSync("lib/meet-connect.ts", "utf8");
/** The script as lib/meet-connect.ts defines it; "" when it does not, which its own test below fails on. */
const K = source.match(/const KEEP_UNLESS_GONE = `([\s\S]*?)`;/)?.[1] ?? "";

/** The test meeting's script as lib/meet-connect.ts defines it; "" when it does not. */
const T = source.match(/const KEEP_TEST_UNLESS_GONE = `([\s\S]*?)`;/)?.[1] ?? "";

test("lib/meet-connect.ts defines the script", () => {
  assert.match(K, /^-- marktmorgen:meet-keep:v2\n/);
});

test("lib/meet-connect.ts defines the test meeting's script", () => {
  assert.match(T, /^-- marktmorgen:meet-test-keep:v1\n/);
});

type Arg = string | number;
type Case = { name: string; setup: Arg[][]; run: Arg[]; reply: number | "error"; after: Arg[][]; state: unknown[] };

// The lock, the store's connection, the new account's index, its deletion mark, the replaced account's index ("old")
// and the store's test meeting ("test").
const KEYS = ["lock", "conn", "idx", "gone", "old", "test"];
// The connection, the index's type (a set only once the store was added to it), the lock (never touched by the
// script), whether the replaced account's index still lists the store, and the test meeting.
const STATE: Arg[][] = [["GET", "conn"], ["TYPE", "idx"], ["GET", "lock"], ["SISMEMBER", "old", "s1"], ["GET", "test"]];
const nothing = [null, "none", "T", 0, null];
const kept = ["J", "set", "T", 0, null];
const keep = (name: string, setup: Arg[][], run: Arg[], reply: number | "error", state: unknown[] = nothing, after: Arg[][] = STATE): Case => ({
  name,
  setup: [["SET", "lock", "T"], ...setup],
  run: ["EVAL", K, ...run],
  reply,
  after,
  state,
});
const call = (cutoff: Arg = 1001, store: Arg = "s1", token: Arg = "T", connection: Arg = "J", replaced: Arg = "0", keys: Arg[] = KEYS): Arg[] => [
  6,
  ...keys,
  token,
  connection,
  cutoff,
  store,
  replaced,
];
/** Another account's connection was the store's: listed under that account, with the test meeting made on it. */
const OLD: Arg[][] = [["SET", "conn", "OLDCONN"], ["SADD", "old", "s1"], ["SET", "test", "TM"]];
const untouched = ["OLDCONN", "none", "T", 1, "TM"];

const CASES: Case[] = [
  keep("keeps and indexes the connection while the lock is ours and no deletion was confirmed", [], call(), 1, kept),
  keep("keeps nothing once the lock is another's", [["SET", "lock", "X"]], call(), 0, [null, "none", "X", 0, null]),
  keep("keeps nothing once the lock is gone", [["DEL", "lock"]], call(), 0, [null, "none", null, 0, null]),
  keep("keeps it when the deletion is older than the flow", [["SET", "gone", "1000"]], call(), 1, kept),
  keep("keeps nothing when the deletion is at the flow's start", [["SET", "gone", "1001"]], call(), 2),
  keep("keeps nothing when the deletion is after the flow's start", [["SET", "gone", "2000"]], call(), 2),
  keep("keeps nothing when the mark does not read as a time", [["SET", "gone", "soon"]], call(), 2),
  keep("keeps nothing when the mark is empty", [["SET", "gone", ""]], call(), 2),
  keep("keeps nothing when the mark is longer than sixteen digits", [["SET", "gone", "12345678901234567"]], call(), 2),
  keep("an index of another type is Redis's error, with no connection kept outside it", [["SET", "idx", "text"]], call(), "error", [null, "string", "T", 0, null]),
  keep("a cutoff of 0 is refused", [], call(0), -1),
  keep("a negative cutoff is refused", [], call(-5), -1),
  keep("a cutoff that is not a whole number is refused", [], call("1.5"), -1),
  keep("a cutoff with a leading zero is refused", [], call("01001"), -1),
  keep("a cutoff longer than sixteen digits is refused", [], call("12345678901234567"), -1),
  keep("an empty store is refused", [], call(1001, ""), -1),
  keep("an empty token is refused", [], call(1001, "s1", ""), -1),
  keep("an empty connection is refused", [], call(1001, "s1", "T", ""), -1),
  keep("a key too few is refused", [], [5, ...KEYS.slice(0, 5), "T", "J", 1001, "s1", "0"], -1),
  keep("a key too many is refused", [], [7, ...KEYS, "more", "T", "J", 1001, "s1", "0"], -1),
  keep("an argument too many is refused", [], [...call(), "extra"], -1),
  keep("an argument too few is refused", [], call().slice(0, -1), -1),
  keep("a key count with a leading zero is Redis's own error", [], ["06", ...KEYS, "T", "J", 1001, "s1", "0"], "error"),
  keep("a negative key count is Redis's own error", [], [-1, ...KEYS, "T", "J", 1001, "s1", "0"], "error"),
  keep("more keys than arguments is Redis's own error", [], [9, ...KEYS, "T"], "error"),
  // Another account's connection replaced: its index and its test meeting go in the same step (pre-review M3).
  keep("replacing another account's: the store leaves its index and its test meeting is forgotten", OLD, call(1001, "s1", "T", "J", "1"), 1, kept),
  keep("the same account's: its index and test meeting are left as they are", OLD, call(1001, "s1", "T", "J", "0"), 1, ["J", "set", "T", 1, "TM"]),
  keep("replacing another account's once the lock is another's: nothing changes", [...OLD, ["SET", "lock", "X"]], call(1001, "s1", "T", "J", "1"), 0, [
    "OLDCONN",
    "none",
    "X",
    1,
    "TM",
  ]),
  keep("replacing another account's after a deletion since the flow began: nothing changes", [...OLD, ["SET", "gone", "2000"]], call(1001, "s1", "T", "J", "1"), 2, untouched),
  keep(
    "an old index of another type is Redis's error, with the old connection and test meeting as they were",
    [["SET", "conn", "OLDCONN"], ["SET", "old", "text"], ["SET", "test", "TM"]],
    call(1001, "s1", "T", "J", "1"),
    "error",
    ["OLDCONN", "set", "T", "string", "TM"],
    [["GET", "conn"], ["TYPE", "idx"], ["GET", "lock"], ["TYPE", "old"], ["GET", "test"]],
  ),
  keep("a replaced flag other than 0 or 1 is refused", OLD, call(1001, "s1", "T", "J", "2"), -1, untouched),
  keep("an empty replaced flag is refused", OLD, call(1001, "s1", "T", "J", ""), -1, untouched),
  keep("a replaced account's index that is the new account's own is refused", OLD, call(1001, "s1", "T", "J", "1", ["lock", "conn", "idx", "gone", "idx", "test"]), -1, untouched),
];

// The test meeting's script: the store's connection ("conn"), the stores listed under the account it was made on
// ("idx"), that account's deletion mark ("gone") and the test meeting's record ("test").
const TKEYS = ["conn", "idx", "gone", "test"];
const CONNECTED: Arg[][] = [["SET", "conn", "C"], ["SADD", "idx", "s1"]];
const tk = (name: string, setup: Arg[][], run: Arg[], reply: number | "error", record: unknown = null, after: Arg[][] = [["GET", "test"]]): Case => ({
  name: `test meeting: ${name}`,
  setup: [...CONNECTED, ...setup],
  run: ["EVAL", T, ...run],
  reply,
  after,
  state: [record],
});
const tcall = (had: Arg = "", cutoff: Arg = 1001, store: Arg = "s1", value: Arg = "V"): Arg[] => [4, ...TKEYS, store, value, cutoff, had];

CASES.push(
  tk("keeps a new one while the store is connected and listed, with no deletion since", [], tcall(), 1, "V"),
  tk("keeps a moved one over the record it read", [["SET", "test", "OLD"]], tcall("OLD"), 1, "V"),
  tk("keeps it when the deletion is older than the make", [["SET", "gone", "1000"]], tcall(), 1, "V"),
  tk("keeps nothing once the connection is gone", [["DEL", "conn"]], tcall(), 2),
  tk("keeps nothing once the store is not listed under the account", [["SREM", "idx", "s1"], ["SADD", "idx", "s2"]], tcall(), 2),
  tk("keeps nothing once the account's list is gone", [["DEL", "idx"]], tcall(), 2),
  tk("keeps nothing when the deletion is at the make's start", [["SET", "gone", "1001"]], tcall(), 2),
  tk("keeps nothing when the deletion is after the make's start", [["SET", "gone", "2000"]], tcall(), 2),
  tk("keeps nothing when the mark does not read as a time", [["SET", "gone", "soon"]], tcall(), 2),
  tk("keeps nothing when the mark is empty", [["SET", "gone", ""]], tcall(), 2),
  tk("keeps nothing when the mark is longer than sixteen digits", [["SET", "gone", "12345678901234567"]], tcall(), 2),
  tk("a new one does not write over one made meanwhile", [["SET", "test", "OTHER"]], tcall(), 3, "OTHER"),
  tk("a moved one is not written back once the record was deleted", [], tcall("OLD"), 3),
  tk("a moved one is not written over a record changed meanwhile", [["SET", "test", "NEW"]], tcall("OLD"), 3, "NEW"),
  tk("a gone connection is said before a changed record", [["DEL", "conn"], ["SET", "test", "OTHER"]], tcall(), 2, "OTHER"),
  tk("a list of another type is Redis's error, with nothing written", [["DEL", "idx"], ["SET", "idx", "text"]], tcall(), "error"),
  tk("a mark of another type is Redis's error, with nothing written", [["SADD", "gone", "x"]], tcall(), "error"),
  tk("a record of another type is Redis's error, with nothing written", [["SADD", "test", "x"]], tcall(), "error", "set", [["TYPE", "test"]]),
  tk("a cutoff of 0 is refused", [], tcall("", 0), -1),
  tk("a negative cutoff is refused", [], tcall("", -5), -1),
  tk("a cutoff that is not a whole number is refused", [], tcall("", "1.5"), -1),
  tk("a cutoff with a leading zero is refused", [], tcall("", "01001"), -1),
  tk("a cutoff longer than sixteen digits is refused", [], tcall("", "12345678901234567"), -1),
  tk("an empty store is refused", [], tcall("", 1001, ""), -1),
  tk("an empty record is refused", [], tcall("", 1001, "s1", ""), -1),
  tk("a key too few is refused", [], [3, ...TKEYS.slice(0, 3), "s1", "V", 1001, ""], -1),
  tk("a key too many is refused", [], [5, ...TKEYS, "more", "s1", "V", 1001, ""], -1),
  tk("an argument too many is refused", [], [...tcall(), "extra"], -1),
  tk("an argument too few is refused", [], tcall().slice(0, -1), -1),
  tk("a key count with a leading zero is Redis's own error", [], ["04", ...TKEYS, "s1", "V", 1001, ""], "error"),
  tk("a negative key count is Redis's own error", [], [-1, ...TKEYS, "s1", "V", 1001, ""], "error"),
  tk("more keys than arguments is Redis's own error", [], [9, ...TKEYS, "s1"], "error"),
);

function onStandIn(c: Case): { reply: unknown; state: unknown[] } {
  const store = new MemoryRedis();
  for (const command of c.setup) store.run(command);
  let reply: unknown;
  try {
    reply = store.run(c.run);
  } catch {
    reply = "error";
  }
  const state = c.after.map((command) => store.run(command));
  return { reply, state: state.map((v, i) => (c.after[i][0] === "TTL" && typeof v === "number" && v > 0 ? "ttl" : v)) };
}

for (const c of CASES) {
  test(`stand-in: ${c.name}`, () => {
    const got = onStandIn(c);
    assert.equal(got.reply, c.reply);
    assert.deepEqual(got.state, c.state);
  });
}

/** One RESP reply off the front of `buffer`, with what is left; null while it is not all there. */
function parse(buffer: Buffer): { value: unknown; rest: Buffer } | null {
  const end = buffer.indexOf("\r\n");
  if (end < 0) return null;
  const kind = String.fromCharCode(buffer[0]);
  const line = buffer.subarray(1, end).toString("utf8");
  const rest = buffer.subarray(end + 2);
  if (kind === "+") return { value: line, rest };
  if (kind === "-") return { value: { error: line }, rest };
  if (kind === ":") return { value: Number(line), rest };
  if (kind === "$") {
    const size = Number(line);
    if (size < 0) return { value: null, rest };
    if (rest.length < size + 2) return null;
    return { value: rest.subarray(0, size).toString("utf8"), rest: rest.subarray(size + 2) };
  }
  if (kind === "*") {
    const count = Number(line);
    if (count < 0) return { value: null, rest };
    const items: unknown[] = [];
    let left = rest;
    for (let i = 0; i < count; i++) {
      const item = parse(left);
      if (!item) return null;
      items.push(item.value);
      left = item.rest;
    }
    return { value: items, rest: left };
  }
  throw new Error(`unknown RESP reply ${kind}`);
}

function client(socket: Socket): (command: Arg[]) => Promise<unknown> {
  let buffer: Buffer = Buffer.alloc(0);
  const waiting: ((value: unknown) => void)[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let next = parse(buffer); next && waiting.length; next = parse(buffer)) {
      buffer = next.rest;
      waiting.shift()!(next.value);
    }
  });
  return (command) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      socket.write(`*${command.length}\r\n${command.map((value) => `$${Buffer.byteLength(String(value))}\r\n${String(value)}\r\n`).join("")}`);
    });
}

test("Redis 7 answers every case exactly as the stand-in does", { skip: !process.env.REDIS_ARITY_SERVER }, async () => {
  const binary = process.env.REDIS_ARITY_SERVER!;
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /Redis server v=7\./);
  const dir = mkdtempSync(join(tmpdir(), "meet-redis-"));
  const path = join(dir, "redis.sock");
  const child = spawn(binary, ["--port", "0", "--unixsocket", path, "--unixsocketperm", "700", "--dir", dir, "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Redis did not report readiness")), 5000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(Error("Redis exited before readiness")); });
      child.stdout.on("data", (chunk) => { if (/ready to accept connections/i.test(String(chunk))) { clearTimeout(timer); resolve(); } });
    });
    const socket = createConnection({ path });
    await once(socket, "connect");
    const send = client(socket);
    try {
      for (const c of CASES) {
        assert.equal(await send(["FLUSHALL"]), "OK");
        for (const command of c.setup) await send(command);
        const raw = await send(c.run);
        const reply = raw && typeof raw === "object" && "error" in raw ? "error" : raw;
        const state: unknown[] = [];
        for (const command of c.after) {
          const v = await send(command);
          state.push(command[0] === "TTL" && typeof v === "number" && v > 0 ? "ttl" : v);
        }
        const standIn = onStandIn(c);
        assert.deepEqual({ reply, state }, { reply: c.reply, state: c.state }, `Redis: ${c.name} (${JSON.stringify(raw)})`);
        assert.deepEqual(standIn, { reply, state }, `stand-in and Redis: ${c.name}`);
      }
    } finally {
      socket.end();
    }
  } finally {
    child.kill("SIGTERM");
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
