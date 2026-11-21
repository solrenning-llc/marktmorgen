/**
 * lib/blob for tests/c1-cost-product-card.test.ts: the in-memory file store of tests/failure-cleanup-world.ts, with
 * every read of a file counted, so the test sees whether a product's shared-link card read its picture.
 */
import { get as read } from "./failure-cleanup-world";

export * from "./failure-cleanup-world";

/** Every path read with get, in order. */
export const reads: string[] = [];

export async function get(pathname: string) {
  reads.push(pathname);
  return read(pathname);
}
