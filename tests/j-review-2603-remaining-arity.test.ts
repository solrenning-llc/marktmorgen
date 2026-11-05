import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { MemoryRedis } from "@/lib/redis-memory";

const vectors: (string | number)[][] = [["SREM", "key"], ["ZREM", "key"]];

test("remaining empty-removal vectors must match native arity rejection", { skip: !process.env.REDIS_ARITY_SERVER }, async () => {
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const address = reserve.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reserve.close(error => error ? reject(error) : resolve()));
  const child = spawn(process.env.REDIS_ARITY_SERVER!, ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native Redis readiness not observed")), 5000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Native Redis exited before readiness")); });
      child.stdout.on("data", chunk => { if (/ready to accept connections/i.test(String(chunk))) { clearTimeout(timer); resolve(); } });
    });
    const observations: { command: (string | number)[]; expected: string; actual: string }[] = [];
    for (const command of vectors) {
      const native = await new Promise<string>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        let reply = "";
        socket.setTimeout(2000, () => socket.destroy(new Error("Native command reply not observed")));
        socket.once("error", reject);
        socket.once("connect", () => socket.write(`*${command.length}\r\n` + command.map(value => { const s = String(value); return `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }).join("")));
        socket.on("data", chunk => { reply += String(chunk); if (reply.endsWith("\r\n")) { socket.end(); resolve(reply); } });
      });
      assert.ok(native.startsWith("-ERR "), JSON.stringify(command));
      const store = new MemoryRedis();
      store.run(["SET", "key", "existing-string"]);
      store.run(["SET", "", "empty-key-control"]);
      let actual = "accepted without error";
      try { store.run(command); } catch (error) { actual = (error as Error).message; }
      observations.push({ command, expected: native.slice(1, -2), actual });
    }
    assert.deepEqual(observations.map(row => row.actual), observations.map(row => row.expected), JSON.stringify(observations));
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});

// Existing well-formed removal calls are a separate positive control.
test("valid set and sorted-set removals retain their existing replies", () => {
  const store = new MemoryRedis();
  store.run(["SADD", "members", "a", "b"]);
  assert.equal(store.run(["SREM", "members", "a"]), 1);
  assert.equal(store.run(["SCARD", "members"]), 1);
  store.run(["ZADD", "due", 1, "a", 2, "b"]);
  assert.equal(store.run(["ZREM", "due", "a"]), 1);
  assert.equal(store.run(["ZSCORE", "due", "a"]), null);
  assert.equal(store.run(["ZSCORE", "due", "b"]), "2");
});
