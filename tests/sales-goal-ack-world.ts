import type { Store } from "@/lib/store";

export const goalStore = { statsId: "6".repeat(32), currency: "usd", email: "owner@example.com" } as Store;

/** Exercise the real goal POST after its existing authorization barrier. */
export async function guardStoreWrite(request: Request) {
  return { ok: true as const, store: goalStore, body: await request.json() as Record<string, unknown> };
}
