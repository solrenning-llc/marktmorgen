/** Admission-only seam; all other upload seams use upload-route-world. */
import type { Refusal } from "../lib/studio-route";
export type { Refusal };

export const admission: { reason: Refusal; calls: number; needs: unknown[] } = { reason: "signed_out", calls: 0, needs: [] };

export async function studioAccess(_request: unknown, need: unknown): Promise<{ ok: false; reason: Refusal; message: string }> {
  admission.calls += 1;
  admission.needs.push(need);
  return { ok: false, reason: admission.reason, message: "Synthetic admission refusal" };
}
