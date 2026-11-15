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

// Its own world (tests/aliases/meta-disconnect-redis-off.test.ts.json): lib/redis answers not configured.
test("disconnecting while Redis is not configured is unknown, never \"not connected\"", async () => {
  await assert.rejects(disconnectMeta("s1metaoff"), (error: unknown) => error instanceof UnknownReplyError);
});
