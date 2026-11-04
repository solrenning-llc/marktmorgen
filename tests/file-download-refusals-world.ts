/**
 * lib/studio-route.ts for tests/file-download-refusals.test.ts: answers the
 * studio's check with the refusal the test sets, so every reason a request
 * can be turned away for reaches the download route.
 */
export type Refusal = "signed_out" | "no_store" | "forbidden" | "gone" | "locked" | "used" | "two_step";
export const refusal: { reason: Refusal; message?: string } = { reason: "signed_out" };
export async function studioAccess(): Promise<{ ok: false; reason: Refusal; message?: string }> {
  return { ok: false, reason: refusal.reason, message: refusal.message };
}
