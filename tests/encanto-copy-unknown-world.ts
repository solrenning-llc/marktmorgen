/**
 * The in-memory file store of tests/failure-cleanup-world.ts, with a passing outage that a test can put on one file:
 * its head throws, its read throws, or its read answers without the file (a status that is neither 200 nor 404).
 * Each outage is passing: it fails the next such call on that file once, and the store answers again after it, so a
 * clean-up that asks again finds the file there. Used by tests/encanto-copy-unknown.test.ts.
 */
import * as world from "./failure-cleanup-world";

export { del, deleted, files, handleUploadPresigned, issueSignedToken, list, presignUrl, put } from "./failure-cleanup-world";

/** The file, and how the file store fails on it, once. */
export const failing = new Map<string, "head" | "get" | "get-status">();

export async function head(pathname: string) {
  if (failing.get(pathname) === "head" && failing.delete(pathname)) throw new Error("Vercel Blob: 503 Service Unavailable (synthetic passing outage)");
  return world.head(pathname);
}

export async function get(pathname: string) {
  const how = failing.get(pathname);
  if (how === "get" || how === "get-status") failing.delete(pathname);
  if (how === "get") throw new Error("Vercel Blob: Failed to fetch blob: 503 Service Unavailable (synthetic passing outage)");
  if (how === "get-status") return { statusCode: 503, stream: null, blob: await world.head(pathname) };
  return world.get(pathname);
}
