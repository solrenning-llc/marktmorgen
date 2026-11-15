/**
 * Issue #4679 (erasure, HIGH): a deleted store's webhook erasure (lib/webhooks.ts, forgetStoreWebhooks) ignored every
 * reply of its deletion pipeline, so an unconfirmed answer left endpoint secrets, delivery bodies with buyers' data,
 * the log and queued deliveries behind while the step resolved. Transcribed from Claude 2's reproduction on main
 * @e4dbb5e9bf. Every reply is now read exactly; anything else throws and the step can be repeated.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { forgetStoreWebhooks } from "@/lib/webhooks";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const HOOKS = "st_d3_hooks";
const delivery = `dlv_${"b".repeat(24)}`;
const cfgKey = `nl:hooks:cfg:${HOOKS}`;
const bodyKey = `nl:hooks:d:${delivery}`;
const logKey = `nl:hooks:log:${HOOKS}`;

test("store webhook erasure rejects unconfirmed deletion replies", async () => {
  redis.clear();
  await redis.pipeline([
    ["SET", bodyKey, JSON.stringify({ id: delivery, statsId: HOOKS, body: '{"email":"buyer@example.com"}' })],
    ["LPUSH", logKey, delivery],
    ["ZADD", "nl:hooks:q", 1, `${HOOKS}|${delivery}`],
  ]);
  const real = redis.pipeline.bind(redis);
  // The deletion pipeline (the only one with DEL and SREM) answers [] without running; the reading pipeline answers as it is.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "DEL") && commands.some((c) => c[0] === "SREM")) return [];
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(() => forgetStoreWebhooks(HOOKS), UnknownReplyError);
  } finally {
    redis.pipeline = real;
  }
  const exists = async (k: string) => ((await redis.pipeline([["EXISTS", k]])) as number[])[0];
  assert.deepEqual([await exists(bodyKey), await exists(logKey), ((await redis.pipeline([["ZCARD", "nl:hooks:q"]])) as number[])[0]], [1, 1, 1], "body, log and queue entry preserved for retry");
});

test("a confirmed deletion still takes the configuration, bodies, log and queue entries away", async () => {
  redis.clear();
  await redis.pipeline([
    ["SET", cfgKey, JSON.stringify({ endpoints: [] })],
    ["SET", bodyKey, JSON.stringify({ id: delivery, statsId: HOOKS, body: '{"email":"buyer@example.com"}' })],
    ["LPUSH", logKey, delivery],
    ["ZADD", "nl:hooks:q", 1, `${HOOKS}|${delivery}`],
  ]);
  await forgetStoreWebhooks(HOOKS);
  const exists = async (k: string) => ((await redis.pipeline([["EXISTS", k]])) as number[])[0];
  assert.deepEqual([await exists(cfgKey), await exists(bodyKey), await exists(logKey), ((await redis.pipeline([["ZCARD", "nl:hooks:q"]])) as number[])[0]], [0, 0, 0, 0]);
});
