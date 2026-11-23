/**
 * Synthetic transport for tests/email-sync-config-erasure.test.ts: no DNS, socket, provider account or real key. Each
 * request runs `during` first, which is how the test erases the store while the provider is answering.
 */
import type { SafeResponse } from "../lib/safe-fetch";
// The rest of lib/safe-fetch as it is (the route imports checkUrl and problemWords); safeFetch below takes its place.
export * from "../lib/safe-fetch";

let replies: string[] = [];
let during: (() => Promise<void>) | null = null;

/** The bodies the next requests get, in order; `hook` runs before the request at `at` (0-based) answers. */
export function answerWith(bodies: string[], at = -1, hook: (() => Promise<void>) | null = null): void {
  replies = [...bodies];
  hookAt = at;
  during = hook;
  seen = 0;
}
let hookAt = -1;
let seen = 0;

export async function safeFetch(url: string): Promise<SafeResponse> {
  if (seen === hookAt && during) await during();
  seen += 1;
  const body = replies.shift();
  if (body === undefined) throw new Error("Unexpected synthetic platform request");
  return { status: 200, headers: {}, body: Buffer.from(body), url };
}
