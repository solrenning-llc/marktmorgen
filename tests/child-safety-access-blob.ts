/**
 * The file store as tests/child-safety-access.test.ts sees it: the real one
 * (lib/blob.ts, with no token here, so every read fails at once), with each
 * path `get` was asked for written down, so the test can say a picture of a
 * held product was never read for the AI. Declared in
 * tests/aliases/child-safety-access.test.ts.json.
 */
import * as real from "../lib/blob";

export * from "../lib/blob";

/** Every path read through `get`, in order. */
export const reads: string[] = [];

export function get(...args: Parameters<typeof real.get>): ReturnType<typeof real.get> {
  reads.push(args[0]);
  return real.get(...args);
}
