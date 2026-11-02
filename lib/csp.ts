/**
 * What a page of ours may load, run and send, as a Content-Security-Policy.
 *
 * Two policies, because the site is served two ways:
 *
 *   - The pages that are rendered for each visit — every store page, on
 *     marktmorgen.com and on a creator's own domain, the studio, signing in
 *     and unsubscribing — get a fresh random nonce per response (proxy.ts)
 *     and run only the scripts that carry it, plus what those scripts load
 *     themselves ('strict-dynamic'). That is the strict kind: text a creator
 *     or a buyer typed can never become a script on these pages, whatever
 *     slips through the escaping, because it would not carry the nonce. The
 *     creator's own ad pixels are started by our code, so they load under the
 *     same rule, and only the addresses those four platforms send their
 *     measurements to are added to what a page may connect to. The three
 *     video players a product's page may show (lib/sales-page.ts) are the
 *     only other addresses such a page may put in a frame, and only their
 *     embed hosts — YouTube's privacy-enhanced one, Vimeo's player and
 *     Loom's embed — never the sites themselves. A lesson's own video, when
 *     the video service keeps it (lib/stream.ts), plays in that service's
 *     player, which is the fourth, and the service's address is the one
 *     place besides the file store the studio sends a file to. The lists
 *     of pixels and players are given to a
 *     store's own pages only; the studio, signing in and unsubscribing get
 *     neither. One page more may frame one address more: a community live
 *     event's own page (/@<handle>/community/events/<event>) may show its
 *     private video room from meet.jit.si (lib/community-events.ts), and is
 *     the only page allowed the camera, the microphone and sharing a screen,
 *     for that frame alone (roomPermissions, below).
 *
 *   - The pages built once, ahead of time — the home page, the help, the
 *     blog, the comparison pages — have no request to make a nonce for, so
 *     Next's own inline scripts are allowed by 'unsafe-inline'. Nothing on
 *     those pages comes from a creator or a visitor, and everything else is
 *     held to this site alone: no script from another address, no connection
 *     to another address, no plug-ins, no <base>, forms only to this site or
 *     an https address.
 *
 * Both let a page be framed only by this site ('self'), because the home page
 * shows the demo store in a frame of its own. One kind of page is the
 * exception: the card a creator pastes into their own website
 * (/embed/<handle>/<product>, lib/embed-rules.ts), which exists to be framed
 * by any site. Framing is safe there because nothing on it acts for anybody:
 * it reads no session, sets no cookie, and its one button opens Stripe's
 * checkout in a new tab, where the buyer still types their card and presses
 * pay themselves. A site that hid it under something else could at most
 * open a checkout nobody pays. The checkout script's card and sign-up form
 * (?mm=overlay, lib/embed-sdk.ts) are the same pages under /embed/ and are
 * framed the same way; what they show is decided by the page itself from the
 * Referer: the buy button, the form's box and the messages to the page only
 * on one of the creator's listed sites (lib/embed-sites.ts), and a plain
 * link to the product's page on any other, which no frame can misuse. Files handed over by the API
 * carry their own, stricter policy (lib/request-guard.ts, fileHeaders).
 *
 * Deliberately left out: 'upgrade-insecure-requests', which would break the
 * site on a local http address and adds nothing to a site that only answers
 * on https and says so with Strict-Transport-Security.
 */

import { VIDEO_FRAME_ORIGINS } from "./sales-page";
import { AUDIO_FRAME_ORIGINS } from "./audio-embed";
import { STREAM_API_ORIGIN, STREAM_PLAYER_ORIGIN } from "./stream-rules";
import { VAULT_FILES } from "./vault-rules";
import { REVEAL_HASHES } from "./reveal-scripts";

/** Where the ad platforms' own scripts send what they measure. */
const PIXEL_CONNECT = [
  // Meta
  "https://connect.facebook.net",
  "https://www.facebook.com",
  // Google tag (Analytics and Ads)
  "https://*.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.g.doubleclick.net",
  "https://www.google.com",
  "https://pagead2.googlesyndication.com",
  // TikTok
  "https://analytics.tiktok.com",
  "https://*.tiktok.com",
  "https://*.tiktokw.us",
  // Pinterest
  "https://ct.pinterest.com",
  "https://s.pinimg.com",
  // X (613 [WP12]): its script's host and the three it reports to, as X's own page lists them
  // (docs/x-reddit-pixels-official-check-2026-11-02.md, X item 2).
  "https://static.ads-twitter.com",
  "https://ads-twitter.com",
  "https://ads-api.twitter.com",
  "https://analytics.twitter.com",
];

/** Frames Google's tag opens for ad conversions. Nothing else is framed from elsewhere. */
const PIXEL_FRAMES = ["https://td.doubleclick.net", "https://www.googletagmanager.com"];

/** The video rooms made for live events (lib/call-rooms.ts), framed on an event's own page only. */
export const ROOM_FRAME_ORIGIN = "https://meet.jit.si";

/** Where the studio uploads files to (Vercel Blob), and where lesson videos play from. */
const BLOB_API = "https://vercel.com";
const BLOB_FILES = "https://*.blob.vercel-storage.com";

const dev = () => process.env.NODE_ENV === "development";

function join(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

const shared = (): Record<string, string[]> => ({
  "default-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:", "https:"],
  "font-src": ["'self'", "data:"],
  "media-src": ["'self'", "blob:", BLOB_FILES, VAULT_FILES],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  // Forms go here, and on to where our answers send them: Stripe's pages,
  // a creator's own https link after a free download.
  "form-action": ["'self'", "https:"],
  "frame-ancestors": ["'self'"],
});

/**
 * The policy for a page rendered for this one response, with its nonce.
 *
 * `store` is a store's own page. Only those may reach the ad platforms and
 * frame the three video players: the studio, signing in and unsubscribing
 * run none of that, so for them the list of other addresses stays at the
 * file storage the studio uploads to.
 */
export function dynamicPolicy(nonce: string, options: { store?: boolean; room?: boolean; embed?: boolean } = {}): string {
  const store = options.store !== false;
  const room = store && options.room === true;
  return join({
    ...shared(),
    // The pasted card, and nothing else, may be framed by any site (above).
    ...(options.embed ? { "frame-ancestors": ["*"] } : {}),
    // 'self', https: and 'unsafe-inline' are only for browsers too old to
    // know nonces; every current one ignores them when a nonce is present.
    // The layout's two small scripts carry no nonce, and are allowed by their
    // hashes instead (lib/reveal-scripts.ts).
    "script-src": [`'nonce-${nonce}'`, ...REVEAL_HASHES, "'strict-dynamic'", "'self'", "https:", "'unsafe-inline'", ...(dev() ? ["'unsafe-eval'"] : [])],
    // The video service's own address is where the studio sends a lesson
    // video's pieces, and its player the one a lesson page frames
    // (lib/stream.ts); the player, like the other three, on a store's pages only.
    "connect-src": ["'self'", BLOB_API, BLOB_FILES, VAULT_FILES, STREAM_API_ORIGIN, ...(store ? PIXEL_CONNECT : [])],
    "frame-src": ["'self'", ...(store ? [...PIXEL_FRAMES, ...VIDEO_FRAME_ORIGINS, ...AUDIO_FRAME_ORIGINS, STREAM_PLAYER_ORIGIN] : []), ...(room ? [ROOM_FRAME_ORIGIN] : [])],
  });
}

/** Whether a page is a community live event's own page, the one page that may frame its video room. */
export function isEventRoomPage(pathname: string): boolean {
  return /^\/(?:@|%40)[^/]+\/community\/events\/[0-9a-f]{12}\/?$/i.test(pathname);
}

/**
 * The Permissions-Policy for that page: the site's own (next.config.ts) says
 * no camera, microphone or screen sharing anywhere, and a frame cannot be
 * given what its page was refused. Here they are allowed to the page itself
 * and the room's address, and to nothing else; everything else stays off.
 */
export function roomPermissions(): string {
  const room = `"${ROOM_FRAME_ORIGIN}"`;
  return `camera=(self ${room}), microphone=(self ${room}), display-capture=(self ${room}), fullscreen=(self ${room}), geolocation=(), payment=(), usb=(), serial=(), hid=(), browsing-topics=()`;
}

/** Whether a page rendered per visit is a store's own page (under /@; the demo store's are among them). */
export function isStorePage(pathname: string): boolean {
  return /^\/(?:@|%40)/i.test(pathname);
}

/** The policy for a page built ahead of time, which has no nonce to carry. */
export function staticPolicy(): string {
  return join({
    ...shared(),
    "script-src": ["'self'", "'unsafe-inline'", ...(dev() ? ["'unsafe-eval'"] : [])],
    "connect-src": ["'self'"],
    "frame-src": ["'self'"],
  });
}

/** A nonce: 16 random bytes, base64, new for every response. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/**
 * Whether a page path is one rendered per visit, and so gets the nonce.
 *
 * Only those: a page built ahead of time has its scripts written without a
 * nonce, and sending it a nonce policy would switch every one of them off.
 * On a creator's own domain every page is a store page, so the proxy asks
 * this about the path it rewrites to, which always starts with /@.
 */
export function isDynamicPage(pathname: string): boolean {
  return /^\/(?:@|%40)/i.test(pathname) || /^\/(studio|signin|unsubscribe)(\/|$)/.test(pathname) || isEmbedPage(pathname);
}

/** The card a creator pastes into their own site, and the checkout script's card and sign-up form (/embed/<store>/join): framed anywhere, and nothing else is. */
export function isEmbedPage(pathname: string): boolean {
  return /^\/embed\/[^/]+\/[^/]+\/?$/.test(pathname);
}
