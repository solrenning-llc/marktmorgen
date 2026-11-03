/**
 * The ad pixels a creator can put on their store: which ones, and what an id
 * for each is allowed to look like.
 *
 * An id ends up inside a script on a public page, so each one is held to the
 * exact shape its platform hands out. Nothing that could close a string or
 * open a tag can pass, whatever the studio sent.
 *
 * Pure, so the studio's form can use the same rules in the browser that the
 * server enforces.
 */

export type PixelKind = "meta" | "google" | "tiktok" | "pinterest" | "x" | "reddit";

/**
 * X names each event by an ID the creator makes in X's Events Manager, sent
 * as `tw-<pixel id>-<event id>` (613 [WP12]; docs/x-reddit-pixels-official-check-2026-11-02.md,
 * X item 3): no fixed word works, so the creator gives the purchase's and the
 * lead's. Without one, that event is not sent to X; page views are, by X's
 * own base code.
 */
export type XEvents = { purchase: string | null; lead: string | null };

/**
 * `xEvents` only while the X pixel is on. `redditMatchingOff` only while the
 * Reddit pixel is on: the creator's word that Reddit's Automated Advanced
 * Matching is switched off for it (613 [WP12] unit 2). It reads email
 * addresses shown or typed on a page, and store pages show buyers' own; no
 * switch for it in code was confirmed, so the pixel is saved only with it.
 */
export type Pixels = Record<PixelKind, string | null> & { xEvents?: XEvents; redditMatchingOff?: true };

export const NO_PIXELS: Pixels = { meta: null, google: null, tiktok: null, pinterest: null, x: null, reddit: null };

export const PIXEL_KINDS: PixelKind[] = ["meta", "google", "tiktok", "pinterest", "x", "reddit"];

/** A field the studio sends that can be refused: a pixel, one of X's two event IDs, or Reddit's matching confirmation. */
export type PixelField = PixelKind | "xPurchase" | "xLead" | "redditMatching";

export const PIXEL_INFO: Record<
  PixelKind,
  { name: string; label: string; example: string; where: string; pattern: RegExp }
> = {
  meta: {
    name: "Meta",
    label: "Meta Pixel ID",
    example: "123456789012345",
    where: "Meta Events Manager, under Data sources: the number under the pixel's name.",
    pattern: /^\d{10,20}$/,
  },
  google: {
    name: "Google",
    label: "Google tag ID",
    example: "G-AB12CD34EF",
    where: "Google Analytics or Google Ads, under the Google tag: it starts with G- or AW-.",
    pattern: /^(G|AW|GT|DC)-[A-Z0-9]{4,20}$/,
  },
  tiktok: {
    name: "TikTok",
    label: "TikTok Pixel ID",
    example: "C4ABCDEFGH1234567890",
    where: "TikTok Ads Manager, under Assets, Events, Web events: the ID next to the pixel.",
    pattern: /^[A-Z0-9]{15,25}$/,
  },
  pinterest: {
    name: "Pinterest",
    label: "Pinterest Tag ID",
    example: "2612345678901",
    where: "Pinterest Ads, under Conversions: the number of your tag.",
    pattern: /^\d{10,16}$/,
  },
  // X's exact ID format is not in the pages read on 2 November 2026: this is
  // a safe shape (letters and digits only), not a claim about X's format.
  x: {
    name: "X",
    label: "X Pixel ID",
    example: "a1b2c",
    where: "X Events Manager: the ID of your pixel, letters and numbers only.",
    pattern: /^[A-Za-z0-9]{3,32}$/,
  },
  // Reddit's exact ID format is not in the pages read either: a safe shape.
  reddit: {
    name: "Reddit",
    label: "Reddit Pixel ID",
    example: "a2_abc123",
    where: "Reddit Events Manager: the ID of your pixel, letters, numbers and underscores only.",
    pattern: /^[A-Za-z0-9_]{3,40}$/,
  },
};

/** What an X event ID may look like (the same safe shape). */
export const X_EVENT_PATTERN = /^[A-Za-z0-9]{3,32}$/;

/** An X event ID as pasted: the ID alone, or the whole `tw-<pixel>-<event>` X shows. */
export function tidyXEvent(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim().replace(/^['"]|['"]$/g, "");
  const whole = /^tw-[A-Za-z0-9]+-([A-Za-z0-9]+)$/.exec(text);
  return whole ? whole[1] : text;
}

/** The name X's pixel takes for one of the creator's events. */
export function xEventName(pixel: string, event: string): string {
  return `tw-${pixel}-${event}`;
}

/** Tidies what a person pasted: spaces around it, and letters in the case the platform uses. */
export function tidyPixelId(kind: PixelKind, raw: unknown): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  return kind === "google" || kind === "tiktok" ? text.toUpperCase() : text;
}

/**
 * Reads a set of ids sent from the studio.
 *
 * An empty field means that pixel is off. Any other value has to match its
 * platform's shape exactly, or the whole set is refused with the one at fault.
 */
export function readPixels(raw: unknown): { ok: true; pixels: Pixels } | { ok: false; bad: PixelField } {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pixels: Pixels = { ...NO_PIXELS };
  for (const kind of PIXEL_KINDS) {
    const id = tidyPixelId(kind, value[kind]);
    if (!id) continue;
    if (!PIXEL_INFO[kind].pattern.test(id)) return { ok: false, bad: kind };
    pixels[kind] = id;
  }
  // The two event IDs, sent flat from the studio or kept under xEvents.
  const kept = value.xEvents && typeof value.xEvents === "object" ? (value.xEvents as Record<string, unknown>) : {};
  const purchase = tidyXEvent(value.xPurchase ?? kept.purchase);
  const lead = tidyXEvent(value.xLead ?? kept.lead);
  if (purchase && !X_EVENT_PATTERN.test(purchase)) return { ok: false, bad: "xPurchase" };
  if (lead && !X_EVENT_PATTERN.test(lead)) return { ok: false, bad: "xLead" };
  if (pixels.x) pixels.xEvents = { purchase: purchase || null, lead: lead || null };
  if (pixels.reddit) {
    if (value.redditMatchingOff !== true) return { ok: false, bad: "redditMatching" };
    pixels.redditMatchingOff = true;
  }
  return { ok: true, pixels };
}

/** Whatever came back from storage, made safe to put on a page. */
export function parsePixels(raw: unknown): Pixels {
  const read = readPixels(raw);
  if (read.ok) return read.pixels;
  // A stored value that no longer passes is dropped on its own, not with the rest.
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pixels: Pixels = { ...NO_PIXELS };
  for (const kind of PIXEL_KINDS) {
    const id = tidyPixelId(kind, value[kind]);
    if (id && PIXEL_INFO[kind].pattern.test(id)) pixels[kind] = id;
  }
  if (pixels.x) {
    const kept = value.xEvents && typeof value.xEvents === "object" ? (value.xEvents as Record<string, unknown>) : {};
    const one = (raw: unknown) => {
      const id = tidyXEvent(raw);
      return id && X_EVENT_PATTERN.test(id) ? id : null;
    };
    pixels.xEvents = { purchase: one(kept.purchase), lead: one(kept.lead) };
  }
  // A Reddit pixel kept without the creator's word on matching is not put on a page.
  if (pixels.reddit && value.redditMatchingOff !== true) pixels.reddit = null;
  if (pixels.reddit) pixels.redditMatchingOff = true;
  return pixels;
}

export function hasPixels(pixels: Pixels): boolean {
  return PIXEL_KINDS.some((kind) => pixels[kind] !== null);
}

/** "Meta, Google and TikTok". */
export function pixelNames(pixels: Pixels): string {
  const names = PIXEL_KINDS.filter((kind) => pixels[kind]).map((kind) => PIXEL_INFO[kind].name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Where a visitor has to say yes before an ad pixel may run: the European
 * Economic Area, the United Kingdom and Switzerland, whose cookie rules ask for
 * consent first, and Brazil, whose regulator reads its law the same way for
 * advertising cookies. Everywhere else the pixels run unless the browser sends
 * Global Privacy Control, which is the visitor saying no in advance.
 */
export const CONSENT_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO", "GB", "CH", "BR",
]);

/** Whether a visitor from this country is asked first. Unknown means ask. */
export function needsConsent(country: string | null | undefined): boolean {
  if (!country || !/^[A-Z]{2}$/.test(country)) return true;
  return CONSENT_COUNTRIES.has(country);
}

/** A browser-wide refusal wins over a previous per-store yes; unknown choices never become consent. */
export function pixelChoiceState(choice:unknown,askFirst:boolean,gpc:boolean):"on"|"off"|"ask"{
 if(gpc||choice==="no")return "off";
 if(choice==="yes")return "on";
 return askFirst?"ask":"on";
}
