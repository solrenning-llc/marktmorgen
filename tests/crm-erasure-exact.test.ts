/**
 * A store's CRM goes with the store only on confirmed replies (#4675, found by Codex L). forgetCrm sent one DEL for
 * the fields, pipelines, deals, tasks and every answers hash and never read what it answered, so a reply that did
 * not confirm it ran let the closing count the CRM as forgotten while people's keys, addresses and private notes
 * stayed. Each DEL (the main one and the one under the tasks lock) now must confirm a count from 0 to the keys it
 * was sent; anything else throws UnknownReplyError. Synthetic store; MemoryRedis.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetCrm } from "@/lib/crm";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "statscrm0001";
const real = redis.pipeline.bind(redis);
const DEALS = `nl:crm:deals:${STATS}`;
const TASKS = `nl:crm:tasks:${STATS}`;

function seed(): void {
  redis.clear();
  redis.pipeline = real;
  redis.run(["SET", DEALS, JSON.stringify([{ id: "d1", person: "a".repeat(32), title: "Private deal" }])]);
  redis.run(["SET", TASKS, JSON.stringify([{ id: "t1", text: "Call Ana" }])]);
}

/** The pipeline, with the reply to a DEL matching `when` replaced by `reply`. */
function answer(when: (c: (string | number)[]) => boolean, reply: unknown): void {
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "DEL" && when(c))) return reply;
    return real(commands);
  }) as typeof redis.pipeline;
}

test("healthy replies: the deals and tasks go, and it resolves", async () => {
  seed();
  await forgetCrm(STATS).catch((error: unknown) => {
    // An empty fields record may read as unavailable; the deletes still ran and are what is checked here.
    if (!(error instanceof Error) || error.name !== "CrmSchemaReadUnavailable") throw error;
  });
  assert.deepEqual([redis.run(["EXISTS", DEALS]), redis.run(["EXISTS", TASKS])], [0, 0]);
});

for (const [label, reply] of [["no reply", []], ["text", ["OK"]], ["more than it was sent", [99]], ["a negative count", [-1]], ["two replies", [1, 1]]] as const) {
  test(`the main DEL answered with ${label}: throws, never done`, async () => {
    seed();
    answer((c) => c.includes(DEALS), reply);
    await assert.rejects(() => forgetCrm(STATS), UnknownReplyError);
  });
}

test("the DEL under the tasks lock answered unknown: throws, never done", async () => {
  seed();
  answer((c) => c.length === 2 && c[1] === TASKS, []);
  await assert.rejects(() => forgetCrm(STATS), UnknownReplyError);
});

test("the main DEL's reply unreadable: the DEL under the tasks lock is still sent, then it throws (Claude 6 on #4693)", async () => {
  seed();
  // The main DEL never reaches the store here, as if a change read before it had written the tasks back: only the
  // locked DEL can take them, and it must still be sent although the main DEL's reply could not be read.
  answer((c) => c.includes(DEALS), ["OK"]);
  await assert.rejects(() => forgetCrm(STATS), UnknownReplyError);
  redis.pipeline = real;
  assert.equal(redis.run(["EXISTS", TASKS]), 0);
});
