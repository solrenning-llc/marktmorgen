/**
 * The creator's profiles elsewhere, under their name on the store page
 * (added 9 October 2026): Instagram, TikTok, YouTube and the rest, and an
 * email address or a website. Linktree, Stan and Beacons all open with this
 * row; the store page did not have one.
 *
 * Each is kept as the address it opens, rebuilt here from what was typed:
 * a handle ("@ana" or "ana") becomes the network's own profile address, and
 * a full address is kept only when it is https and on that network's own
 * host. Nothing else is linked. Each shows the network's name with a plain
 * icon from the site's own set, never a company's logo. Browser-safe.
 */

import type { IconName } from "@/components/icons";

export type SocialNetwork =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "x"
  | "facebook"
  | "linkedin"
  | "threads"
  | "pinterest"
  | "twitch"
  | "spotify"
  | "substack"
  | "github"
  | "discord"
  | "whatsapp"
  | "telegram"
  | "snapchat"
  | "bluesky"
  | "email"
  | "website";

type Spec = { label: string; hosts: string[]; profile: ((handle: string) => string) | null; handle?: RegExp; icon: IconName };

const HANDLE = /^[A-Za-z0-9._-]{1,60}$/;

export const SOCIALS: Record<SocialNetwork, Spec> = {
  instagram: { label: "Instagram", hosts: ["instagram.com"], profile: (h) => `https://www.instagram.com/${h}`, icon: "camera" },
  tiktok: { label: "TikTok", hosts: ["tiktok.com"], profile: (h) => `https://www.tiktok.com/@${h}`, icon: "music" },
  youtube: { label: "YouTube", hosts: ["youtube.com", "youtu.be"], profile: (h) => `https://www.youtube.com/@${h}`, icon: "video" },
  x: { label: "X", hosts: ["x.com", "twitter.com"], profile: (h) => `https://x.com/${h}`, icon: "chat" },
  facebook: { label: "Facebook", hosts: ["facebook.com", "fb.com"], profile: (h) => `https://www.facebook.com/${h}`, icon: "users" },
  linkedin: { label: "LinkedIn", hosts: ["linkedin.com"], profile: (h) => `https://www.linkedin.com/in/${h}`, icon: "handshake" },
  threads: { label: "Threads", hosts: ["threads.net", "threads.com"], profile: (h) => `https://www.threads.net/@${h}`, icon: "chat" },
  pinterest: { label: "Pinterest", hosts: ["pinterest.com"], profile: (h) => `https://www.pinterest.com/${h}`, icon: "pin" },
  twitch: { label: "Twitch", hosts: ["twitch.tv"], profile: (h) => `https://www.twitch.tv/${h}`, icon: "video" },
  spotify: { label: "Spotify", hosts: ["open.spotify.com", "spotify.com"], profile: null, icon: "music" },
  substack: { label: "Substack", hosts: ["substack.com"], profile: (h) => `https://${h}.substack.com`, handle: /^[a-z0-9-]{1,60}$/i, icon: "mail" },
  github: { label: "GitHub", hosts: ["github.com"], profile: (h) => `https://github.com/${h}`, icon: "file" },
  discord: { label: "Discord", hosts: ["discord.gg", "discord.com"], profile: null, icon: "chat" },
  whatsapp: { label: "WhatsApp", hosts: ["wa.me", "whatsapp.com"], profile: (h) => `https://wa.me/${h.replace(/\D/g, "")}`, handle: /^\+?[\d\s()-]{7,20}$/, icon: "phone" },
  telegram: { label: "Telegram", hosts: ["t.me", "telegram.me"], profile: (h) => `https://t.me/${h}`, icon: "chat" },
  snapchat: { label: "Snapchat", hosts: ["snapchat.com"], profile: (h) => `https://www.snapchat.com/add/${h}`, icon: "camera" },
  bluesky: { label: "Bluesky", hosts: ["bsky.app"], profile: (h) => `https://bsky.app/profile/${h}`, icon: "chat" },
  email: { label: "Email", hosts: [], profile: null, icon: "mail" },
  website: { label: "Website", hosts: [], profile: null, icon: "globe" },
};

export const SOCIAL_NETWORKS = Object.keys(SOCIALS) as SocialNetwork[];
export const MAX_SOCIALS = 12;

export type Social = { network: SocialNetwork; url: string };

export function isSocialNetwork(value: unknown): value is SocialNetwork {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SOCIALS, value);
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;

/** The address a profile opens, from what was typed; "" when it is not one for that network. */
export function socialUrl(network: SocialNetwork, typed: unknown): string {
  if (typeof typed !== "string") return "";
  const text = typed.trim();
  if (!text || text.length > 300) return "";
  const spec = SOCIALS[network];
  if (network === "email") {
    const address = text.replace(/^mailto:/i, "");
    return EMAIL.test(address) ? `mailto:${address}` : "";
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return "";
    }
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const host = url.hostname.toLowerCase();
    if (network === "website") {
      if (!host.includes(".") || host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[")) return "";
      return url.href;
    }
    const own = spec.hosts.some((h) => host === h || host.endsWith(`.${h}`));
    return own ? url.href : "";
  }
  if (network === "website") return socialUrl("website", `https://${text}`);
  if (!spec.profile) return "";
  const handle = text.replace(/^@/, "");
  return (spec.handle ?? HANDLE).test(handle) ? new URL(spec.profile(handle)).href : "";
}

/** A list of profiles as kept or as sent, made safe: known networks, working addresses, no repeats, at most MAX_SOCIALS. */
export function parseSocials(raw: unknown): Social[] {
  if (!Array.isArray(raw)) return [];
  const out: Social[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (!isSocialNetwork(value.network)) continue;
    const url = socialUrl(value.network, value.url);
    if (!url || out.some((s) => s.url === url)) continue;
    out.push({ network: value.network, url });
    if (out.length >= MAX_SOCIALS) break;
  }
  return out;
}

/** What a profile shows in the studio's box: the handle, when the address is the network's own profile address for one. */
export function typedOf(social: Social): string {
  return social.network === "email" ? social.url.replace(/^mailto:/, "") : social.url;
}

/** The network a pasted address belongs to, by its host; null when it is none of them (then it is a website). */
export function networkFor(typed: string): SocialNetwork | null {
  const text = typed.trim();
  // An address with a scheme, or a host and a path, is read by its host first:
  // "https://www.tiktok.com/@ana.silva" ends like an email address and is not one.
  const looksLikeAddress = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text);
  if (!looksLikeAddress && /^(mailto:)?[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(text)) return "email";
  let host = "";
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.includes(".")) return null;
  for (const network of SOCIAL_NETWORKS) {
    if (SOCIALS[network].hosts.some((h) => host === h || host.endsWith(`.${h}`))) return network;
  }
  return null;
}

/** What the studio shows under a box: where the link will go, without "https://". */
export function socialShown(url: string): string {
  return url.replace(/^mailto:/, "").replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "");
}

/**
 * The plain icon a link on the store page carries, from where it goes (added
 * 9 October 2026): a profile's own network's, a few kinds of place by their
 * address, and a chain link for anything else. Never a company's logo.
 */
export function linkIcon(url: string): IconName {
  const network = networkFor(url);
  if (network && network !== "email") return SOCIALS[network].icon;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "link";
  }
  const on = (...hosts: string[]) => hosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (on("calendly.com", "cal.com", "savvycal.com", "tidycal.com", "zcal.co")) return "calendar";
  if (on("podcasts.apple.com", "anchor.fm", "buzzsprout.com", "transistor.fm", "simplecast.com", "podbean.com")) return "mic";
  if (on("soundcloud.com", "bandcamp.com", "music.apple.com", "deezer.com")) return "music";
  if (on("vimeo.com", "loom.com", "rumble.com")) return "video";
  if (on("beehiiv.com", "convertkit.com", "kit.com", "mailchimp.com", "buttondown.email", "ghost.io", "medium.com")) return "mail";
  if (on("amazon.com", "amazon.co.uk", "amazon.de", "etsy.com", "shopify.com", "ebay.com")) return "basket";
  if (on("patreon.com", "ko-fi.com", "buymeacoffee.com")) return "gift";
  if (on("goodreads.com", "notion.site", "notion.so")) return "book";
  return "link";
}
