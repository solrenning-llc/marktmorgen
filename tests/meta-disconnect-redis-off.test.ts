/**
 * Codex U's MEDIUM on #2924 (lib/meta-ads.ts disconnectMeta): with Redis not configured, disconnecting answered
 * false, which the route reads as "not connected" and tells the creator "disconnected", while the sealed token,
 * the connection and its lines stay stored. Redis off is an unknown state: disconnectMeta throws, the route
 * answers "error". Only a connection confirmed absent on a real read is false. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { disconnectMeta } from "@/lib/meta-ads";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const ENV = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_URL", "KV_REST_API_TOKEN"] as const;

test("disconnecting while Redis is not configured is unknown, never \"not connected\"", async () => {
  redis.clear();
  const kept = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  try {
    await assert.rejects(disconnectMeta("s1metaoff"), (error: unknown) => error instanceof UnknownReplyError);
  } finally {
    for (const name of ENV) if (kept[name] !== undefined) process.env[name] = kept[name];
  }
});

test("control: a store confirmed not connected on a real read is false", async () => {
  redis.clear();
  assert.equal(await disconnectMeta("s1metanone"), false);
});
