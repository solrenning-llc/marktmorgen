import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { MemoryRedis } from "@/lib/redis-memory";

const vectors: (string | number)[][] = [
  ["hSeT", "key", "a", "1", "b", "2", "orphan"],
  ["HSET", "key", "a", "1", "b", "2", "c", "3", "orphan"],
  ["hMgEt", "key"],
  ["ZADD", "key", "CH", 1],
  ["ZADD", "key", "GT", 1],
  ["ZADD", "key", "LT", 1],
  ["ZADD", "key", "INCR", 1],
  ["ZADD", "key", "nX", "CH"],
  ["ZADD", "key", "XX", "GT", "CH"],
  ["ZADD", "key", "NX", "CH", 1, "member", 2],
];

test("additional incomplete option/pair vectors match native Redis before any key mutation", { skip: !process.env.REDIS_ARITY_SERVER }, async () => {
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
      assert.throws(() => store.run(command), { message: native.slice(1, -2) }, JSON.stringify(command));
      assert.equal(store.run(["GET", "key"]), "existing-string");
      assert.equal(store.run(["GET", ""]), "empty-key-control");
      assert.deepEqual(store.keys(), ["", "key"]);
    }
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
