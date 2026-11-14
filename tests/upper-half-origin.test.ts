/**
 * Proves the seam in tests/upper-half-origin.ts: the precondition of
 * tests/pending-mail-recovery.test.ts ("the deterministic unsupported source
 * must precede the original confirmation") no longer depends on the draw.
 * Runs without Redis, so `npm test` holds it on every PR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto, { createHash, randomUUID } from "node:crypto";
import { shipmentMailId } from "@/lib/shipment-mail-outbox";
import { confirmationOriginId } from "@/lib/order-confirmation-outbox";
import { createCheckout } from "@/lib/store-checkout";
import { physicalPaidFixture, originId } from "./order-confirmation-paid-fixture";
import { store as redis } from "./redis-stub";
import { withUpperHalfOrigin, upperHalfNonce, UPPER_HALF } from "./upper-half-origin";

/** The same search as tests/pending-mail-recovery.test.ts: the first of 1,000 candidates that sorts before `id`, or -1. */
function precedingCandidate(id: string): number {
  for (let i = 0; i < 1000; i++) if (shipmentMailId("continuation_uncovered", "cs_test_uncoveredPrefix00000" + i) < id) return i;
  return -1;
}

test("the cause: a uniform origin id can sort below all 1,000 candidates", () => {
  // Deterministic counter nonces stand in for randomBytes(32); one such id is found in about 1,000 draws.
  const statsId = "0123456789abcdef0123456789abcdef";
  let found = "";
  for (let counter = 0; counter < 200_000 && !found; counter++) {
    const id = confirmationOriginId(statsId, createHash("sha256").update(`cause ${counter}`).digest("hex"));
    if (id < "01" && precedingCandidate(id) === -1) found = id;
  }
  assert.notEqual(found, "", "an id with no preceding candidate exists, so the old test could fail");
});

test("2,000 stores: every drawn origin id is in the upper half and has a preceding candidate", () => {
  for (let run = 0; run < 2000; run++) {
    const statsId = randomUUID().replace(/-/g, "");
    const { nonce } = upperHalfNonce(statsId, 0);
    assert.equal(nonce.length, 32);
    const id = confirmationOriginId(statsId, nonce.toString("hex"));
    assert.ok(id >= UPPER_HALF, `run ${run}: ${id} is in the upper half`);
    assert.ok(precedingCandidate(id) >= 0, `run ${run}: a candidate precedes ${id}`);
  }
});

test("the real checkout takes its nonce through the seam, 20 times in a row", async () => {
  for (let run = 0; run < 20; run++) {
    redis.clear();
    const f = await physicalPaidFixture();
    await withUpperHalfOrigin(f.store.statsId!, () => createCheckout(f.store, f.product, "https://example.test", undefined, {}, f.runtime));
    const id = originId();
    assert.ok(id >= UPPER_HALF, `run ${run}: the checkout's origin id ${id} is in the upper half`);
    assert.ok(precedingCandidate(id) >= 0, `run ${run}: a candidate precedes the checkout's origin`);
  }
  redis.clear();
});

test("other draws stay real, and randomBytes comes back exactly, even when the run throws", async () => {
  const before = Object.getOwnPropertyDescriptor(nodeCrypto, "randomBytes");
  const seen: { sixteen: number; callback: number; distinct: Set<string> } = { sixteen: 0, callback: 0, distinct: new Set() };
  await assert.rejects(withUpperHalfOrigin("0123456789abcdef0123456789abcdef", async () => {
    seen.sixteen = nodeCrypto.randomBytes(16).length;
    seen.callback = await new Promise<number>((done, fail) => nodeCrypto.randomBytes(8, (error, bytes) => error ? fail(error) : done(bytes.length)));
    for (let i = 0; i < 5; i++) seen.distinct.add(nodeCrypto.randomBytes(32).toString("hex"));
    throw new Error("synthetic stop");
  }), /synthetic stop/);
  assert.equal(seen.sixteen, 16);
  assert.equal(seen.callback, 8);
  assert.equal(seen.distinct.size, 5, "each 32-byte draw is a different value");
  assert.deepEqual(Object.getOwnPropertyDescriptor(nodeCrypto, "randomBytes"), before);
});
