/**
 * Runs the same commands on a disposable real Redis 7 and on MemoryRedis
 * (lib/redis-memory.ts), to compare what each answers: the way
 * tests/redis-memory-arity.test.ts checks error replies, for scripts. Used
 * only when REDIS_ARITY_SERVER names a redis-server binary; the server is
 * started on a free loopback port with nothing saved, and stopped after.
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { MemoryRedis } from "@/lib/redis-memory";

export type Command = (string | number)[];

/** A reply as RESP gives it: numbers, text, null, lists, or {error}. */
function parse(buf: Buffer, at: number): [unknown, number] | null {
  const end = buf.indexOf("\r\n", at);
  if (at >= buf.length || end < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const line = buf.toString("utf8", at + 1, end);
  if (type === "+") return [line, end + 2];
  if (type === "-") return [{ error: line }, end + 2];
  if (type === ":") return [Number(line), end + 2];
  if (type === "$") {
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    if (buf.length < end + 2 + n + 2) return null;
    return [buf.toString("utf8", end + 2, end + 2 + n), end + 4 + n];
  }
  if (type === "*") {
    const n = Number(line);
    if (n < 0) return [null, end + 2];
    const out: unknown[] = [];
    let p = end + 2;
    for (let i = 0; i < n; i += 1) {
      const r = parse(buf, p);
      if (!r) return null;
      out.push(r[0]);
      p = r[1];
    }
    return [out, p];
  }
  throw new Error(`Unexpected RESP reply ${JSON.stringify(type)}`);
}

/** Sorted where the order is Redis's own business: a hash's fields, a set's members, the key list. */
function normalized(command: Command, reply: unknown): unknown {
  const name = String(command[0]).toUpperCase();
  if (!Array.isArray(reply)) return reply;
  if (name === "HGETALL") {
    const pairs: [string, unknown][] = [];
    for (let i = 0; i < reply.length; i += 2) pairs.push([String(reply[i]), reply[i + 1]]);
    return pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (name === "SMEMBERS" || name === "KEYS") return [...reply].map(String).sort();
  return reply;
}

/** Each command's reply from MemoryRedis and from a real Redis, both starting empty, side by side. */
export async function realAndMemory(binary: string, commands: Command[]): Promise<{ memory: unknown[]; real: unknown[]; version: string }> {
  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || !/Redis server v=7\./.test(version.stdout)) throw new Error(`Not a Redis 7 server: ${version.stdout}`);
  const memoryStore = new MemoryRedis();
  const memory = commands.map((command) => {
    try {
      return normalized(command, memoryStore.run(command));
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  const child = spawn(binary, ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Redis did not report readiness")), 5000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Redis exited before readiness"));
      });
      child.stdout.on("data", (chunk) => {
        if (/ready to accept connections/i.test(String(chunk))) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const socket = createConnection({ host: "127.0.0.1", port });
    await once(socket, "connect");
    let buffer = Buffer.alloc(0);
    let waiting: (() => void) | null = null;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      waiting?.();
    });
    const send = async (command: Command): Promise<unknown> => {
      socket.write(`*${command.length}\r\n` + command.map((value) => `$${Buffer.byteLength(String(value))}\r\n${String(value)}\r\n`).join(""));
      for (;;) {
        const parsed = parse(buffer, 0);
        if (parsed) {
          buffer = buffer.subarray(parsed[1]);
          return parsed[0];
        }
        await new Promise<void>((resolve) => (waiting = resolve));
        waiting = null;
      }
    };
    const real: unknown[] = [];
    for (const command of commands) real.push(normalized(command, await send(command)));
    socket.end();
    return { memory, real, version: version.stdout.trim() };
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
}
