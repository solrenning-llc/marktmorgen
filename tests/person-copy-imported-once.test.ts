import assert from "node:assert/strict";
import { COPIERS } from "@/lib/person-copy";
import { importedKey } from "@/lib/imported-purchases";
import type { ErasureScope } from "@/lib/erasure-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

/**
 * Issue #5125, row (1) imported-purchases (coordinator b5da): one person's copy read the person's imported hash
 * (lib/imported-purchases.ts, nl:imp:buy:<statsId>:<address hash>) three times, once for its own section and once
 * each for the gifts and the group places they received (lib/person-copy.ts). The copy reads it once and the three
 * readers share that one read, as they already share the person's paid checkouts (checkoutsOf).
 */
const statsId = "c".repeat(32);
const sid = "s".repeat(32);
const email = "ann@example.com";
const store = { sid, statsId } as Store;
const scope = { store, sid, statsId, listId: null, email, person: "p".repeat(32), learner: "l".repeat(32), courses: [], productIds: [] } as unknown as ErasureScope;
const key = importedKey(statsId, email);

let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); checks += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`, error); process.exitCode = 1; }
}

async function main() {
  await redis.pipeline([
    ["HSET", key, "prod_a", JSON.stringify({ at: 1_790_000_000, job: "imp_" + "a".repeat(24), items: null })],
    ["HSET", key, "prod_b", JSON.stringify({ at: 1_790_000_100, job: "gift:" + "g".repeat(16), items: null })],
    ["HSET", key, "prod_c", JSON.stringify({ at: 1_790_000_200, job: "group:" + "r".repeat(16), items: null })],
  ]);

  const pipeline = redis.pipeline.bind(redis);
  const reads: string[] = [];
  redis.pipeline = async (batch) => {
    for (const command of batch) if (String(command[0]).toUpperCase() === "HGETALL" && command[1] === key) reads.push(String(command[0]));
    return pipeline(batch);
  };
  const out: Record<string, unknown[]> = {};
  try {
    for (const copied of ["lib/imported-purchases.ts", "lib/gifts.ts", "lib/group-buy.ts"]) {
      const copier = COPIERS[copied];
      assert.ok(copier, `${copied} has a copier`);
      out[copied] = await copier(scope);
    }
  } finally {
    redis.pipeline = pipeline;
  }

  await check("the person's imported hash is read once for the three readers that need it", async () => {
    assert.equal(reads.length, 1, `reads of ${key}: ${reads.length}`);
  });
  await check("and the copy still lists every purchase it holds", async () => {
    const rows = out["lib/imported-purchases.ts"] as { productId: string }[];
    assert.deepEqual(rows.map((r) => r.productId).sort(), ["prod_a", "prod_b", "prod_c"]);
  });
  await check("a second copy of the same person reads it afresh", async () => {
    const again = { ...scope } as ErasureScope;
    await redis.pipeline([["HDEL", key, "prod_a"]]);
    const rows = (await COPIERS["lib/imported-purchases.ts"]!(again)) as { productId: string }[];
    assert.deepEqual(rows.map((r) => r.productId).sort(), ["prod_b", "prod_c"]);
  });

  console.log(process.exitCode ? `${checks} checks passed; some failed.` : `${checks} checks, all passing.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
