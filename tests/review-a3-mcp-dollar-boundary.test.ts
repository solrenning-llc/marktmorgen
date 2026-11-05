/** Independent dimensional check of A3's earlier 20KB claim. The original
 * proof remains unchanged; this separately measures the actual dollar model.
 * Synthetic route/Redis adapter only; not supplier billing certification. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addDraftProducts, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_LINK_LENGTH } from "@/lib/product-link";
import { paidPeriod } from "./billing-period-fixture";

import { apiReadCost, request, UNIT_COST } from "./plan-cost-registry";

test("the prior byte counterexample is funded in dollars before the data read and after settlement", async () => {
  redis.clear();
  const email = "review-a3-meter@example.test";
  await claimHandle(email, "review-a3-meter", "Synthetic meter review", "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: "cus_A3MeterReview", subscriptionId: "sub_A3MeterReview",
    active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const link = "https://example.test/".padEnd(MAX_LINK_LENGTH, "x");
  assert.equal(new URL(link).protocol, "https:");
  const made = await addDraftProducts(email, Array.from({ length: 150 }, (_, i) => ({
    title: `Guide ${i} ${"€".repeat(70)}`, summary: "€".repeat(300), priceCents: 1900, link,
  })));
  assert.ok(made.ok);
  const store = (await storeForEmail(email))!;
  const key = await makeKey(store.sid, "Synthetic review");
  assert.ok(key.ok);
  const original = redis.pipeline, originalFetch = globalThis.fetch;
  let firstRead = -1, step = 0, bytes = 0, listings = 0, cards = 0;
  let commandsRead = 0, roundTrips = 0, wireBytes = 0;
  const debits: { at: number; units: number }[] = [];
  redis.pipeline = async commands => {
    const answers = await original.call(redis, commands);
    assert.ok(commands.every(c => c[0] !== "EVAL"), "this measured route contains no uncounted Lua calls");
    commandsRead += commands.length;
    roundTrips++;
    wireBytes += Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(answers));
    commands.forEach((c, i) => {
      step++;
      if ((c[0] === "INCRBY" || c[0] === "DECRBY") && String(c[1]).includes(":api:")) {
        debits.push({ at: step, units: Number(c[2]) * (c[0] === "DECRBY" ? -1 : 1) });
      }
      if (c[0] === "HMGET" && /^nl:catalog:.*:t$/.test(String(c[1]))) {
        if (firstRead < 0) firstRead = step;
        const values = answers[i];
        assert.ok(Array.isArray(values));
        cards += values.length;
        bytes += values.reduce((n: number, value: unknown) => n + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0);
      }
      if (c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))) {
        if (firstRead < 0) firstRead = step;
        listings++;
        bytes += Buffer.byteLength(String(answers[i]));
      }
    });
    return answers;
  };
  globalThis.fetch = async () => { throw Error("No external requests in review"); };
  try {
    const response = await POST(new Request("https://example.test/api/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_bundle_choices", arguments: { cursor: "20", search: "Guide" } } }),
    }));
    const body = await response.json();
    assert.equal(body.result?.isError, false);
    assert.equal(JSON.parse(body.result.content[0].text).products.length, 19);
    assert.equal(listings, 19);
    assert.equal(cards, 100);
    const prepaid = debits.filter(d => d.at < firstRead && d.units > 0).reduce((n, d) => n + d.units, 0);
    const netUnits = debits.reduce((n, debit) => n + debit.units, 0);
    const responseBytes = Buffer.byteLength(JSON.stringify(body));
    // Count ALL observed command/response bytes and trips, including the
    // door and taking/settling, plus the door call/CPU/memory shape. This
    // deliberately counts any overlapping wait coverage twice, never zero.
    const modeledCost = request("light", 0, 0) + apiReadCost({ commands: commandsRead, bytes: wireBytes,
      sent: responseBytes, stripePages: 0, roundTrips });
    const heldDollars = prepaid * UNIT_COST.api, settledDollars = netUnits * UNIT_COST.api;
    console.log(JSON.stringify({ bytes, listings, cards, prepaid, netUnits, commandsRead, roundTrips, wireBytes,
      responseBytes, modeledCost, heldDollars, settledDollars, unitCost: UNIT_COST.api }));
    assert.ok(prepaid > 0 && netUnits > 0);
    assert.ok(heldDollars >= modeledCost, "money was reserved before the first catalog data read");
    assert.ok(settledDollars >= modeledCost, "the settlement still funds all conservatively observed work");
    assert.ok(UNIT_COST.api < modeledCost, "a single unit is genuinely insufficient under the same dollar calculation");
  } finally { redis.pipeline = original; globalThis.fetch = originalFetch; }
});
