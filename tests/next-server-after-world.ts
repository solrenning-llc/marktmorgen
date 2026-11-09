/**
 * "next/server" for a test that calls a route's POST outside a real request
 * (tests/digital-consent.test.ts): the real NextRequest and NextResponse, and
 * an `after` that holds the work a route leaves for after its answer instead
 * of running it, since there is no request scope here to run it in. The
 * answer the route gives, which is what the test reads, is unchanged.
 */
export { NextRequest } from "next/dist/server/web/spec-extension/request";
export { NextResponse } from "next/dist/server/web/spec-extension/response";
export { userAgent, userAgentFromString } from "next/dist/server/web/spec-extension/user-agent";

/** What the routes handed to after(), held and never run. */
export const afterTasks: unknown[] = [];

export function after(task: unknown): void {
  afterTasks.push(task);
}

export function connection(): Promise<void> {
  return Promise.resolve();
}

/**
 * Runs what was handed to after(), in order, as Next does once each answer is
 * sent (lib/after-answer.ts); what a task leaves for after itself runs too.
 */
export async function runAfterTasks(): Promise<number> {
  let ran = 0;
  while (afterTasks.length) {
    await (afterTasks.shift() as () => unknown)();
    ran += 1;
  }
  return ran;
}
