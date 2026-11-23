import type { Store } from "@/lib/store";

/**
 * tests/tier-benefits-count-unknown.test.ts: the store's studio count as the test sets it, in place of
 * lib/studio-route.ts, and the route's guard in place of lib/store-request.ts, with the test's store.
 */
type Counted = { ok: true } | { ok: false; reason: "used" | "unknown" | "pool" | "daily"; message: string };
export const world: { counted: Counted | "throw"; store: Store | null; asked: number } = { counted: { ok: true }, store: null, asked: 0 };

export async function countStudio(): Promise<Counted> {
  world.asked += 1;
  if (world.counted === "throw") throw new Error("the count could not be read (synthetic)");
  return world.counted;
}

export async function guardStoreWrite(request: Request) {
  if (!world.store) throw new Error("no store set");
  return { ok: true as const, store: world.store, email: "benefits@example.com", body: (await request.json()) as Record<string, unknown> };
}
