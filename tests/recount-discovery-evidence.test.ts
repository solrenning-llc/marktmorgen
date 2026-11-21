import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { recountStep, RECOUNT_VERSION, STATE_KEY, SUM_KEY } from "@/lib/data-recount";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
afterEach(() => { redis.pipeline = pipeline; });

// Claude 1/Claude 3's MEDIUM on #2501: no lost measurement or finished discovery on an unknown store.
for (const raw of [[5], [], [{}]]) {
  test(`apply: owner GET ${JSON.stringify(raw)} keeps the pending sum`, async () => {
    redis.clear();
    redis.run(["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION]);
    redis.run(["HSET", SUM_KEY, "owner@example.test", 4096]);
    redis.pipeline = async (commands: Command[]) => commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:owner:") ? raw : pipeline(commands);
    await assert.rejects(recountStep(Date.now() + 1000));
    assert.equal(redis.run(["HGET", SUM_KEY, "owner@example.test"]), "4096");
    assert.equal(redis.run(["HGET", STATE_KEY, "phase"]), "apply");
  });
}
for (const raw of [[7], [null], [["5"]]]) {
  test(`ids: malformed store SCAN ${JSON.stringify(raw)} does not finish discovery`, async () => {
    redis.clear();
    redis.run(["HSET", STATE_KEY, "phase", "ids", "cursor", "0", "version", RECOUNT_VERSION]);
    redis.pipeline = async (commands: Command[]) => commands.length === 1 && commands[0][0] === "SCAN" && commands[0].includes("nl:store:owner:*") ? raw : pipeline(commands);
    await assert.rejects(recountStep(Date.now() + 1000));
    assert.equal(redis.run(["HGET", STATE_KEY, "phase"]), "ids");
  });
}
test("control: a confirmed missing store lets its obsolete sum go", async () => {
  redis.clear();
  redis.run(["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION]);
  redis.run(["HSET", SUM_KEY, "missing@example.test", 4096]);
  await recountStep(Date.now() + 1000);
  assert.equal(redis.run(["HGET", SUM_KEY, "missing@example.test"]), null);
  assert.equal(redis.run(["HGET", STATE_KEY, "phase"]), "done");
});
test("control: a confirmed empty database completes discovery", async () => {
  redis.clear();
  redis.run(["HSET", STATE_KEY, "phase", "ids", "cursor", "0", "version", RECOUNT_VERSION]);
  await recountStep(Date.now() + 1000);
  assert.equal(redis.run(["HGET", STATE_KEY, "phase"]), "done");
});
