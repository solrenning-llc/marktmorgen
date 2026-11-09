/**
 * The one form a contact detail takes on Marktmorgen's research
 * do-not-contact list (lib/research-do-not-contact.ts), with no server code,
 * so the form on /privacy/do-not-contact checks a contact the same way in the
 * browser before it is sent (components/do-not-contact-form.tsx).
 */

/** The longest contact detail and name taken, as the creator research form takes them (lib/creator-research.ts, LIMITS). */
export const CONTACT_MAX_LENGTH = 300;
export const NAME_MAX_LENGTH = 80;
/**
 * The most bytes a contact detail is kept in, in its normalized form ("email:"
 * and up to 300 characters): a longer one, such as a link whose path grows
 * when it is percent-encoded, is refused, never kept or cut
 * (tests/store-data-registry.ts and tests/plan-cost-registry.ts say this figure).
 */
export const CONTACT_FIELD_MAX_BYTES = 306;

/** The field for bots on the form: a name no browser fills in by itself; whatever fills it is told it worked, and nothing is kept. */
export const DO_NOT_CONTACT_TRAP = "dnc_extra";

const LOCAL_PART = /^[a-z0-9!#$%&'*+=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+=?^_`{|}~-]+)*$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const TOP_LEVEL = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** What people put around an address when they copy it: quotes, angle brackets, a sentence's last mark. */
const LEADING = /^[\s"'“”‘’«»<([]+/;
const TRAILING = /[\s"'“”‘’«»>)\].,;:!?]+$/;

/** A host as mail and links reach it: punycode for a name with accents, null when it is not one. */
function asciiHost(host: string): string | null {
  let ascii = host;
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      ascii = new URL(`https://${host}/`).hostname;
    } catch {
      return null;
    }
  }
  ascii = ascii.replace(/\.$/, "");
  if (ascii.length > 253 || !HOST.test(ascii)) return null;
  return TOP_LEVEL.test(ascii.slice(ascii.lastIndexOf(".") + 1)) ? ascii : null;
}

/** Other names of one site: a profile on either is the same profile. */
const SAME_SITE: Readonly<Record<string, string>> = { "twitter.com": "x.com", "fb.com": "facebook.com", "instagr.am": "instagram.com" };
/** Sites whose profile paths do not depend on case (instagram.com/AnaMakes is instagram.com/anamakes). */
const CASELESS_PATHS = new Set(["instagram.com", "x.com", "facebook.com", "tiktok.com", "threads.net", "github.com", "pinterest.com", "linkedin.com"]);
/** Gmail reads no dots in the name and is also googlemail.com. */
const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** A path with its percent-escapes written one way (%C3%A9, never %c3%a9), its trailing slash gone. */
function pathOf(url: URL): string {
  return url.pathname.replace(/\/+$/, "").replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

/**
 * A contact detail in the one form the list keeps and checks, so one person
 * is one entry and two people are never one:
 *
 *   - an email address in lower case, its domain in punycode, without its
 *     "+tag"; at Gmail (and googlemail.com, kept as gmail.com) without dots;
 *   - a link to a site or profile as its host in lower case, every "www.",
 *     "m." and "mobile." taken off, the site's other names joined
 *     (twitter.com is x.com, fb.com facebook.com, instagr.am instagram.com),
 *     and its path as written, without query, fragment or trailing slash;
 *     the path is lowered only on sites where its case does not matter
 *     (CASELESS_PATHS, and YouTube's @handles), so channel ids that differ by
 *     case stay apart; facebook.com/profile.php keeps its numeric id, and
 *     without one is refused.
 *
 * What people put around an address when they copy it ("mailto:", <>,
 * quotes, a last full stop or comma) is taken off first. Anything else, or a
 * form longer than CONTACT_FIELD_MAX_BYTES, is null: it is neither kept nor
 * contacted.
 */
export function normalizeResearchContact(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.normalize("NFC").trim();
  if (!text || text.length > CONTACT_MAX_LENGTH) return null;
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(LEADING, "").replace(TRAILING, "");
    if (/^mailto:/i.test(text)) text = text.slice("mailto:".length).replace(/\?.*$/, "");
    if (text === before) break;
  }
  if (!text || /\s/.test(text)) return null;
  let normalized: string;
  if (text.includes("@") && !text.includes("/") && !text.includes(":")) {
    const parts = text.toLowerCase().split("@");
    if (parts.length !== 2) return null;
    const [written, domain] = parts;
    if (!written || written.length > 64 || !LOCAL_PART.test(written)) return null;
    let host = asciiHost(domain);
    if (!host) return null;
    let local = written.split("+")[0];
    if (GMAIL.has(host)) {
      host = "gmail.com";
      local = local.replace(/\./g, "");
    }
    if (!local) return null;
    normalized = `email:${local}@${host}`;
  } else {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.port) return null;
    const host = asciiHost(url.hostname);
    if (!host) return null;
    // The same profile on the mobile site, or behind "www.", however many, is one entry.
    let site = host;
    for (let before = ""; before !== site; ) {
      before = site;
      site = site.replace(/^(www|m|mobile)\.(?=[^.]+\.[^.]+)/, "");
    }
    site = SAME_SITE[site] ?? site;
    let path = pathOf(url);
    if (CASELESS_PATHS.has(site) || (site === "youtube.com" && /^\/@/.test(path))) path = path.toLowerCase();
    if (site === "facebook.com" && path === "/profile.php") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^\d{1,20}$/.test(id)) return null;
      path = `${path}?id=${id}`;
    }
    normalized = `link:${site}${path}`;
  }
  return new TextEncoder().encode(normalized).length <= CONTACT_FIELD_MAX_BYTES ? normalized : null;
}

/**
 * The name as given, control characters and lone surrogates taken out, its
 * spaces closed up, at most NAME_MAX_LENGTH characters, never cut inside one.
 */
export function cleanResearchName(raw: string): string {
  const text = String(raw ?? "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cs}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, NAME_MAX_LENGTH).join("").trim();
}
