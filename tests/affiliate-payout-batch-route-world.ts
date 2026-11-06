import type { Store } from "@/lib/store";
/** The signed-in creator of tests/affiliate-payout-batch-route.test.ts; everything else is the real lib/studio-route.ts. */
export * from "../lib/studio-route";
export const who: { store: Store | null } = { store: null };
export async function creatorFrom() {
  return { email: who.store!.email, ref: who.store!.email, store: who.store!, role: "owner" as const, origin: "https://local.example", studio: (query = "") => `/studio?${query}` };
}
