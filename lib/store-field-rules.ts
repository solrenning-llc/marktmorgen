/** Shared pure rules. No server operations or private configuration. */
import type { Product } from "./catalog";
import { HANDLE_PATTERN } from "./store-handle-pattern";
export type { Product } from "./catalog";
export { MAX_PRODUCTS, MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH } from "./catalog-rules";
export const MAX_NAME_LENGTH = 60;

export const MAX_BIO_LENGTH = 160;

export const MAX_ADDRESSES = 10;

export function isFree(product: Pick<Product, "priceCents">): boolean {
  return product.priceCents === 0;
}

export type StoreJoin = { on: boolean; heading: string; line: string };

/**
 * The sign-up box (lib/store-join.ts): StoreJoin, plus up to MAX_RECOMMEND other stores the creator recommends on
 * the page a new subscriber lands on after confirming (119 [F2-FREE-RECOMMENDATIONS]): store addresses only,
 * checked to be real stores when saved (lib/join-recommend.ts) and again when shown. The contact box has none.
 */
export type StoreJoinBox = StoreJoin & { recommend: string[] };

/** How many other stores a creator may recommend after a sign-up. */
export const MAX_RECOMMEND = 3;


/** The picks tidied: lowercase, without a leading @, store addresses only, no repeats, at most MAX_RECOMMEND. */
function parseRecommend(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const handle = item.trim().replace(/^@+/, "").toLowerCase();
    if (!HANDLE_PATTERN.test(handle) || out.includes(handle)) continue;
    out.push(handle);
    if (out.length === MAX_RECOMMEND) break;
  }
  return out;
}

export const MAX_JOIN_HEADING = 60;

export const MAX_JOIN_LINE = 200;

export function parseJoin(raw: unknown): StoreJoin {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const line = (text: unknown, max: number) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, max) : "");
  return { on: value.on === true, heading: line(value.heading, MAX_JOIN_HEADING), line: line(value.line, MAX_JOIN_LINE) };
}

/** The sign-up box's settings: parseJoin's, and the stores it recommends after a sign-up. */
export function parseJoinBox(raw: unknown): StoreJoinBox {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { ...parseJoin(raw), recommend: parseRecommend(value.recommend) };
}
