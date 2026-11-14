/**
 * The two Redis scripts of lib/meta-ads.ts, read from the file itself, answer the same on the stand-in
 * (lib/redis-memory.ts) as on Redis (CX-123 rules 24 and 30):
 *
 *   - WRITE_IF_CONNECTED writes only while the connection is exactly the one read;
 *   - FINISH_UNLESS_GONE keeps a new connection only while no deletion of that Meta user was confirmed since its
 *     consent flow began (forgetMetaUser's mark).
 *
 * Each refuses a call of the wrong shape (key or argument count, a number that is not one) with -1 before touching
 * anything, as lib/path-atomic.ts does, so a caller's slip is an unknown reply (UnknownReplyError), never a write
 * that Redis would make with an argument too many or that would fail half-way on an expiry Redis refuses.
 *
 * With REDIS_ARITY_SERVER naming a Redis 7 server binary, the same cases are run on a private one (a Unix socket in
 * the temporary directory, no TCP port) and must answer exactly as the stand-in does.
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

const source = readFileSync("lib/meta-ads.ts", "utf8");
/** A script as lib/meta-ads.ts defines it; "" when it does not, which its own test below fails on. */
const script = (name: string): string => source.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`))?.[1] ?? "";
const W = script("WRITE_IF_CONNECTED");
const F = script("FINISH_UNLESS_GONE");

test("lib/meta-ads.ts defines both scripts", () => {
  assert.match(W, /^-- marktmorgen:meta-if-connected:v1\n/);
  assert.match(F, /^-- marktmorgen:meta-finish:v1\n/);
});

type Arg = string | number;
type Case = { name: string; setup: Arg[][]; run: Arg[]; reply: number | "error"; after: Arg[][]; state: unknown[] };

const IF_SETUP: Arg[][] = [["SET", "c", "S"], ["SET", "r", "old"], ["SET", "l", "old"]];
// The connection, the key written, the key dropped, and whether the key written expires (-1 never, -2 gone).
const IF_STATE: Arg[][] = [["GET", "c"], ["GET", "r"], ["GET", "l"], ["TTL", "r"]];
const untouched = ["S", "old", "old", -1];
const ifCase = (name: string, run: Arg[], reply: number | "error", state: unknown[] = untouched): Case => ({ name, setup: IF_SETUP, run: ["EVAL", W, ...run], reply, after: IF_STATE, state });

const FIN_SETUP: Arg[][] = [["SET", "read", "r"]];
// The connection, the read's record, the store in the connected stores, the store in the person's index.
const FIN_STATE: Arg[][] = [["GET", "conn"], ["EXISTS", "read"], ["SISMEMBER", "stores", "s1"], ["SISMEMBER", "user", "s1"]];
const FIN_KEYS = ["conn", "read", "stores", "user", "gone"];
const kept = [null, 1, 0, 0];
// The same, with each set read by its kind (TYPE), for a key that holds another kind of value.
const FIN_TYPED: Arg[][] = [["GET", "conn"], ["EXISTS", "read"], ["TYPE", "stores"], ["TYPE", "user"]];
const finCase = (name: string, gone: string | null, run: Arg[], reply: number | "error", state: unknown[] = kept, more: Arg[][] = [], after: Arg[][] = FIN_STATE): Case => ({
  name,
  setup: [...(gone === null ? FIN_SETUP : [...FIN_SETUP, ["SET", "gone", gone]]), ...more],
  run: ["EVAL", F, ...run],
  reply,
  after,
  state,
});

const CASES: Case[] = [
  ifCase("writes with an expiry while the connection is the one read", [2, "c", "r", "S", "new", 60], 1, ["S", "new", "old", "ttl"]),
  ifCase("writes nothing once the connection is another", [2, "c", "r", "X", "new", 60], 0),
  ifCase("writes the connection itself and drops the keys named", [4, "c", "c", "r", "l", "S", "S2", 0], 1, ["S2", null, null, -2]),
  ifCase("\"0\" keeps it with no expiry", [2, "c", "r", "S", "new", 0], 1, ["S", "new", "old", -1]),
  ifCase("an expiry of -1 is refused before anything is written", [2, "c", "r", "S", "new", -1], -1),
  ifCase("an expiry that is not a whole number is refused", [2, "c", "r", "S", "new", "1.5"], -1),
  ifCase("an expiry that is not a number is refused", [2, "c", "r", "S", "new", "soon"], -1),
  ifCase("an empty expiry is refused", [2, "c", "r", "S", "new", ""], -1),
  ifCase("an expiry with a leading zero is refused", [2, "c", "r", "S", "new", "060"], -1),
  ifCase("an expiry longer than nine digits is refused", [2, "c", "r", "S", "new", "1000000000"], -1),
  ifCase("an argument too many is refused, not written", [2, "c", "r", "S", "new", 60, "extra"], -1),
  ifCase("an argument too few is refused", [2, "c", "r", "S", "new"], -1),
  ifCase("a single key is refused", [1, "c", "S", "new", 60], -1),
  ifCase("more keys than arguments is Redis's own error", [9, "c", "r", "S"], "error"),
  // Redis reads the key count as a whole number written the plain way (Claude 2 on #3322, Redis 7.0.15): a leading
  // zero, "-0" or a sign is its own error before the script runs, so the stand-in refuses them too.
  ifCase("a key count with a leading zero is Redis's own error", ["02", "c", "r", "S", "new", 60], "error"),
  ifCase("a key count of -0 is Redis's own error", ["-0", "c", "r", "S", "new", 60], "error"),
  ifCase("a key count with a plus sign is Redis's own error", ["+2", "c", "r", "S", "new", 60], "error"),
  finCase("keeps the connection when no deletion was confirmed", null, [5, ...FIN_KEYS, "J", 1001, "s1"], 1, ["J", 0, 1, 1]),
  finCase("keeps it when the deletion is older than the flow", "1000", [5, ...FIN_KEYS, "J", 1001, "s1"], 1, ["J", 0, 1, 1]),
  finCase("keeps nothing when the deletion is at the flow's start", "1001", [5, ...FIN_KEYS, "J", 1001, "s1"], 0),
  finCase("keeps nothing when the deletion is after the flow's start", "2000", [5, ...FIN_KEYS, "J", 1001, "s1"], 0),
  finCase("keeps nothing when the mark does not read as a time", "soon", [5, ...FIN_KEYS, "J", 1001, "s1"], 0),
  finCase("a start of 0 is refused", null, [5, ...FIN_KEYS, "J", 0, "s1"], -1),
  finCase("a negative start is refused", null, [5, ...FIN_KEYS, "J", -5, "s1"], -1),
  finCase("a start that is not a whole number is refused", null, [5, ...FIN_KEYS, "J", "1.5", "s1"], -1),
  finCase("a start longer than sixteen digits is refused", null, [5, ...FIN_KEYS, "J", "12345678901234567", "s1"], -1),
  finCase("an empty store is refused", null, [5, ...FIN_KEYS, "J", 1001, ""], -1),
  finCase("a key too few is refused", null, [4, ...FIN_KEYS.slice(0, 4), "J", 1001, "s1"], -1),
  finCase("an argument too many is refused", null, [5, ...FIN_KEYS, "J", 1001, "s1", "extra"], -1),
  finCase("an argument too few is refused", null, [5, ...FIN_KEYS, "J", 1001], -1),
  finCase("a key count with a leading zero is Redis's own error", null, ["05", ...FIN_KEYS, "J", 1001, "s1"], "error"),
  finCase("keeps it when both sets already hold another store", null, [5, ...FIN_KEYS, "J", 1001, "s1"], 1, ["J", 0, 1, 1], [["SADD", "stores", "s0"], ["SADD", "user", "s0"]]),
  // A set key holding another kind of value (Claude 2 on #3322): Redis does not undo a script that stops half-way, so
  // the connection must not be written before a SADD that would fail; nothing is written, and the error is Redis's.
  // Read with TYPE, since SISMEMBER on such a key is an error itself.
  finCase("keeps nothing when the person's index holds another kind of value", null, [5, ...FIN_KEYS, "J", 1001, "s1"], "error", [null, 1, "none", "string"], [["SET", "user", "x"]], FIN_TYPED),
  finCase("keeps nothing when the connected stores hold another kind of value", null, [5, ...FIN_KEYS, "J", 1001, "s1"], "error", [null, 1, "string", "none"], [["SET", "stores", "x"]], FIN_TYPED),
];

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
  const dir = mkdtempSync(join(tmpdir(), "meta-redis-"));
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
