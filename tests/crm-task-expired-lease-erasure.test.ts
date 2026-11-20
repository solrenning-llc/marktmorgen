/**
 * Synthetic RED: apply this file alone to the cited main.
 * No product test is executed while preparing this report.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CrmValueWriteUnconfirmed, SAVE_TASK_COUNT, WRITE_PERSON_TASKS, changePersonTasks, forgetCrm, forgetCrmPerson, readPersonTasks } from "@/lib/crm";
import { addTask } from "@/lib/person-tasks";
import { claimHandle, ensureStatsId, ensureStoreId, ownerKey, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Batch = (string | number)[][];
test("a first task never returns after erasure completed under a newer tasks lock", async () => {
  const original = redis.pipeline.bind(redis);
  try {
    redis.clear();
    const owner = "task-lease@example.test";
    await claimHandle(owner, "task-lease", "Synthetic tasks", "");
    await ensureStoreId(owner);
    const shop = (await ensureStatsId(owner))!;
    assert.ok(shop.sid && shop.statsId);
    const person = "a".repeat(32), email = "ana@example.test";
    const key = "nl:crm:tasks:" + shop.statsId;
    const lock = "nl:crm:tasklock:" + shop.statsId;
    const live = storeIdCommand(shop.sid)[1], ref = storeRef(shop), record = await ownerKey(ref);
    const room = { ...ROOM, sid: shop.sid, statsId: shop.statsId };
    const change = () => changePersonTasks(shop.statsId!, person, room,
      tasks => addTask(tasks, { text: "Call Ana about her private appointment", due: "", assignee: "owner@example.test" }, "task000001", Math.floor(Date.now() / 1000)));
    for (const how of ["person", "store", "replacement-lock", "missing-lock"] as const) {
      redis.clear();
      await original([["SET", live, ref], ["SET", record, JSON.stringify(shop)]]);
      let intervened = false;
      redis.pipeline = async (batch: Batch) => {
        const write = batch.some(command => command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:crm-tasks-write:"));
        if (write && !intervened) {
          intervened = true;
          // The caller already refreshed the lock and reserved its room. Its Redis request is delayed >10 s.
          redis.advance(11_000);
          if (how === "person") await forgetCrmPerson(shop.statsId!, person, email);
          else if (how === "store") {
            await forgetCrm(shop.statsId!);
            await original([["DEL", live, record]]);
          } else if (how === "replacement-lock") await original([["SET", lock, "new-holder", "EX", 30]]);
          else await original([["DEL", lock]]);
        }
        return original(batch);
      };
      const result = await change().catch(error => error);
      redis.pipeline = original;
      assert.equal(intervened, true, "the actual commit boundary was reached");
      assert.equal(redis.run(["HGET", key, person]), null, how + ": no private task or assignee restored");
      assert.deepEqual(await readPersonTasks(shop.statsId!, person), []);
      assert.ok(result instanceof CrmValueWriteUnconfirmed, "the stale request never reports a successful save");
      assert.equal(redis.run(["GET", lock]), how === "replacement-lock" ? "new-holder" : null, "another holder's lock is never released");
    }
    redis.clear();
    await original([["SET", live, ref], ["SET", record, JSON.stringify(shop)]]);
    assert.equal((await change()).ok, true, "a live, still-held write still saves the task");
    assert.equal((await readPersonTasks(shop.statsId!, person)).length, 1);
  } finally { redis.pipeline = original; redis.clear(); }
});

test("both task Lua writers refuse a missing or replaced lease before changing the hash", () => {
  redis.clear();
  const tasks = "synthetic:crm:tasks", lock = "synthetic:crm:lock";
  try {
    for (const holder of [null, "new-holder"] as const) {
      redis.run(["DEL", tasks, lock]);
      if (holder) redis.run(["SET", lock, holder, "EX", 30]);
      assert.equal(redis.run(["EVAL", WRITE_PERSON_TASKS, 2, tasks, lock, "a".repeat(32), "", "[]", 1, "1", "count", "old-holder"]), -2);
      assert.equal(redis.run(["EXISTS", tasks]), 0);
      assert.equal(redis.run(["EVAL", SAVE_TASK_COUNT, 2, tasks, lock, "count", "2", "old-holder"]), -1);
      assert.equal(redis.run(["EXISTS", tasks]), 0);
      assert.equal(redis.run(["GET", lock]), holder);
    }
  } finally { redis.clear(); }
});
