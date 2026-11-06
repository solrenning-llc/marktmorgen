/**
 * A community member's links to their own profiles elsewhere, shown beside
 * their name in the member directory (601 [KB22], unit U12; added
 * 6 November 2026). Browser-safe.
 *
 * Only what lib/store-socials.ts already accepts for a store, and less:
 *
 *   - a profile on one of the known social networks, at an https address on
 *     that network's own host, rebuilt by socialUrl; a handle alone is not
 *     enough, because nothing says which network it is on;
 *   - never an email address (other members never see a member's address),
 *     a phone number (WhatsApp) or a website of any kind, so the directory
 *     cannot be used to send people to an arbitrary page;
 *   - kept without the query or fragment a share button adds, which says who
 *     shared it rather than where it goes;
 *   - at most MAX_MEMBER_LINKS, each at most MAX_MEMBER_LINK_URL characters,
 *     no repeats.
 *
 * The member adds them on their own page and they show only while the member
 * chose to be listed, has a name, and is neither muted nor taken out
 * (shownLinks). They live in the member's own record (lib/community.ts), so
 * they are erased with it (lib/community-erasure.ts) and copied with it
 * (lib/person-copy.ts). The directory links them with no tracking and no
 * referrer (MEMBER_LINK_REL).
 */
import { SOCIALS, networkFor, socialUrl, type Social, type SocialNetwork } from "@/lib/store-socials";

/** The networks a member may link to: the social ones, without email, a phone or a website. */
export const MEMBER_LINK_NETWORKS: readonly SocialNetwork[] = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
  "facebook",
  "linkedin",
  "threads",
  "pinterest",
  "twitch",
  "spotify",
  "substack",
  "github",
  "discord",
  "telegram",
  "snapchat",
  "bluesky",
];

export const MAX_MEMBER_LINKS = 3;
export const MAX_MEMBER_LINK_URL = 200;

/**
 * How the directory links them: a member's words, not the store's (ugc), not
 * vouched for (nofollow), and opened without telling the other site which
 * community the reader came from (noreferrer). Not "me": the directory page
 * is a list of many people, so it is nobody's own page. Opened in the same
 * tab: a new window is a change the reader did not ask for.
 */
export const MEMBER_LINK_REL = "ugc nofollow noreferrer";

function allowed(network: unknown): network is SocialNetwork {
  return typeof network === "string" && (MEMBER_LINK_NETWORKS as readonly string[]).includes(network);
}

/** One link as typed: kept when it is a profile on an allowed network; null otherwise. */
export function memberLinkFrom(typed: unknown): Social | null {
  if (typeof typed !== "string") return null;
  const text = typed.trim();
  if (!text) return null;
  const network = networkFor(text);
  if (!allowed(network)) return null;
  // Only a full address names its network; "@ana" or "ana" could be anyone, anywhere.
  if (!/^https:\/\//i.test(text) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text)) return null;
  const url = untracked(socialUrl(network, text));
  if (!url || url.length > MAX_MEMBER_LINK_URL) return null;
  return { network, url };
}

/**
 * The address without its query or fragment: what a share button adds there
 * (Instagram's igsh, Spotify's si) says who shared it, not where it goes.
 * "" when it is not an https address.
 */
function untracked(url: string): string {
  if (!url.startsWith("https://")) return "";
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return "";
  }
}

/** The links a member sent, in order: what is kept, and how many were turned away. */
export function memberLinksFromForm(typed: unknown[]): { links: Social[]; refused: number } {
  const links: Social[] = [];
  let refused = 0;
  for (const one of typed.slice(0, MAX_MEMBER_LINKS)) {
    if (typeof one !== "string" || !one.trim()) continue;
    const link = memberLinkFrom(one);
    if (!link) refused += 1;
    else if (!links.some((l) => l.url === link.url)) links.push(link);
  }
  // Boxes past the last one the page draws are never kept, and say so.
  refused += typed.slice(MAX_MEMBER_LINKS).filter((one) => typeof one === "string" && one.trim()).length;
  return { links, refused };
}

/** The links as a member's record keeps them, read back: anything not allowed today is left out. */
export function parseMemberLinks(raw: unknown): Social[] {
  if (!Array.isArray(raw)) return [];
  const out: Social[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_MEMBER_LINKS) break;
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (!allowed(value.network) || typeof value.url !== "string") continue;
    // Read back through the same rebuild, so a record written by hand or
    // under an older rule never puts an address on the page that the form
    // would refuse today.
    const url = value.url.startsWith("https://") ? untracked(socialUrl(value.network, value.url)) : "";
    if (!url || url.length > MAX_MEMBER_LINK_URL || out.some((s) => s.url === url)) continue;
    out.push({ network: value.network, url });
  }
  return out;
}

/** What the directory may show of a member's links: none unless they are listed, named, not muted and not taken out. */
export function shownLinks(member: { dir: boolean; n: string; muted: boolean; removed: boolean; s: Social[] }): Social[] {
  if (!member.dir || !member.n || member.muted || member.removed) return [];
  return parseMemberLinks(member.s);
}

/** The network's own name, as the link shows it. */
export function memberLinkLabel(link: Social): string {
  return SOCIALS[link.network].label;
}
