/**
 * The rules of short links for posts (lib/short-links.ts keeps them): what a
 * link's name, place and destination may be, and where it sends the person.
 * Pure, so the studio's page and the server read them the same way.
 */
import { POST_PLACES } from "@/lib/share-links";
import { SITE_URL } from "@/lib/site-url";
import { readCartIds } from "@/lib/cart-rules";
import { readLinkCode } from "@/lib/code-link";

/** The letters a code is made of: none of 0, o, 1, l or i, which are misread from a slide or a flyer. */
export const CODE_LETTERS = "abcdefghjkmnpqrstuvwxyz23456789";
export const CODE = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/;
export const MAX_LINKS = 100;
/** A post's name as the numbers count a utm_campaign (lib/source-rules.ts, cleanTag): thirty characters. */
export const MAX_NAME = 30;
/** How long the CDN keeps a link's answer. */
export const CACHE_SECONDS = 300;

/**
 * Where a link goes: the store, one product's page, or the store with a
 * ready cart (624 [SZ8](23)): two to MAX_CART products and, if chosen, one of
 * the creator's discount codes (lib/code-link.ts), applied at checkout only if
 * it is live.
 */
export type LinkTarget = { kind: "store" } | { kind: "product"; id: string } | { kind: "cart"; ids: string[]; code?: string };

export type ShortLink = {
  code: string;
  /** The post's name, its utm_campaign: "october-reel". */
  name: string;
  /** Where it was posted, its utm_source: "instagram". */
  place: string;
  target: LinkTarget;
  made: number;
  /**
   * 510 [CK2] unit 1: from `at` (milliseconds) on, the link opens `target`
   * here instead of its own: the sale page until the sale ends, the store
   * after. Absent is never.
   */
  then?: LinkThen;
};

/** Where a link goes from a date on: the store or one of its own products, never a cart and never an error page. */
export type LinkThen = { at: number; target: { kind: "store" } | { kind: "product"; id: string } };

/**
 * The soonest a change may be set: ten minutes from now. An answer the CDN
 * kept before the date was set lives five minutes fresh and a minute stale at
 * most (CACHE_SECONDS, STALE_SECONDS), so it has run out before the soonest
 * date: nobody is sent to the old page after the date because of it.
 */
export const MIN_THEN_MS = 10 * 60_000;
/** The latest: two years from now. */
export const MAX_THEN_MS = 731 * 86_400_000;
/** How long the CDN may serve a kept answer while it fetches a fresh one. */
const STALE_SECONDS = 60;

/** The short address of a link. */
export const shortUrl = (code: string) => `${SITE_URL}/l/${code}`;

/** A post's name as it is counted, or empty. Pure. */
export function linkName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/-+$/, "");
}

/** Where it was posted, from the places offered; "other" for anything else. Pure. */
export function linkPlace(raw: unknown): string {
  return typeof raw === "string" && POST_PLACES.some((p) => p.place === raw) ? raw : "other";
}

/** Where a link goes, made whole, or null. `isProduct` says whether the store has that product. Pure. */
export function readTarget(raw: unknown, isProduct: (id: string) => boolean): LinkTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (v.kind === "store") return { kind: "store" };
  if (v.kind === "product" && typeof v.id === "string" && v.id.length <= 64 && isProduct(v.id)) return { kind: "product", id: v.id };
  if (v.kind === "cart" && Array.isArray(v.ids)) {
    const ids = readCartIds(v.ids);
    if (ids.length < 2 || ids.length !== v.ids.length || !ids.every(isProduct)) return null;
    const typed = typeof v.code === "string" ? v.code.trim().toUpperCase() : "";
    const code = readLinkCode(typed);
    if (typed && !code) return null;
    return code ? { kind: "cart", ids, code } : { kind: "cart", ids };
  }
  return null;
}

/**
 * Where a link sends the person: the store's address (its own domain when it
 * has one) and the page, tagged with where it was posted and the post's name.
 * Pure.
 */
export function landingUrl(base: string, link: Pick<ShortLink, "name" | "place" | "target">): string {
  const page = link.target.kind === "product" ? `${base}/p/${encodeURIComponent(link.target.id)}` : base;
  const params = new URLSearchParams({ utm_source: link.place, utm_medium: "post", utm_campaign: link.name });
  // A ready cart: the store page puts these in the cart (restore) and the code is remembered for the checkout.
  if (link.target.kind === "cart") {
    params.set("restore", link.target.ids.join(","));
    if (link.target.code) params.set("code", link.target.code);
  }
  return `${page}?${params.toString()}`;
}

/** The page part of a target a date may change to: the store or a product, or null. Pure. */
function plainTarget(raw: unknown, isProduct: (id: string) => boolean): LinkThen["target"] | null {
  const target = readTarget(raw, isProduct);
  return target && target.kind !== "cart" ? target : null;
}

/**
 * A change on a date as the studio sends it, `{ at, target }`, made whole, or
 * null: `at` a whole number of milliseconds from MIN_THEN_MS to MAX_THEN_MS
 * after `now`, the target the store or one of its products. Pure.
 */
export function readThen(raw: unknown, isProduct: (id: string) => boolean, now: number): LinkThen | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const at = v.at;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < now + MIN_THEN_MS || at > now + MAX_THEN_MS) return null;
  const target = plainTarget(v.target, isProduct);
  return target ? { at, target } : null;
}

/** A change as it was kept: any whole positive time, since it was checked when saved; null when it cannot be read. Pure. */
export function keptThen(raw: unknown): LinkThen | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at <= 0) return null;
  const target = plainTarget(v.target, () => true);
  return target ? { at: v.at, target } : null;
}

/**
 * A link as it stands at `now` once its date has passed: the page it opens
 * from then made its own, the date spent. Before the date, as it is. Pure.
 */
export function settledAt<T extends Pick<ShortLink, "target" | "then">>(link: T, now: number): T {
  if (!link.then || now < link.then.at) return link;
  const settled: T = { ...link, target: link.then.target };
  delete settled.then;
  return settled;
}

/** Where a link goes at `now`: its own page, or from its date on the other one. Pure. */
export function targetNow(link: Pick<ShortLink, "target" | "then">, now: number): LinkTarget {
  return link.then && now >= link.then.at ? link.then.target : link.target;
}

/**
 * The Cache-Control of a link's answer at `now`. Five minutes and a minute
 * stale, as always, unless the link changes sooner: then the CDN keeps it,
 * stale part included, only until a second before the change, the second
 * being the time the answer takes from this clock to the CDN. An answer kept
 * before the date was set runs out before the soonest date (MIN_THEN_MS). Pure.
 */
export function linkCache(link: Pick<ShortLink, "then"> | null, now: number): string {
  const left = link?.then && link.then.at > now ? Math.max(0, Math.floor((link.then.at - now) / 1000) - 1) : Infinity;
  const fresh = Math.min(CACHE_SECONDS, left);
  const stale = Math.min(STALE_SECONDS, Math.max(0, left - fresh));
  return `public, max-age=0, s-maxage=${fresh}${stale > 0 ? `, stale-while-revalidate=${stale}` : ""}`;
}

/**
 * What the studio's panel saw of a link when a change was asked: the date it
 * showed (null for none), whether that date had passed on its clock, and the
 * page it showed the date going to (null with no date). The
 * server compares it with its own view before writing, so a panel left open
 * past the date, or on a clock running ahead, never has a change applied to a
 * link other than the one it showed (lib/short-links.ts, sameView).
 */
export type Seen = { at: number | null; passed: boolean; to: LinkThen["target"] | null };

/** What the panel saw, as a request sends it, or null when it is not that shape: a date always with its page, none without. Pure. */
export function readSeen(raw: unknown): Seen | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.passed !== "boolean") return null;
  if (v.at === null) return v.to === null ? { at: null, passed: v.passed, to: null } : null;
  if (typeof v.at !== "number" || !Number.isSafeInteger(v.at)) return null;
  const to = plainTarget(v.to, () => true);
  return to ? { at: v.at, passed: v.passed, to } : null;
}

/** What a panel at `now` sees of a link: what it sends with each change. Pure. */
export function seenAt(link: Pick<ShortLink, "then">, now: number): Seen {
  return link.then ? { at: link.then.at, passed: now >= link.then.at, to: link.then.target } : { at: null, passed: false, to: null };
}

const samePage = (a: LinkTarget, b: LinkTarget) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the studio's date form still fits a link after a change was refused
 * because the link changed (`fresh`, as the answer shows it, undefined when it
 * is gone): no date of its own still to come, and the page chosen in the form
 * is not the one it opens at `now`. When it fits, the form stays open with what
 * was typed (3.3.7); when not, it closes and the reason is said beside the link. Pure.
 */
export function dateFormFits(fresh: Pick<ShortLink, "target" | "then"> | undefined, chosen: LinkThen["target"], now: number): boolean {
  if (!fresh) return false;
  if (fresh.then && now < fresh.then.at) return false;
  return !samePage(targetNow(fresh, now), chosen);
}

/** The links whose date the panel's clock passed going from `from` to `to`: said to the creator when they come. Pure. */
export function datesReached<T extends Pick<ShortLink, "then">>(links: T[], from: number, to: number): T[] {
  return links.filter((l) => l.then && from < l.then.at && l.then.at <= to);
}

/**
 * Whether a change of where a link goes took back its date (`before` as the
 * panel showed it at `now`, `after` as the answer has it): the page chosen was
 * the one the date would send it to (lib/short-links.ts, retarget). Pure.
 */
export function dateCanceledBy(before: Pick<ShortLink, "then">, after: Pick<ShortLink, "then"> | undefined, now: number): boolean {
  return Boolean(before.then && now < before.then.at && after && !after.then);
}
