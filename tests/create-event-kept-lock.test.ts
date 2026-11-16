/**
 * Claude 5 on #2957 (MÉDIO, privacy, at the cause): createEvent counted the community's events, let the oldest go and
 * added the new one in three separate steps. Two events made at once with the index one short of MAX_KEPT_EVENTS each
 * counted before the other's ZADD, so the index ended past the cap; from then on every member's erasure and copy were
 * refused (lib/community-events.ts forgetRsvpsPerson, rsvpsOf) until the creator made or deleted an event. The count,
 * the oldest let go and the ZADD now run under one lock per community, so the index never passes the cap. Synthetic data
 * only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createEvent } from "@/lib/community-events";
import { MAX_KEPT_EVENTS } from "@/lib/community-text";
import { claimHandle, ensureStatsId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const OWNER = "kept-lock-owner@example.com";
const DAY = 86_400_000;
const input = (title: string, start: number) => ({ title, about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start, cap: 0 }) as never;

async function setUp(): Promise<{ store: Store; index: string }> {
  redis.clear();
  await claimHandle(OWNER, "keptlock", "Kept lock proof", "A community.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { active: true, tier: "pro", cycle: "month", subscriptionId: null, customerId: null, trialEnds: 0 } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  return { store, index: `nl:cm:${store.community!.id}:evs` };
}

const size = async (index: string) => Number((await redis.pipeline([["ZCARD", index]]))[0]);

test(`two events made at once with ${MAX_KEPT_EVENTS - 1} kept: the index ends at MAX_KEPT_EVENTS, never past it`, async () => {
  const { store, index } = await setUp();
  const now = Date.now();
  // Long over, so either may be let go to make room.
  for (let i = 0; i < MAX_KEPT_EVENTS - 1; i++) {
    const made = await createEvent(store, input(`Past ${i}`, now - 400 * DAY + i * 60_000), now);
    assert.ok(made.ok, `synthetic past event ${i} made`);
  }
  assert.equal(await size(index), MAX_KEPT_EVENTS - 1);
  const both = await Promise.all([createEvent(store, input("First", now + 3 * DAY), now), createEvent(store, input("Second", now + 4 * DAY), now)]);
  const kept = await size(index);
  assert.ok(kept <= MAX_KEPT_EVENTS, `the index holds ${kept} events, more than MAX_KEPT_EVENTS (${MAX_KEPT_EVENTS})`);
  // Each one is either made or refused as busy, never an error; at least one is made.
  for (const made of both) assert.ok(made.ok || made.reason === "busy", `made, or refused as busy: ${JSON.stringify(made)}`);
  assert.ok(both.some((m) => m.ok), "at least one of the two is made");
});

test("an event made while another is being made for the same community waits for it, then is made", async () => {
  const { store, index } = await setUp();
  const now = Date.now();
  const both = await Promise.all([createEvent(store, input("One", now + 3 * DAY), now), createEvent(store, input("Two", now + 4 * DAY), now)]);
  assert.deepEqual(both.map((m) => m.ok), [true, true]);
  assert.equal(await size(index), 2);
});
