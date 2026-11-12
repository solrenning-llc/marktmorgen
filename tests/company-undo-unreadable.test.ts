/**
 * The company kept for an undo is read exactly before a restore (CX-123 rule 24; Codex G's and Claude 4's LOW on
 * #3694, lib/crm-companies.ts undoCompany): a kept record that cannot be read as a company is unknown, never "none
 * kept". Before, a malformed record read as absent, so a restore went ahead without it and could put back an empty
 * company instead of refusing with an unknown state. Now the change is refused (CompaniesUnreadable, answered 503
 * by the route) and nothing is written; with no record kept, a restore still goes ahead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CompaniesUnreadable, changeCompanies, readCompanies, restoreCompany } from "@/lib/crm-companies";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

async function seed() {
  redis.clear();
  const owner = "undo-unreadable@example.test";
  assert.equal((await claimHandle(owner, "undounreadable", "Synthetic shop", "")).ok, true);
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const paid = await setSubscription(owner, { customerId: "cus_UndoUnread", subscriptionId: "sub_UndoUnread", active: true, tier: "creator", period: paidPeriod() });
  assert.ok(paid?.subscriptionActive);
  const store = await storeForEmail(owner);
  assert.ok(store?.statsId);
  return store;
}

/** A restore as the route asks for it: the undo read, the company put back with the undo's people when it is the same. */
function restore(seen: { undo?: unknown }) {
  return (companies: Parameters<typeof restoreCompany>[0], _unreadable: readonly string[], undo: { name: string; people: string[] } | null) => {
    seen.undo = undo;
    return restoreCompany(companies, { name: "Synthetic company", website: "", note: "" }, "abcdef0123", 100, [], undo ? undo.people : []);
  };
}

for (const [name, raw] of [
  ["not JSON", "{not json"],
  ["JSON that is not a company", JSON.stringify({ id: 5, name: [] })],
  ["a list", "[]"],
] as const) {
  test(`a kept undo that is ${name} refuses the restore and writes nothing`, async () => {
    const store = await seed();
    redis.run(["SET", `nl:crm:co:undo:${store.statsId}`, raw]);
    const seen: { undo?: unknown } = {};
    await assert.rejects(changeCompanies(store.statsId!, store, restore(seen) as never, true), CompaniesUnreadable);
    assert.equal("undo" in seen, false, "the change is never asked with an undo said to be none");
    assert.deepEqual(await readCompanies(store.statsId), [], "no company was put back");
    assert.equal(redis.run(["GET", `nl:crm:co:undo:${store.statsId}`]), raw, "the kept record is left as it was");
  });
}

test("control: with no undo kept, a restore goes ahead", async () => {
  const store = await seed();
  const seen: { undo?: unknown } = {};
  const result = await changeCompanies(store.statsId!, store, restore(seen) as never, true);
  assert.equal(result.ok, true);
  assert.equal(seen.undo, null);
  assert.equal((await readCompanies(store.statsId)).length, 1);
});
