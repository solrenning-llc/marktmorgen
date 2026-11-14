/**
 * "next/server" for tests/erasure-request-timing.test.ts: `after` runs the
 * task at once and unwaited, as lib/erasure-request.ts does when there is no
 * request scope, and keeps its promise, so the test can wait for every task
 * the answer left behind to end, instead of waiting a fixed time.
 *
 * It never throws, unlike the real after() outside a request scope, so the
 * `catch { void run() }` fallback in lib/erasure-request.ts is not exercised
 * through it: tests/buyer-library-known-exact.test.ts covers that with the real
 * next/server and fails if the try/catch goes. Do not move that test to a
 * stand-in like this one.
 */
export { NextRequest } from "next/dist/server/web/spec-extension/request";
export { NextResponse } from "next/dist/server/web/spec-extension/response";

/** Every task handed to after(), already running. */
export const afterRuns: Promise<unknown>[] = [];

export function after(task: () => unknown): void {
  let run: Promise<unknown>;
  try {
    run = Promise.resolve(task());
  } catch (error) {
    run = Promise.reject(error);
  }
  afterRuns.push(run);
}

export function connection(): Promise<void> {
  return Promise.resolve();
}
