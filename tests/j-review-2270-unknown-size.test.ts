import assert from "node:assert/strict";
import test from "node:test";
import { buyerLedger, LedgerNotCounted } from "@/lib/segments";
import { IncludedBytes, PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

// All records and I/O are synthetic. Exercise the actual ledger reader, not a copy of its validation.
const statsId = "jreviewledger";
const key = `nl:stats:${statsId}:ledger`;
const shop = { statsId, currency: "usd", pastBuyers: true } as Store;
// Rule 23: the kept copy's shape is 7 since it says why it is partial (m, q; lib/segments.ts LEDGER_SHAPE), was 6.
const cached = JSON.stringify({ c: "usd", p: false, m: false, q: false, r: [["buyer@example.com", 1200, 1, "direct", 1]], v: 7 });
const pipeline = redis.pipeline.bind(redis);

async function readWith(reply: unknown[], empty = false) {
  redis.clear();
  if (!empty) await pipeline([["SET", key, cached, "EX", 600]]);
  const commands: string[] = [];
  const charged: number[] = [];
  redis.pipeline = (async (rows: (string | number)[][]) => {
    if (rows.length === 1 && rows[0][0] === "STRLEN" && rows[0][1] === key) return reply;
    commands.push(...rows.map((row) => String(row[0])));
    return pipeline(rows);
  }) as typeof redis.pipeline;
  const included = new IncludedBytes();
  included.take(PAGE_INCLUDED_BYTES, 1_000_000);
  try {
    const result = await buyerLedger(shop, async (units) => { charged.push(units); return true; }, included);
    return { outcome: "read", buyers: result.buyers.size, partial: result.partial, commands, charged };
  } catch (error) {
    return { outcome: error instanceof LedgerNotCounted ? "unknown" : String(error), commands, charged };
  } finally {
    redis.pipeline = pipeline;
  }
}

test("control: a measured cache beyond the shared allowance is counted and read", async () => {
  const result = await readWith([Buffer.byteLength(cached)]);
  assert.equal(result.outcome, "read");
  assert.equal("buyers" in result && result.buyers, 1);
  assert.deepEqual(result.charged, [1]);
  assert.deepEqual(result.commands, ["GETRANGE"]);
});

test("control: a confirmed zero permits the ordinary empty imported-buyer reading", async () => {
  const result = await readWith([0], true);
  assert.equal(result.outcome, "read");
  assert.equal("buyers" in result && result.buyers, 0);
});

for (const [name, reply] of [
  ["missing slot", []],
  ["undefined", [undefined]],
  ["null", [null]],
  ["nested empty list", [[]]],
  ["boolean false", [false]],
  ["empty string", [""]],
  ["extra slot", [Buffer.byteLength(cached), 0]],
] as const) {
  test(`unknown STRLEN ${name} refuses before further reading or cache mutation`, async () => {
    const result = await readWith([...reply]);
    const after = (await pipeline([["GET", key]]))[0];
    assert.deepEqual({ outcome: result.outcome, commands: result.commands, charged: result.charged, unchanged: after === cached },
      { outcome: "unknown", commands: [], charged: [], unchanged: true });
  });
}
