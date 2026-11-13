import type { Store } from "@/lib/store";
/**
 * The signed-in creator of tests/payout-batch-confirm-exact.test.ts, for both halves of the payout batch route:
 * creatorFrom (GET, the file) and guardStoreWrite (POST, "I have paid this batch"). Everything else is the real
 * lib/studio-route.ts and lib/store-request.ts.
 */
export * from "../lib/studio-route";
export * from "../lib/store-request";
export const who: { store: Store | null; body: Record<string, unknown> } = { store: null, body: {} };
export async function creatorFrom() {
  return { email: who.store!.email, ref: who.store!.email, store: who.store!, role: "owner" as const, origin: "https://local.example", studio: (query = "") => `/studio?${query}` };
}
export async function guardStoreWrite() {
  return { ok: true as const, email: who.store!.email, ref: who.store!.email, store: who.store!, role: "owner" as const, body: who.body };
}
