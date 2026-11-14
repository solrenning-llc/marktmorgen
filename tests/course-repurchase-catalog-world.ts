// Synthetic world: the real lib/catalog, with the course listings read from a fixed list (no store data is read).
export * from "../lib/catalog";
import type { Listing, Store } from "../lib/store";

export const catalog: { listings: Listing[] } = { listings: [] };

export async function readListing(_store: Store, id: string | null | undefined): Promise<Listing | null> {
  return catalog.listings.find((l) => l.id === id) ?? null;
}
export async function readKind(_store: Store, kind: string): Promise<Listing[]> {
  return kind === "course" ? catalog.listings.filter((l) => l.course) : [];
}
export function idsOfKind(_store: Store, kind: string): string[] {
  return kind === "course" ? catalog.listings.filter((l) => l.course).map((l) => l.id) : [];
}
