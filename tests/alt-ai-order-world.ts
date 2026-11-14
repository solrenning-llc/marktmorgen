/**
 * The file store for tests/alt-ai-order.test.ts: the in-memory store of tests/failure-cleanup-world.ts, with every
 * paid read (`get`, `head`) counted, so the test can say how many Blob operations a request spent.
 */
import { get as storedGet, head as storedHead } from "./failure-cleanup-world";

export * from "./failure-cleanup-world";

/** The paid reads made, in order, by name of the call. */
export const reads: string[] = [];
/** When true, a read fails as a store that did not answer would. */
export const failing = { on: false };

export async function head(pathname: string) {
  reads.push(`head ${pathname}`);
  if (failing.on) throw new Error("store down");
  return storedHead(pathname);
}

export async function get(pathname: string) {
  reads.push(`get ${pathname}`);
  if (failing.on) throw new Error("store down");
  return storedGet(pathname);
}
