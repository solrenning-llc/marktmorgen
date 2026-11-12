/**
 * Makes "a source that sorts before the original confirmation" exist on every
 * run of tests/pending-mail-recovery.test.ts, instead of on about 1,000 of
 * every 1,001.
 *
 * Why: createCheckout (lib/store-checkout.ts) draws the order's nonce with
 * randomBytes(32), and the confirmation origin's id is
 * confirmationOriginId(statsId, nonce), a SHA-256. That id is uniform, so it
 * fell below all of the test's 1,000 candidate shipment ids about once in
 * 1,001 runs (1/(N+1) for N candidates), and the test stopped on "the
 * deterministic unsupported source must precede the original confirmation"
 * (merge_group runs of product-checks, job form-opportunity-redis).
 *
 * While `run` opens the checkout, each randomBytes(32) without a callback
 * returns a counter-derived value whose origin id, for this store, is in the
 * upper half ("8" to "f"). Then each candidate precedes it with probability at
 * least 1/2, and none of 1,000 does with probability at most 2^-1000. Every
 * other draw (another size, or the callback form) is the real randomBytes.
 * The original property is put back exactly, even when `run` throws.
 */
import nodeCrypto from "node:crypto";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { confirmationOriginId } from "@/lib/order-confirmation-outbox";

export const UPPER_HALF = "8";

export function upperHalfNonce(statsId: string, start: number): { nonce: Buffer; next: number } {
  for (let counter = start; ; counter++) {
    const nonce = createHash("sha256").update(`pending-mail-recovery synthetic nonce ${counter}`).digest();
    if (confirmationOriginId(statsId, nonce.toString("hex")) >= UPPER_HALF) return { nonce, next: counter + 1 };
  }
}

export async function withUpperHalfOrigin<T>(statsId: string, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(nodeCrypto, "randomBytes")!;
  const real = descriptor.value as (size: number, callback?: unknown) => unknown;
  let counter = 0;
  const draw = (size: number, callback?: unknown) => {
    if (size !== 32 || callback !== undefined) return Reflect.apply(real, nodeCrypto, callback === undefined ? [size] : [size, callback]);
    const drawn = upperHalfNonce(statsId, counter);
    counter = drawn.next;
    return drawn.nonce;
  };
  Object.defineProperty(nodeCrypto, "randomBytes", { ...descriptor, value: draw });
  try {
    return await run();
  } finally {
    Object.defineProperty(nodeCrypto, "randomBytes", descriptor);
    assert.deepEqual(Object.getOwnPropertyDescriptor(nodeCrypto, "randomBytes"), descriptor);
  }
}
