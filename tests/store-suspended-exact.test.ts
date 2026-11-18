/**
 * Rule 24 in lib/store.ts parseStore: a store record's `suspended` (the day its pages and sales were switched off
 * after notices, lib/takedown.ts) is read exactly. Absent or "" is a store that is on; a date is a store switched
 * off; anything else (a later version's shape after a rollback, true, a number, text that is not a date) is
 * unknown, and unknown is never "not suspended": canSell, the inbox, the sitemap and every mail read it as on and
 * reopened a store taken down, and the next save wrote "" over the takedown for good.
 *
 * Synthetic store only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, noteTakedown, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const OWNER = "takedown@example.com";
redis.clear();
const fixture = (async () => {
  assert.equal((await claimHandle(OWNER, "takenshop", "Taken", "")).ok, true);
  const [page] = await redis.pipeline([["SCAN", "0", "MATCH", "nl:store:owner:*", "COUNT", 1000]]);
  const keys = (page as [string, string[]])[1];
  assert.equal(keys.length, 1);
  return keys[0];
})();

async function withSuspended(value: unknown): Promise<void> {
  const key = await fixture;
  const [raw] = await redis.pipeline([["GET", key]]);
  const record = JSON.parse(raw as string) as Record<string, unknown>;
  if (value === undefined) delete record.suspended;
  else record.suspended = value;
  await redis.pipeline([["SET", key, JSON.stringify(record)]]);
}

test("a store never suspended reads as on, and a dated takedown as off", async () => {
  await withSuspended(undefined);
  assert.equal((await storeForEmail(OWNER))?.suspended, "");
  await withSuspended("");
  assert.equal((await storeForEmail(OWNER))?.suspended, "");
  await withSuspended("2026-11-01T10:00:00.000Z");
  assert.equal((await storeForEmail(OWNER))?.suspended, "2026-11-01T10:00:00.000Z");
});

for (const [label, value] of [
  ["true", true],
  ["a number", 1_762_000_000],
  ["text that is not a date", "yes"],
  ["null", null],
  ["an object", { since: "2026-11-01" }],
] as [string, unknown][]) {
  test(`suspended read as ${label} is unknown, never "on sale"`, async () => {
    await withSuspended(value);
    const store = await storeForEmail(OWNER);
    assert.ok(store, "the store still reads");
    assert.ok(store.suspended, `switched off, not ${JSON.stringify(store.suspended)}`);
  });

  test(`suspended read as ${label} is not written over as "on" by the next save`, async () => {
    await withSuspended(value);
    await noteTakedown(OWNER, null);
    assert.ok((await storeForEmail(OWNER))?.suspended, "still switched off after a save that did not lift it");
  });
}

test("lifting a takedown still turns the store back on", async () => {
  await withSuspended("yes");
  await noteTakedown(OWNER, null, false);
  assert.equal((await storeForEmail(OWNER))?.suspended, "");
});
