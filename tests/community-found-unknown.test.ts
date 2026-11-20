/** Unknown community search reads stay hidden and are logged (rule 24). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsFound, membersFound } from "@/lib/community-found";
import type { Store } from "@/lib/store";
import type { CommunityConfig } from "@/lib/community";
import { store as redis } from "./redis-stub";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
process.env.UPSTASH_REDIS_REST_TOKEN ??= "synthetic";
const actual = redis.pipeline.bind(redis);

test("unknown event and member reads return no records and log the failure", async () => {
  const store = { community: { id: "0123456789abcdef0123456789abcdef" } } as Store;
  const config = {} as CommunityConfig;
  const viewer = { owner: false, email: "member@example.com", key: "synthetic" };
  const logged: unknown[][] = [];
  const previous = console.error;
  redis.pipeline = (async () => { throw new Error("synthetic Redis read failure"); }) as typeof redis.pipeline;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    assert.deepEqual(await eventsFound(store, config, ["0123456789ab"], viewer), []);
    assert.deepEqual(await membersFound(store.community!.id, ["member@example.com"]), []);
    assert.deepEqual(logged.map(([message]) => message), [
      "reading events for community search failed",
      "reading members for community search failed",
    ]);
  } finally {
    redis.pipeline = actual;
    console.error = previous;
  }
});
