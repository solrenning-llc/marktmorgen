/**
 * A community member's links to their own profiles elsewhere, shown beside
 * their name in the member directory (601 [KB22], unit U12; added
 * 6 November 2026). Browser-safe: the member's page checks each box with
 * memberLinkFrom as it is typed, and the server keeps by the same rule.
 *
 * Only what lib/store-socials.ts already accepts for a store, and less:
 *
 *   - a page on one of the known social networks, at an https address on
 *     that network's own host, rebuilt by socialUrl; never the network's own
 *     front page, and on Substack only a publication's own address under
 *     substack.com; a handle alone is not enough, because nothing says which
 *     network it is on;
 *   - never an email address (other members never see a member's address),
 *     a phone number (WhatsApp) or a website of any kind, so the directory
 *     cannot send people anywhere but those networks' own sites; nor a
 *     network's own link redirector, nor an address that carries another
 *     address in its path or query;
 *   - without what a share button adds to the query or the fragment (who
 *     shared it, not where it goes), keeping a query that names the profile
 *     (Facebook's profile.php?id=);
 *   - at most MAX_MEMBER_LINKS, each at most MAX_MEMBER_LINK_URL characters,
 *     the same profile once however it was written.
 *
 * The member adds them on their own page and they show only while the member
 * chose to be listed, has a name, and is neither muted nor taken out
 * (shownLinks). They live in the member's own record (lib/community.ts), so
 * they are erased with it (lib/community-erasure.ts) and copied with it
 * (lib/person-copy.ts). The directory links them with no tracking and no
 * referrer (MEMBER_LINK_REL).
 */
import { SOCIALS, networkFor, parseSocials, socialShown, socialUrl, type Social, type SocialNetwork } from "@/lib/store-socials";

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

/**
 * What share buttons add to an address to say who shared it: Instagram's
 * igsh, Spotify's si, X's s and t, TikTok's _t and _r, Facebook's mibextid,
 * YouTube's feature, and the usual campaign and click marks.
 */
const SHARE_MARKS = /^(utm_.*|igsh|igshid|si|s|t|_t|_r|mibextid|fbclid|gclid|feature|ref|ref_src|ref_url|is_from_webapp|sender_device)$/i;

/**
 * A network's own link redirector: on the network's host, but it sends the
 * reader to another site under a label that says the network (Facebook's
 * l.php and its l./lm. hosts, Instagram's linkshim and l. host, YouTube's
 * redirect, LinkedIn's redir). Never anyone's profile.
 */
const REDIRECTOR_HOST = /^(l|lm)\.(facebook\.com|fb\.com|instagram\.com)$/;
const REDIRECTOR_PATH: Partial<Record<SocialNetwork, RegExp>> = {
  facebook: /^\/(l\.php|flx\/)/i,
  instagram: /^\/linkshim(\/|$)/i,
  youtube: /^\/redirect(\/|$)/i,
  linkedin: /^\/redir(\/|$)/i,
};

/** The text decoded as far as it goes (at most three times); an escape that does not decode leaves it as it is. */
function decoded(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(out);
    } catch {
      return out;
    }
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * Whether a piece of the address carries another address: a scheme's "://"
 * anywhere, a value starting "//", or a "//" still escaped after decoding
 * (written more times over, or beside an escape that does not decode), which
 * is refused rather than read as nothing.
 */
function carriesAddress(piece: string): boolean {
  const text = decoded(piece);
  return text.includes("://") || text.startsWith("//") || /%2f%2f/i.test(text);
}

function allowed(network: unknown): network is SocialNetwork {
  return typeof network === "string" && (MEMBER_LINK_NETWORKS as readonly string[]).includes(network);
}

/** The address cleaned of share marks and its fragment; "" when it is not one a member may link to on that network. */
function cleaned(network: SocialNetwork, href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "";
  }
  if (url.protocol !== "https:") return "";
  for (const key of [...url.searchParams.keys()]) if (SHARE_MARKS.test(key)) url.searchParams.delete(key);
  url.hash = "";
  const host = url.hostname.toLowerCase();
  // A redirector, or anything that carries another address in its path or
  // what is left of its query, sends the reader off the network.
  if (REDIRECTOR_HOST.test(host) || REDIRECTOR_PATH[network]?.test(url.pathname)) return "";
  if (url.pathname.includes("//") || carriesAddress(url.pathname)) return "";
  for (const [key, value] of url.searchParams) if (carriesAddress(key) || carriesAddress(value)) return "";
  // Substack's address is the publication's own name under substack.com;
  // everywhere else the network's front page is nobody's profile.
  if (network === "substack" ? host === "substack.com" || host === "www.substack.com" : url.pathname === "/") return "";
  const out = url.href;
  return out.length > MAX_MEMBER_LINK_URL ? "" : out;
}

/** One link as typed: kept when it is a page on an allowed network's own site; null otherwise. */
export function memberLinkFrom(typed: unknown): Social | null {
  if (typeof typed !== "string") return null;
  const text = typed.trim();
  if (!text || text.length > 300) return null;
  // Any scheme but https (http, mailto, javascript) is refused; one with none is read as https.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https:\/\//i.test(text)) return null;
  const full = /^https:\/\//i.test(text) ? text : `https://${text}`;
  const network = networkFor(full);
  if (!allowed(network)) return null;
  // socialUrl sees a full address, so it only ever checks the host; it never
  // turns a bare word into somebody's profile.
  const url = cleaned(network, socialUrl(network, full));
  return url ? { network, url } : null;
}

/** The same profile however it was written: no www, any case, no trailing slash. */
function sameKey(url: string): string {
  return url.toLowerCase().replace(/^https:\/\/www\./, "https://").replace(/\/(?=$|\?)/, "");
}

function addOnce(out: Social[], link: Social): void {
  if (!out.some((l) => sameKey(l.url) === sameKey(link.url))) out.push(link);
}

/** The links a member sent, in order: what is kept, and how many were turned away. */
export function memberLinksFromForm(typed: unknown[]): { links: Social[]; refused: number } {
  const links: Social[] = [];
  let refused = 0;
  typed.forEach((one, i) => {
    if (typeof one !== "string" || !one.trim()) return;
    // Boxes past the last one the page draws are never kept, and say so.
    const link = i < MAX_MEMBER_LINKS ? memberLinkFrom(one) : null;
    if (!link) refused += 1;
    else addOnce(links, link);
  });
  return { links, refused };
}

/**
 * The links as a member's record keeps them, read back: through the store's
 * own reading (parseSocials) and then this file's rule, so a record written
 * by hand or under an older rule never puts an address on the page that the
 * form would refuse today.
 */
export function parseMemberLinks(raw: unknown): Social[] {
  const out: Social[] = [];
  for (const social of parseSocials(Array.isArray(raw) ? raw.filter((e) => e && typeof e === "object" && allowed((e as Social).network)) : [])) {
    if (out.length >= MAX_MEMBER_LINKS) break;
    const link = memberLinkFrom(social.url);
    if (link && link.network === social.network) addOnce(out, link);
  }
  return out;
}

/** What the directory may show of a member's links (already read back by parseMemberLinks): none unless they are listed, named, not muted and not taken out. */
export function shownLinks(member: { dir: boolean; n: string; muted: boolean; removed: boolean; s?: Social[] }): Social[] {
  if (!member.dir || !member.n || member.muted || member.removed) return [];
  return member.s ?? [];
}

/**
 * The words each link shows: the network's own name, and where two of one
 * member's links are on the same network, the address too, so each says
 * where it goes on its own (WCAG 2.4.9).
 */
export function memberLinkLabels(links: Social[]): string[] {
  return links.map((link) => {
    const label = SOCIALS[link.network].label;
    const twice = links.filter((l) => l.network === link.network).length > 1;
    return twice ? `${label} (${socialShown(link.url)})` : label;
  });
}
