/**
 * Proposed regression for PR #3661, Codex V source review.
 * NOT EXECUTED by V: GitHub integration only. This file is evidence, not wired into product CI.
 * Run under the repository's normal test aliases/MemoryRedis runner before adopting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { startImport } from "@/lib/imports";
import { IMPORTS_MOST, apiReadUnits } from "@/lib/api-read-rules";
import { allowanceUsed } from "@/lib/store-allowance";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "../../tests/billing-period-fixture";
import { store as redis } from "../../tests/redis-stub";

test("get_imports refuses a well-shaped record whose id is not the indexed id", async () => {
  redis.clear();
  const previousFetch = globalThis.fetch;
  const originalPipeline = redis.pipeline;
  let outside = 0;
  globalThis.fetch = async () => { outside++; throw Error("No external service in this synthetic regression"); };
  try {
    const email = "v-import-own-id@example.com";
    await claimHandle(email, "v-import-own-id", "Synthetic review", "");
    await ensureStatsId(email);
    await setSubscription(email, { customerId: "cus_VImportOwnId", subscriptionId: "sub_VImportOwnId", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const store = (await storeForEmail(email))!;
    const key = await makeKey(store.sid, "Synthetic review");
    assert.equal(key.ok, true);
    if (!key.ok) throw Error("No synthetic key");
    const made = await startImport(store, email, "contacts", { expected: 1, file: "synthetic.csv", agreed: true });
    assert.equal(made.ok, true);
    if (!made.ok) throw Error("No synthetic import");
    const askedId = made.job.id;
    const otherId = askedId === "b".repeat(24) ? "c".repeat(24) : "b".repeat(24);
    const call = async () => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + key.key },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_imports", arguments: {} } }),
      }));
      const body = await response.json();
      assert.ok(body.result, "authorization succeeds");
      return { result: body.result, value: JSON.parse(body.result.content[0].text) };
    };
    const control = await call();
    assert.equal(control.result.isError, false);
    assert.deepEqual(control.value.imports.map((job: {id: string}) => job.id), [askedId]);
    let substituted = false;
    redis.pipeline = async batch => {
      const answer = await originalPipeline.call(redis, batch);
      return answer.map((raw: unknown, i: number) => {
        if (batch[i][0] !== "GET" || batch[i][1] !== "nl:import:" + askedId) return raw;
        assert.equal(typeof raw, "string");
        substituted = true;
        return JSON.stringify({ ...JSON.parse(raw as string), id: otherId });
      });
    };
    const used = async () => allowanceUsed((await storeForEmail(email))!, "api");
    const before = await used();
    const wrong = await call();
    const kept = (await used()) - before;
    assert.equal(substituted, true, "the valid-shaped other id was returned for the asked key");
    assert.equal(wrong.result.isError, true, "wrong identity is unknown, not a known history");
    assert.equal("imports" in wrong.value, false, "no substitute row is sent as this history");
    assert.match(String(wrong.value.error), /imports could not be read/i);
    assert.equal(kept, 1 + apiReadUnits(IMPORTS_MOST), "door plus full hold stays kept");
    assert.equal(outside, 0);
  } finally {
    redis.pipeline = originalPipeline;
    globalThis.fetch = previousFetch;
  }
});
