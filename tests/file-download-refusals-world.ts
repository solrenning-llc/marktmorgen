/**
 * lib/studio-route.ts for tests/file-download-refusals.test.ts: answers the
 * studio's check with the refusal the test sets, so every reason a request
 * can be turned away for reaches the download route.
 */
// The real type, by path: "@/lib/studio-route" is this file in the test, so a copy would not see a refusal added there.
import type { Refusal } from "../lib/studio-route";
export type { Refusal };
export const refusal: { reason: Refusal; message?: string } = { reason: "signed_out" };
export async function studioAccess(): Promise<{ ok: false; reason: Refusal; message?: string }> {
  return { ok: false, reason: refusal.reason, message: refusal.message };
}
