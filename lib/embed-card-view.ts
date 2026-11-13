/**
 * The pasted card's cached copy (DONO-20261113-DEC-2, 13 November 2026).
 *
 * The card a creator pastes into their own site (/embed/<store>/<product>,
 * lib/embed-rules.ts) is drawn on every page of that site that holds it,
 * whether or not anyone looks. Each display used to run the card page as a
 * function and read the store, the product, its stock and the rest from the
 * database, with no limit. Now proxy.ts sends a display to a copy kept by
 * the CDN (app/embed/[handle]/[product]/card/[view]/page.tsx), made again at
 * most once a CARD_FRESH_SECONDS window for each address, and each store's
 * copies are made at most CARD_BUILDS_PER_WINDOW times in a window, counted
 * before anything is read. A display reads nothing from the database.
 *
 * The copy is the same for every visitor of one address, so what the card
 * page read from the request is put in the address instead, before the copy
 * is looked up: the place the code was pasted (its utm_source, as
 * lib/embed-rules.ts keeps it) and the site it is shown on (the origin of the
 * Referer, which decides whether a store that listed its sites sells from it).
 * The visitor's country is not: a copy is drawn for no country, so it shows no
 * fair price (lib/fair-price.ts); the product's page and the checkout do.
 *
 * Nothing in a copy decides a sale: stock, whether it can be bought, the
 * price and how many are left are read again when the buyer presses the
 * button (app/api/store/checkout), which says plainly when it is sold out.
 * So a copy never says how many are left, which could be out of date.
 *
 * Edge-safe and pure: the proxy builds the address with it, and the copy's
 * page reads it back.
 */
import { SITE_URL } from "./site-url";
import { embedPlace } from "./embed-rules";
import { scriptMode } from "./embed-sites";

/**
 * How long a copy is served before it is made again (its s-maxage). Kept in
 * step with `revalidate` in the copy's page, which Next needs as a literal
 * (tests/embed-card-cached.test.ts holds the two together).
 */
export const CARD_FRESH_SECONDS = 300;

/**
 * How many copies one store's cards may be made in a CARD_FRESH_SECONDS
 * window, all its products, places and sites together, counted before the
 * store is read: past it a copy is drawn as a plain link to the product's
 * page, reading nothing, for that window. Room for six cards a store shown
 * at once, each made again once a window, which bounds the store's month
 * (tests/plan-cost-registry.ts, line embed: about $9.29 at every copy's
 * largest; twelve would be $18.58).
 */
export const CARD_BUILDS_PER_WINDOW = 6;

/** The site part of a copy's address when the display had no Referer this site can read. */
const NO_SITE = "-";
/** The longest origin kept in an address; a longer one is taken for none. */
const MAX_ORIGIN = 255;

/** The origin of a Referer, lower case, or null when there is none or it is not a web address. */
export function refererOrigin(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    const origin = new URL(referer).origin.toLowerCase();
    return /^https?:\/\//.test(origin) && origin.length <= MAX_ORIGIN ? origin : null;
  } catch {
    return null;
  }
}

const toBase64Url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
}

/** The last segment of a copy's address: the place and the site, which every visitor of that address shares. */
export function cardView(source: string | null | undefined, referer: string | null | undefined): string {
  const origin = refererOrigin(referer);
  return `${embedPlace(source ?? "")}~${origin ? toBase64Url(origin) : NO_SITE}`;
}

/** A copy's address read back; anything it does not recognize is the default place and no site. */
export function readCardView(raw: string): { place: string; site: string | null } {
  let view = raw;
  try {
    view = decodeURIComponent(raw);
  } catch {
    // Kept as it came: it is checked below like any other.
  }
  const at = view.indexOf("~");
  const place = embedPlace(at < 0 ? view : view.slice(0, at));
  const decoded = at < 0 ? null : fromBase64Url(view.slice(at + 1));
  const site = decoded !== null && refererOrigin(decoded) === decoded ? decoded : null;
  return { place, site };
}

/**
 * Where proxy.ts sends a display of a card: its copy's address, for a card
 * pasted with the frame code (no ?mm= the checkout script would put on it);
 * null for anything else, which the proxy leaves where it is.
 */
export function cardCopyPath(pathname: string, params: URLSearchParams, referer: string | null): string | null {
  const match = pathname.match(/^\/embed\/([^/]+)\/([^/]+)\/?$/);
  if (!match || match[2] === "join") return null;
  if (scriptMode(params.get("mm"))) return null;
  return `/embed/${match[1]}/${match[2]}/card/${encodeURIComponent(cardView(params.get("utm_source"), referer))}`;
}

/** Whether a path is a copy's own address (so the proxy gives it the copy's policy if asked for directly). */
export function isCardCopyPage(pathname: string): boolean {
  return /^\/embed\/[^/]+\/[^/]+\/card\/[^/]+\/?$/.test(pathname);
}

/**
 * Whether a card pasted with the frame code may sell on the site it is on:
 * anywhere until the creator lists sites, then those, and this site's own
 * pages (the studio's preview). A display with no site it can read buys
 * nothing once there is a list.
 */
export function siteMaySell(embedSites: readonly string[], origin: string | null): boolean {
  if (!embedSites.length) return true;
  if (!origin) return false;
  return origin === new URL(SITE_URL).origin.toLowerCase() || embedSites.includes(origin);
}
