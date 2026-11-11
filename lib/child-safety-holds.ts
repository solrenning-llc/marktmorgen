/**
 * The preservation hold's mark and its readers (lib/child-safety.ts,
 * C1-20261109-1546-TODOS-70), kept apart from the report's own code so the
 * catalog and the bundle readers can read it without importing the store.
 *
 *   nl:csa:keep:<store>:<product>      "1"      preservation hold, 400 days
 *
 * A product kept for a child-safety report is never handed over through
 * another product (Claude 6's focal review of #3471): a bundle that holds it
 * is not offered or sold, and a checkout box whose product is it, or a bundle
 * holding it, is not shown or charged. Every reader here takes a reply that
 * cannot be read as a refusal, never as "not held" (rule 24).
 */
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";

const storeTag = (store: Pick<Store, "statsId" | "handle">) => store.statsId || `h:${store.handle}`;
/** The key of a product's preservation hold. */
export const keepKey = (store: Pick<Store, "statsId" | "handle">, productId: string) => `nl:csa:keep:${storeTag(store)}:${productId}`;

/** Whether the product is kept for a report; a reply that cannot be read throws, so the caller refuses. */
export async function isHeldForReport(store: Pick<Store, "statsId" | "handle">, productId: string): Promise<boolean> {
  return (await heldIdsAmong(store, [productId])).size > 0;
}

/**
 * Which of these product ids are kept for a report, in one read. Throws when
 * any reply is not Redis's null or the mark's "1", or when the replies are not
 * one per id: the caller refuses rather than reading "not held".
 */
export async function heldIdsAmong(store: Pick<Store, "statsId" | "handle">, ids: readonly string[]): Promise<Set<string>> {
  const asked = [...new Set(ids)];
  const held = new Set<string>();
  if (asked.length === 0) return held;
  const replies = repliesFor(await redisPipeline(asked.map((id) => ["GET", keepKey(store, id)])), asked.length);
  if (!replies) throw new Error("A preservation hold could not be read");
  replies.forEach((value, i) => {
    if (value === "1") held.add(asked[i]);
    else if (value !== null) throw new Error("A preservation hold could not be read");
  });
  return held;
}

/** How many marks one read asks for: a whole catalog (MAX_PRODUCTS, 2,000) in two MGETs. */
const MARKS_PER_READ = 1_000;

/**
 * Which of a store's products are kept for a report, for a reader that must
 * look at the whole catalog (the picture description, heldPictureRefusal in
 * lib/child-safety.ts): one MGET per MARKS_PER_READ ids, so a large catalog
 * costs two commands, not one per product. Throws, as heldIdsAmong does, when
 * a reply is not one list holding Redis's null or the mark's "1" per id.
 */
export async function heldInCatalog(store: Pick<Store, "statsId" | "handle">, ids: readonly string[]): Promise<Set<string>> {
  const asked = [...new Set(ids)];
  const held = new Set<string>();
  if (asked.length === 0) return held;
  const lots: string[][] = [];
  for (let at = 0; at < asked.length; at += MARKS_PER_READ) lots.push(asked.slice(at, at + MARKS_PER_READ));
  const replies = repliesFor(await redisPipeline(lots.map((lot) => ["MGET", ...lot.map((id) => keepKey(store, id))])), lots.length);
  if (!replies) throw new Error("A preservation hold could not be read");
  lots.forEach((lot, n) => {
    const values = replies[n];
    if (!Array.isArray(values) || values.length !== lot.length) throw new Error("A preservation hold could not be read");
    values.forEach((value, i) => {
      if (value === "1") held.add(lot[i]);
      else if (value !== null) throw new Error("A preservation hold could not be read");
    });
  });
  return held;
}

/**
 * Which of the products a public page is about to list are kept for a report
 * (Revisor 2 on #3588: a product whose taking off the store did not go through
 * after its mark was written is otherwise still listed), in one command
 * (heldInCatalog's MGET: up to MARKS_PER_READ ids), for a page, which must not
 * fail for it: a mark that cannot be read counts every id asked as held, so
 * nothing that may be held is shown.
 */
export async function heldAmongShown(store: Pick<Store, "statsId" | "handle">, ids: readonly string[]): Promise<Set<string>> {
  try {
    return await heldInCatalog(store, ids);
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return new Set(ids);
  }
}

/**
 * heldIdsAmong for a page, which must not fail for it: a hold that cannot be
 * read counts every id asked as held, so nothing that may be held is shown.
 */
export async function heldOrUnreadable(store: Pick<Store, "statsId" | "handle">, ids: readonly string[]): Promise<Set<string>> {
  try {
    return await heldIdsAmong(store, ids);
  } catch (error) {
    console.error("a preservation hold could not be read", error instanceof Error ? error.message : "unknown");
    return new Set(ids);
  }
}

/** Whether a product, or any product of its bundle, is in `held`. */
export function touchesHeld(product: Pick<Listing, "id" | "bundle">, held: ReadonlySet<string>): boolean {
  return held.has(product.id) || (product.bundle ?? []).some((id) => held.has(id));
}

/**
 * The listings a checkout box may offer, from those read for it: neither a
 * product kept for a report nor a bundle holding one. A held product is always
 * off the store (hidden), so only a hidden one and a bundle's products are
 * read, and a page whose boxes offer neither reads nothing more. A hold that
 * cannot be read leaves out what it was read for.
 */
export async function offerableTargets(store: Pick<Store, "statsId" | "handle">, targets: Listing[]): Promise<Listing[]> {
  const asked = targets.flatMap((target) => [...(target.hidden ? [target.id] : []), ...(target.bundle ?? [])]);
  if (asked.length === 0) return targets;
  const held = await heldOrUnreadable(store, asked);
  return held.size ? targets.filter((target) => !touchesHeld(target, held)) : targets;
}
