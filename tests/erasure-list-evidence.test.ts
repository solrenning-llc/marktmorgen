/** A lost list-blank receipt cannot certify that deletion finished. */
import assert from "node:assert/strict";
import test from "node:test";
import { BLANK_IN_LISTS, ERASED_MARK, blankInLists } from "@/lib/erasure-lists";
import { erasePerson } from "@/lib/person-erasure";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const email = "erasure-list-person@example.test";
const bad: [string, unknown[]][] = [
  ["missing", []], ["undefined", [undefined]], ["null", [null]], ["string", ["0"]],
  ["false", [false]], ["array", [[]]], ["object", [{}]], ["negative", [-1]],
  ["fraction", [1.5]], ["NaN", [NaN]], ["infinite", [Infinity]],
  ["unsafe", [Number.MAX_SAFE_INTEGER + 1]], ["extra", [0, 1]], ["sparse", new Array(1)],
];
for (const [name, reply] of bad) test(`${name} acknowledgement is unknown, with no replay or false zero`, async () => {
  redis.clear();
  const key = "synthetic:erasure-list";
  redis.run(["RPUSH", key, email]);
  const original = redis.pipeline.bind(redis);
  let scripts = 0;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "EVAL" && c[1] === BLANK_IN_LISTS)) { scripts++; return reply; }
    return original(commands);
  };
  try {
    await assert.rejects(blankInLists([key], email), /could not be confirmed.*try again/i);
    assert.equal(scripts, 1, "an unknown write is never replayed");
    assert.deepEqual(redis.run(["LRANGE", key, 0, -1]), [email]);
  } finally { redis.pipeline = original; }
});

for (const applied of [false, true]) test(`the actual person-erasure flow stays incomplete on a lost list receipt (applied=${applied})`, async () => {
  redis.clear();
  const original = redis.pipeline.bind(redis), oldFetch = globalThis.fetch, oldLog = console.error;
  globalThis.fetch = async () => { throw new Error("No external provider allowed"); };
  const owner = "erasure-list-owner@example.test";
  await claimHandle(owner, "erasurelist", "Erasure List", "");
  await ensureStoreId(owner); await ensureStatsId(owner); await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_ErasureList", subscriptionId: "sub_ErasureList", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic waitlist", "", "27", null); assert.ok(made.ok);
  const shop = (await storeForEmail(owner))!;
  const key = `nl:wl:${shop.statsId}:${made.product.id}:send`;
  redis.run(["RPUSH", key, email]);
  let scripts = 0;
  redis.pipeline = async commands => {
    if (commands.some(c => c[0] === "EVAL" && c[1] === BLANK_IN_LISTS)) {
      scripts++; if (applied) await original(commands); return [];
    }
    return original(commands);
  };
  console.error = () => {};
  try {
    const result = await erasePerson(shop, email, { kind: "person" });
    assert.equal(scripts, 1);
    assert.equal(result.ok, false, "unknown erasure is never certified complete");
    assert.ok(!result.ok && result.reason === "incomplete");
    assert.ok(result.failed.includes("lib/waitlist.ts"));
    assert.deepEqual(redis.run(["LRANGE", key, 0, -1]), [applied ? ERASED_MARK : email]);
    redis.pipeline = original;
    const recovered = await erasePerson(shop, email, { kind: "person" });
    assert.equal(recovered.ok, true, "the same deletion can finish after a confirmed retry");
    assert.deepEqual(redis.run(["LRANGE", key, 0, -1]), [ERASED_MARK]);
  } finally { redis.pipeline = original; globalThis.fetch = oldFetch; console.error = oldLog; }
});

test("confirmed counts keep positions and distinguish a real zero", async () => {
  redis.clear(); const key = "synthetic:erasure-list";
  redis.run(["RPUSH", key, email, "other@example.test", email]);
  assert.equal(await blankInLists([key], email), 2);
  assert.deepEqual(redis.run(["LRANGE", key, 0, -1]), [ERASED_MARK, "other@example.test", ERASED_MARK]);
  assert.equal(await blankInLists([key], email), 0);
  assert.equal(await blankInLists([], email), 0);
});
