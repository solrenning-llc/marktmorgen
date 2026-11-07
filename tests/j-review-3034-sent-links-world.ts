import type { Store } from "@/lib/store";
import { StoreFullError } from "@/lib/store-full";
import { ROOM } from "./data-room";

export { StoreFullError };
/** Only the fields consumed by changeLink/needData are supplied; no store/session read is under review here. */
export const storeFixture = { ...ROOM, handle: "harbor", listId: "list-review-3034", statsId: "stats-review-3034", domain: "" } as unknown as Store;
export const emailFixture = { id: "a".repeat(24), listId: storeFixture.listId!, handle: storeFixture.handle, body: "https://example.com/original", sent: 1, links: true as const };
export const readBroadcast = async (id: string) => id === emailFixture.id ? emailFixture : null;
export const text = (raw: unknown, max: number) => typeof raw === "string" ? raw.slice(0, max) : "";
/** Authorization is a fixed fixture: this review tests the post-authorization write/error path only. */
export async function guardStoreWrite(request: Request, need: string, max: number) {
  if (need !== "send" || max !== 4_000) throw new Error("unexpected authorization contract");
  return { ok: true as const, store: storeFixture, body: await request.json() };
}
