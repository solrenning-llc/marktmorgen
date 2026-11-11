/**
 * Rule 24 in lib/store.ts:
 *
 *   - storesAfter (every scheduled job that walks all stores, and moveAllStores): a SCAN reply cut short or of another
 *     shape, or GETs that do not come back one per key, throw, never "the walk is complete" (cursor "0"), which ended
 *     seven daily jobs early and let moveAllStores delete its cursor and call the move complete;
 *   - claimHandle, createStore, renameHandle: an address's SET NX is ours only on "OK" or our own value read back
 *     (claimMark); a reply cut short or of another shape never takes an address another store holds;
 *   - createStore: the stores-per-account count (SCARD) is a whole number or unknown, never NaN that passed the cap.
 *
 * Synthetic accounts and stores only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_STORES_PER_ACCOUNT, claimHandle, createStore, renameHandle, storeForEmail, storeForHandle, storesAfter } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
async function answered<T>(pick: (batch: Batch) => boolean, alter: (real: unknown[]) => unknown[], run: () => Promise<T>, execute = true): Promise<{ value?: T; error?: unknown }> {
  redis.pipeline = (async (batch: Batch) => {
    if (!pick(batch)) return pipeline(batch);
    const real = execute ? await pipeline(batch) : batch.map(() => null);
    return alter(real);
  }) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = pipeline;
  }
}

redis.clear();
const fixture = (async () => {
  for (const [email, handle] of [["held@example.com", "heldaddress"], ["other@example.com", "otheraddress"]]) {
    const made = await claimHandle(email, handle, "Shop", "");
    assert.equal(made.ok, true);
  }
})();

const scan = (batch: Batch) => batch.length === 1 && batch[0][0] === "SCAN";
for (const [label, alter] of [
  ["no reply", () => []],
  ["a number", () => [7]],
  ["only a cursor", () => [["0"]]],
  ["keys that are not a list", (r: unknown[]) => [[(r[0] as unknown[])[0], 7]]],
  ["a cursor that is not text", (r: unknown[]) => [[5, (r[0] as unknown[])[1]]]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`storesAfter: a SCAN read as ${label} throws, never "the walk is complete"`, async () => {
    await fixture;
    const result = await answered(scan, alter, () => storesAfter("0"));
    assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
  });
}

test("storesAfter: the GETs cut short throw, never a store left out", async () => {
  await fixture;
  const gets = (batch: Batch) => batch.length > 0 && batch.every((c) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:"));
  const result = await answered(gets, (r) => r.slice(0, -1), () => storesAfter("0"));
  assert.ok(result.error, `rejected, not ${JSON.stringify(result.value)}`);
});

test("storesAfter read exactly walks every store", async () => {
  await fixture;
  let cursor = "0";
  const seen = new Set<string>();
  do {
    const page = await storesAfter(cursor);
    page.stores.forEach((s) => seen.add(s.handle));
    cursor = page.next;
  } while (cursor !== "0");
  assert.ok(seen.has("heldaddress") && seen.has("otheraddress"));
});

const handleSet = (handle: string) => (batch: Batch) => batch.length === 1 && batch[0][0] === "SET" && batch[0][1] === `nl:store:handle:${handle}` && batch[0].includes("NX");
for (const [label, reply] of [["cut short", []], ["a number", [7]], ["an object", [{ result: "OK" }]]] as [string, unknown[]][]) {
  test(`claimHandle: another store's address, its SET NX answered ${label}, is never taken`, async () => {
    await fixture;
    const result = await answered(handleSet("heldaddress"), () => reply, () => claimHandle(`new-${label.replace(/\W/g, "")}@example.com`, "heldaddress", "Mine", ""));
    assert.notEqual(result.value && (result.value as { ok: boolean }).ok, true, "not taken");
    assert.equal((await storeForHandle("heldaddress"))?.email, "held@example.com", "the address still opens the store that holds it");
    assert.equal((await storeForEmail("held@example.com"))?.handle, "heldaddress");
  });
  test(`renameHandle: another store's address, its SET NX answered ${label}, is never taken`, async () => {
    await fixture;
    const result = await answered(handleSet("heldaddress"), () => reply, () => renameHandle("other@example.com", "heldaddress"));
    assert.notEqual(result.value && (result.value as { ok: boolean }).ok, true, "not renamed onto it");
    assert.equal((await storeForEmail("other@example.com"))?.handle, "otheraddress");
  });
  test(`createStore: another store's address, its SET NX answered ${label}, is never taken`, async () => {
    await fixture;
    const result = await answered(handleSet("heldaddress"), () => reply, () => createStore("other@example.com", "heldaddress", "Second", ""));
    assert.notEqual(result.value && (result.value as { ok: boolean }).ok, true, "not created on it");
  });
}

for (const [label, value] of [["null", null], ["empty text", ""], ["a list", []], ["missing", undefined]] as [string, unknown][]) {
  test(`createStore: the account's store count read as ${label} never passes the cap`, async () => {
    await fixture;
    const scard = (batch: Batch) => batch.length === 2 && batch[0][0] === "SADD" && batch[1][0] === "SCARD";
    const result = await answered(scard, (r) => [r[0], value], () => createStore("other@example.com", `extra${label.replace(/\W/g, "")}`, "Extra", ""));
    assert.notEqual(result.value && (result.value as { ok: boolean }).ok, true, `not created with an unread count (cap ${MAX_STORES_PER_ACCOUNT})`);
  });
}
