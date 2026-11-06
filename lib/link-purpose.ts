/**
 * Whether a link's or a button's own words say where it goes (WCAG 2.4.4, and 2.4.9 at AAA): "Click here",
 * "Read more" or an address alone do not. Pure and browser-safe, for the studio's checks of a store's links
 * (lib/store-access-check.ts) and of a sales page's buttons (lib/page-coach.ts). It flags; it never changes words.
 */
/** Words that say nothing about where a link goes, said alone. */
const VAGUE = new Set(["click", "click here", "tap here", "here", "link", "this link", "this", "read more", "more", "learn more", "see more", "go", "open", "visit", "website", "details", "info"]);

/** True when a link's words do not say where it goes: "Click here", "Read more", an address instead of words, no letters at all. */
export function vagueLinkTitle(title: string): boolean {
  const words = title.trim().toLowerCase().replace(/[\s.!?:…→>»-]+$/u, "").replace(/^[\s→>»-]+/u, "").replace(/\s+/g, " ");
  if (!/\p{L}/u.test(words)) return true;
  if (VAGUE.has(words)) return true;
  // An address as its words: a screen reader spells it out, and it does not say what is there.
  return /^(?:https?:\/\/|www\.)\S+$/.test(words) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/.test(words);
}
