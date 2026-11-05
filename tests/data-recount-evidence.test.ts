import assert from "node:assert/strict";
import { test } from "node:test";
import { measureKey, recountStep, RECOUNT_VERSION, STATE_KEY, SUM_KEY } from "@/lib/data-recount";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);

async function injected(command: string, reply: unknown[], run: () => Promise<void>) {
  redis.pipeline = async (commands: Command[]) => commands.length === 1 && commands[0][0] === command ? reply : pipeline(commands);
  try { await run(); } finally { redis.pipeline = pipeline; }
}

const broken: unknown[] = [undefined, null, false, true, {}, [], "", "unknown", -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

for (const raw of broken) test(`TYPE ${JSON.stringify(raw)} cannot mean a missing key`, async () => {
  await injected("TYPE", [raw], async () => { await assert.rejects(measureKey("nl:blog:body:evidence:post")); });
});

for (const command of ["STRLEN", "MEMORY"]) for (const raw of broken) {
  test(`${command} ${JSON.stringify(raw)} cannot become a zero byte measurement`, async () => {
    redis.clear();
    redis.pipeline = async (commands: Command[]) => {
      if (commands[0][0] === "TYPE") return [command === "STRLEN" ? "string" : "stream"];
      if (commands[0][0] === command) return [raw];
      return pipeline(commands);
    };
    try { await assert.rejects(measureKey("nl:blog:body:evidence:post")); } finally { redis.pipeline = pipeline; }
  });
}

for (const [kind, command] of [["hash", "HSCAN"], ["set", "SSCAN"], ["zset", "ZSCAN"], ["list", "LRANGE"]]) {
  const malformed = command === "LRANGE" ? [undefined, null, {}, [null], [4]] : [undefined, null, [], ["0"], ["0", null], ["0", [null]], ["0", [], "extra"], [null, []], ["bad", []]];
  for (const raw of malformed) test(`${command} ${JSON.stringify(raw)} cannot complete a measurement`, async () => {
    redis.pipeline = async (commands: Command[]) => commands[0][0] === "TYPE" ? [kind] : commands[0][0] === command ? [raw] : pipeline(commands);
    try { await assert.rejects(measureKey("nl:blog:body:evidence:post")); } finally { redis.pipeline = pipeline; }
  });
}

for (const command of ["HSCAN", "ZSCAN"]) test(`${command} rejects an incomplete field/value pair`, async () => {
  redis.pipeline = async (commands: Command[]) => commands[0][0] === "TYPE" ? [command === "HSCAN" ? "hash" : "zset"] : [["0", ["field"]]];
  try { await assert.rejects(measureKey("nl:blog:body:evidence:post")); } finally { redis.pipeline = pipeline; }
});

for (const reply of [[], ["none", "extra"], ["string", "extra"]]) test(`outer TYPE cardinality ${JSON.stringify(reply)} is exact`, async () => {
  await injected("TYPE", reply, async () => { await assert.rejects(measureKey("nl:blog:body:evidence:post")); });
});

test("confirmed missing, explicit zero and valid Redis collections remain usable", async () => {
  redis.clear();
  assert.equal(await measureKey("nl:blog:body:missing:post"), null);
  const key = "nl:blog:body:evidence:post";
  for (const command of [["SET", key, ""], ["HSET", key, "a", "value"], ["SADD", key, "member"], ["ZADD", key, 1, "member"], ["RPUSH", key, "item"]]) {
    redis.run(["DEL", key]); redis.run(command);
    const measured = await measureKey(key);
    assert.ok(measured !== null && measured > 0);
  }
});

for (const reply of [[], [null], [["done"]], [["done", "0"]], [["done", "0", RECOUNT_VERSION, "extra"]], [["done", null, RECOUNT_VERSION]], [["done", "bad", RECOUNT_VERSION]], [["unknown", "0", RECOUNT_VERSION]]]) {
  test(`state ${JSON.stringify(reply)} cannot reset or finish a recount`, async () => {
    redis.clear(); redis.run(["HSET", SUM_KEY, "store", 123]);
    await injected("HMGET", reply, async () => { await assert.rejects(recountStep(Date.now() + 100)); });
    assert.equal(redis.run(["HGET", SUM_KEY, "store"]), "123");
  });
}

for (const phase of ["scan", "apply"]) for (const raw of [undefined, null, [], ["0"], ["0", null], ["0", [], "extra"], ["bad", []], [null, []], ["0", [null]]]) {
  test(`${phase} ${JSON.stringify(raw)} never advances or clears pending measurements`, async () => {
    redis.clear();
    redis.run(["HSET", STATE_KEY, "phase", phase, "cursor", "0", "version", RECOUNT_VERSION]);
    redis.run(["HSET", SUM_KEY, "store", 123]);
    await injected(phase === "scan" ? "SCAN" : "HSCAN", [raw], async () => { await assert.rejects(recountStep(Date.now() + 100)); });
    assert.equal(redis.run(["HGET", STATE_KEY, "phase"]), phase);
    assert.equal(redis.run(["HGET", SUM_KEY, "store"]), "123");
  });
}

test("confirmed empty final pages complete without extra reads", async () => {
  redis.clear();
  redis.run(["HSET", STATE_KEY, "phase", "scan", "cursor", "0", "version", RECOUNT_VERSION]);
  const report = await recountStep(Date.now() + 100);
  assert.equal(report.done, true);
});
