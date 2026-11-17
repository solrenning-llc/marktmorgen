import type { Store } from "@/lib/store";

export const spendStore = { statsId: "7".repeat(32), currency: "usd", email: "owner@example.com" } as Store;

/** Exercise the real spend POST after its existing authorization barrier. */
export async function guardStoreWrite(request: Request) {
  return { ok: true as const, store: spendStore, body: (await request.json()) as Record<string, unknown> };
}
