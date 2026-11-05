import assert from "node:assert/strict";
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, storeForEmail } from "@/lib/store";
import { importedKey } from "@/lib/imported-purchases";
import { paidCourses } from "@/lib/learn";
import { store as redis } from "../../tests/redis-stub";

async function main(): Promise<void> {
  redis.clear();
  const owner = "owner-import-proof@example.test";
  const buyer = "buyer-import-proof@example.test";
  assert.ok((await claimHandle(owner, "import-proof", "Import proof", "")).ok);
  await ensureStatsId(owner);
  await setPastBuyers(owner);
  const made = await addProduct(owner, "Imported course", "", "12", null);
  assert.ok(made.ok);
  await setProductCourse(owner, made.product.id, { id: "a".repeat(32), lessons: 1 });
  const store = (await storeForEmail(owner))!;

  assert.equal((await paidCourses(store, buyer)).has(made.product.id), false, "control: no kept purchase gives no course");
  await redis.pipeline([["HSET", importedKey(store.statsId!, buyer), made.product.id, JSON.stringify({ items: null })]]);
  assert.equal(
    (await paidCourses(store, buyer)).has(made.product.id),
    false,
    "a malformed kept purchase without at/job must not become a course right at time zero",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
