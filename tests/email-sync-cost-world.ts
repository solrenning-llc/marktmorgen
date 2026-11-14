/**
 * lib/safe-fetch.ts for tests/email-sync-cost.test.ts: everything real but safeFetch, which answers as a synthetic
 * email platform (Kit) and counts each call; nothing leaves the process. `platform.fail` makes every call answer 503
 * (a retryable server error); otherwise a tag list is empty, so every tag is made, and every write succeeds.
 */
export * from "../lib/safe-fetch";
import type { SafeFetchOptions, SafeResponse } from "../lib/safe-fetch";

export const platform = { fail: false, calls: 0 };

export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeResponse> {
  platform.calls += 1;
  const answer = (status: number, json: unknown): SafeResponse => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(json)), url: raw });
  if (platform.fail) return answer(503, { error: "synthetic outage" });
  const path = new URL(raw).pathname;
  if (options.method === "GET" && path.endsWith("/tags")) return answer(200, { tags: [] });
  if (options.method === "POST" && path.endsWith("/tags")) return answer(201, { tag: { id: 1000 + platform.calls } });
  if (options.method === "POST" && path.endsWith("/subscribers") && !path.includes("/forms/") && !path.includes("/tags/")) return answer(201, { subscriber: { id: 42 } });
  return answer(201, {});
}
