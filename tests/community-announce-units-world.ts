/**
 * lib/buyer-actions.ts as tests/community-announce-studio-units.test.ts sees it: every take is recorded with who takes
 * it and how many units, and, once `refuse` is on, refused, so the community route answers "resting" right after its
 * charge and nothing else of the post is done. Synthetic only.
 */
import type { Store } from "@/lib/store";

export const PICTURE_REQUEST_UNITS = 4;
export const taken: { by: "buyer" | "owner"; units: number }[] = [];
export let refuse = false;
export const setRefuse = (on: boolean) => { refuse = on; };

export async function takeBuyerAction(_store: Store, by: "buyer" | "owner" = "buyer", units = 1): Promise<boolean> {
  taken.push({ by, units });
  return !refuse;
}
export async function takeBuyerRead(): Promise<boolean> {
  return true;
}
export async function takeBuyerReadExact(): Promise<boolean> {
  return true;
}
export function restingAway(origin: string, store: Pick<Store, "handle">): Response {
  return new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/resting`, "Cache-Control": "no-store" } });
}
export function restingJson(): Response {
  return Response.json({ ok: false, error: "resting" }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
