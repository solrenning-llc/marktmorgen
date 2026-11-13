/**
 * Outreach: a creator writes to a business that has never heard of them — a
 * brand that might sponsor them, somebody who might sell their product for a
 * share, a company that might buy it — and does it the way the law and
 * everybody's terms allow.
 *
 * Measured before it was built (October 5, 2026). Explee sells this outcome
 * to small businesses: it finds people in a database of 536 million, writes
 * each an email, sends it from mailboxes of its own and answers the replies,
 * for $0.04 an email. Its own terms leave the law to the customer, and its
 * reviews are about emails sent without approval and charges nobody agreed
 * to. Among stores for creators, Beacons writes a pitch and stops there; Stan
 * has nothing. PitchBrand, Bento and SponsorRadar sell brand outreach by
 * itself for $29 to $49 a month.
 *
 * What was read first, and what it decided:
 *
 *   The law. A first email from one business to another, with no earlier yes,
 *   is allowed with conditions in the United States (CAN-SPAM), the United
 *   Kingdom for companies (PECR reg. 22, ICO), France (CNIL), Ireland (S.I.
 *   336/2011 reg. 13), Sweden for companies (Marknadsföringslagen 19 §),
 *   Canada for an address the company published (CASL s. 10(9)(b)) and
 *   Australia likewise (Spam Act, Sch. 2 cl. 4). It needs consent first in
 *   Germany (UWG §7), the Netherlands, Spain, Italy and Poland, businesses
 *   included. To a consumer it needs consent everywhere but the United
 *   States. So this is for businesses only, the creator says where the
 *   business is, and a country that is not on the first list cannot be
 *   written to from here — the ones not read yet included.
 *
 *   Everybody's terms. Our own email provider forbids "cold outreach,
 *   purchased lists, or scraped contact data", and so does every other one;
 *   mailboxes of ours would break Google's and Microsoft's rules. The bought
 *   databases forbid being shown to somebody else's customers. So nothing is
 *   sent by us and no contact is bought. The address is the one the business
 *   published on its own website, read from that website, kept with where it
 *   was found; and the email is opened, written, as a draft in the creator's
 *   own mailbox, where they read it and press Send themselves.
 *
 * Which also answers what Explee's customers complain of: nothing can go out
 * that the creator did not send, under their own name, and there is no
 * charge for an email at all.
 *
 * Nothing in this file touches the network, so the studio reads the same
 * rules in the browser that the server holds a pitch to.
 */

import { htmlToPlainText, withoutTags } from "@/lib/plain-text";

export type OutreachGoal = "sponsor" | "partner" | "business";

export const OUTREACH_GOALS: { id: OutreachGoal; label: string; hint: string }[] = [
  { id: "sponsor", label: "A sponsor", hint: "A brand that would pay to reach the people who follow you." },
  { id: "partner", label: "A partner who sells for a share", hint: "Somebody with an audience of their own, who would recommend your product for a commission." },
  { id: "business", label: "A business that would buy", hint: "A company your product or your time would be useful to." },
];

export function isGoal(value: unknown): value is OutreachGoal {
  return value === "sponsor" || value === "partner" || value === "business";
}

// ---- Where the business is ---------------------------------------------------

export type CountryRule = {
  code: string;
  name: string;
  /** Whether a first email to a business there may be written from here. */
  allowed: boolean;
  /** Why not, in a sentence, when it may not. */
  why?: string;
  /** The law it rests on, named so the page can say what was read. */
  law: string;
  /** Only a company may be written to: a sole trader counts as a person there. */
  companiesOnly?: boolean;
  /**
   * Only an address that names a job, not a person. Where data-protection law
   * treats jane.doe@brand.com as Jane's personal data, writing to her needs
   * more than this tool does; partnerships@brand.com is the company's.
   */
  roleOnly?: boolean;
  /** The email has to say that it is a commercial message. */
  saysCommercial?: boolean;
  /** Working days in which a "stop" has to be honored. */
  stopDays: number;
};

const NEEDS_CONSENT = "The law there asks for the business's consent before a first email, so this cannot be written from here.";

export const OUTREACH_COUNTRIES: CountryRule[] = [
  { code: "US", name: "United States", allowed: true, law: "CAN-SPAM Act", saysCommercial: true, stopDays: 10 },
  { code: "CA", name: "Canada", allowed: true, law: "CASL s. 10(9)(b)", stopDays: 10 },
  { code: "GB", name: "United Kingdom", allowed: true, law: "PECR reg. 22", companiesOnly: true, roleOnly: true, stopDays: 10 },
  { code: "AU", name: "Australia", allowed: true, law: "Spam Act 2003, Sch. 2", stopDays: 5 },
  { code: "IE", name: "Ireland", allowed: true, law: "S.I. 336/2011 reg. 13", roleOnly: true, stopDays: 10 },
  { code: "FR", name: "France", allowed: true, law: "CNIL, B2B prospecting", roleOnly: true, stopDays: 10 },
  { code: "SE", name: "Sweden", allowed: true, law: "Marknadsföringslagen 19 §", companiesOnly: true, roleOnly: true, stopDays: 10 },
  { code: "DE", name: "Germany", allowed: false, why: NEEDS_CONSENT, law: "UWG §7", stopDays: 0 },
  { code: "NL", name: "Netherlands", allowed: false, why: NEEDS_CONSENT, law: "Telecommunicatiewet art. 11.7", stopDays: 0 },
  { code: "ES", name: "Spain", allowed: false, why: NEEDS_CONSENT, law: "LSSI art. 21", stopDays: 0 },
  { code: "IT", name: "Italy", allowed: false, why: NEEDS_CONSENT, law: "Codice privacy art. 130", stopDays: 0 },
  { code: "PL", name: "Poland", allowed: false, why: NEEDS_CONSENT, law: "PKE art. 398", stopDays: 0 },
];

/** A country's name as a sentence carries it: "the United States", "Canada". */
export function countryWords(rule: Pick<CountryRule, "code" | "name">): string {
  return rule.code === "US" || rule.code === "GB" || rule.code === "NL" ? `the ${rule.name}` : rule.name;
}

/** The countries that are open, as a sentence lists them. */
export const OPEN_COUNTRIES_WORDS = (() => {
  const names = OUTREACH_COUNTRIES.filter((c) => c.allowed).map(countryWords);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
})();

/** Every other country: not read yet, so not written to. Said as that, not as a refusal of theirs. */
export const OTHER_COUNTRY: CountryRule = {
  code: "ZZ",
  name: "Another country",
  allowed: false,
  why: "We have not read the law there yet, so this cannot be written from here.",
  law: "",
  stopDays: 0,
};

export function countryRule(code: unknown): CountryRule {
  return OUTREACH_COUNTRIES.find((c) => c.code === code) ?? OTHER_COUNTRY;
}

// ---- The address the business published ---------------------------------------

/**
 * The first part of an address that names a job or a desk and not a person.
 * Read as whole words, so "press" is one and "pressley" is not.
 */
const ROLE_WORDS = new Set([
  "partnerships", "partnership", "partners", "partner", "sponsorships", "sponsorship", "sponsors", "sponsor",
  "collabs", "collab", "collaborations", "collaboration", "creators", "creator", "influencers", "influencer",
  "affiliates", "affiliate", "ambassadors", "ambassador", "advertising", "advertise", "ads", "adsales",
  "marketing", "brand", "brands", "media", "press", "pr", "comms", "communications", "bizdev", "business",
  "sales", "wholesale", "trade", "b2b", "enquiries", "enquiry", "inquiries", "inquiry", "hello", "hi", "hey",
  "contact", "contactus", "info", "information", "team", "office", "mail", "email", "general", "admin",
  "support", "help", "care", "customercare", "customerservice", "service", "studio", "shop", "store", "orders",
]);

/** How much an address is the right desk for a first proposal: the higher, the better. */
function deskRank(local: string): number {
  const words = local.split(/[._+-]+/);
  const has = (...names: string[]) => names.some((n) => words.includes(n));
  if (has("partnerships", "partnership", "partners", "partner", "sponsorships", "sponsorship", "sponsors", "sponsor", "collabs", "collab", "collaborations", "creators", "creator", "influencers", "influencer", "affiliates", "affiliate", "ambassadors")) return 5;
  if (has("advertising", "advertise", "ads", "adsales", "marketing", "brand", "brands", "bizdev", "business", "b2b", "wholesale", "trade", "sales")) return 4;
  if (has("press", "media", "pr", "comms", "communications")) return 3;
  if (has("hello", "hi", "hey", "contact", "contactus", "info", "information", "team", "office", "enquiries", "enquiry", "inquiries", "inquiry", "general", "mail", "email", "studio")) return 2;
  return 1;
}

/** Whether an address names a desk (partnerships@) and not a person (jane.doe@). */
export function isRoleAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  const words = local.split(/[._+-]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => ROLE_WORDS.has(w));
}

export type FoundAddress = {
  email: string;
  /** A desk, not a person. */
  role: boolean;
  /** The page of the business's own website it is printed on. */
  page: string;
  /** The words around it on that page, kept as they were read. */
  line: string;
};

const EMAIL = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

/** The site's own name as addresses carry it: www.brand.com and shop.brand.com are brand.com's. */
export function siteDomain(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Whether an address is at the business's own domain, or a part of it. */
export function isOwnAddress(email: string, host: string): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  const site = siteDomain(host);
  return domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
};

/**
 * What a page wrote as &#64;, &#x27; or &amp;, as the character a reader
 * sees: every numbered one, and the named ones a sentence or an address is
 * written with. One pass, so what a page escaped twice stays escaped once.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
  });
}

/** A page's HTML as the words a reader sees, with what a mailto: link points at kept beside it. */
export function pageText(html: string): string {
  const marked = html
    // A script or a style ends where a browser ends it: "</script >" and "</script foo>" too.
    .replace(/<script\b[\s\S]*?(?:<\/script\b[^>]*>|$)/gi, " ")
    .replace(/<style\b[\s\S]*?(?:<\/style\b[^>]*>|$)/gi, " ")
    // A comment ends at "-->" or "--!>", as in a browser.
    .replace(/<!--[\s\S]*?(?:--!?>|$)/g, " ")
    // The whole opening tag gives way to the address, or it would go with the tag.
    .replace(/<a\b[^>]*\bhref\s*=\s*["']mailto:([^"'?]+)[^"']*["'][^>]*>/gi, (_, to: string) => ` ${to.replace(/%40/gi, "@")} `);
  return htmlToPlainText(marked, { gap: " ", decode: decodeEntities }).replace(/\s+/g, " ").trim();
}

/**
 * The business's own addresses printed on one of its pages: at its own
 * domain, each with the words around it, the best desk for a proposal first.
 * An address at somebody else's domain — the agency that built the site, a
 * mail service — is not the business's and is left where it is.
 */
export function publishedAddresses(html: string, page: string, host: string): FoundAddress[] {
  const text = pageText(html);
  const seen = new Map<string, FoundAddress>();
  for (const match of text.matchAll(EMAIL)) {
    const email = match[0].toLowerCase().replace(/\.+$/, "");
    if (seen.has(email) || !isOwnAddress(email, host)) continue;
    // A picture's name can look like an address: logo@2x.png.
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(email)) continue;
    const at = match.index ?? 0;
    const line = text.slice(Math.max(0, at - 90), Math.min(text.length, at + email.length + 90)).trim();
    seen.set(email, { email, role: isRoleAddress(email), page, line });
  }
  const local = (a: FoundAddress) => a.email.slice(0, a.email.lastIndexOf("@"));
  return [...seen.values()].sort((a, b) => deskRank(local(b)) - deskRank(local(a)) || Number(b.role) - Number(a.role));
}

/**
 * Whether a page says, where it prints its address, that it does not want
 * proposals. Canada and Australia make that the end of it in law; here it is
 * the end of it everywhere, because somebody who wrote "no solicitations"
 * beside their address has already answered.
 */
export function refusesProposals(text: string): boolean {
  return /\bno\s+(?:unsolicited|solicitations?|soliciting|sales|marketing|cold)\b|\bdo(?:es)?\s+not\s+(?:accept|respond to|reply to|want|welcome)\s+(?:any\s+)?(?:unsolicited|solicitations?|sales|marketing|cold)\b|\bunsolicited\s+(?:emails?|messages?|proposals?|pitches|offers|sales)\s+(?:are|will)\s+(?:not|be ignored|be deleted)\b|\bplease\s+do\s+not\s+send\s+(?:us\s+)?(?:unsolicited|sales|marketing)\b/i.test(
    text,
  );
}

/** A shop's shelves, its journal and its machinery: never where a business says how to write to it. */
const NOT_A_CONTACT_PAGE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:products?|collections?|blogs?|news|articles?|cart|checkout|account|search|tags?|categor(?:y|ies))(?:\/|$)/i;

/** How likely a link is to lead to where proposals are sent: 4 the desk for them, 3 contact, 2 press, 1 about, 0 neither. */
function contactRank(path: string, text: string): number {
  const last = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (/^(?:partner|sponsor|collab|creator|influencer|affiliate|ambassador|advertis|work-?with)/.test(last) || /\b(?:partner(?:ship)?s?|sponsor(?:ship)?s?|collaborate|collabs?|creators?|influencers?|affiliates?|ambassadors?|advertis(?:e|ing)|work with us)\b/.test(text)) return 4;
  if (/^(?:contact|get-in-touch|reach-us)/.test(last) || /\b(?:contact(?: us)?|get in touch|reach us)\b/.test(text)) return 3;
  if (/^(?:press|media)/.test(last) || /\b(?:press|media)\b/.test(text)) return 2;
  if (/^about/.test(last) || /\babout\b/.test(text)) return 1;
  return 0;
}

/**
 * The pages of a site worth reading for where to write: its own, a few. One
 * of each kind before a second of any — the partners page, the contact page,
 * the press page — so that three links that all say "collaboration" do not
 * crowd out the contact page, which is where most businesses print an address.
 */
export function contactPages(html: string, base: string): string[] {
  const home = new URL(base);
  const found = new Map<string, number>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(match[1], home);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || siteDomain(url.hostname) !== siteDomain(home.hostname)) continue;
    if (NOT_A_CONTACT_PAGE.test(url.pathname)) continue;
    const text = withoutTags(match[2].replace(/<(script|style)\b[\s\S]*?(?:<\/\1\b[^>]*>|$)/gi, " "), " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
    const rank = contactRank(url.pathname.toLowerCase(), text);
    if (rank === 0) continue;
    const key = `${url.origin}${url.pathname}`;
    if (key === `${home.origin}${home.pathname}`) continue;
    if ((found.get(key) ?? 0) < rank) found.set(key, rank);
  }
  const ranked = [...found.entries()].sort((a, b) => b[1] - a[1]);
  const firsts = ranked.filter(([, rank], i) => ranked.findIndex(([, r]) => r === rank) === i);
  const rest = ranked.filter((entry) => !firsts.includes(entry));
  return [...firsts, ...rest].map(([url]) => url).slice(0, MAX_PAGES_READ - 1);
}

/** Pages of one site read for one search, its front page included. */
export const MAX_PAGES_READ = 4;

/** The name this reader answers to in a robots.txt (lib/outreach.ts, READER). */
export const READER_NAME = "MarktmorgenOutreach";

/**
 * What a site's robots.txt asks this reader to stay out of: the Disallow
 * lines of the group that names it ("User-agent: MarktmorgenOutreach"), or,
 * where no group does, of the one addressed to everybody ("User-agent: *").
 * A path that starts with one of these is not read. Allow lines are not
 * weighed against them: when a site says both, it is left alone.
 */
export function robotsDisallows(robots: string): string[] {
  const everybody: string[] = [];
  const ours: string[] = [];
  let named = false;
  let toAll = false;
  let toUs = false;
  let inGroup = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const cut = line.indexOf(":");
    if (cut < 0) continue;
    const field = line.slice(0, cut).trim().toLowerCase();
    const value = line.slice(cut + 1).trim();
    if (field === "user-agent") {
      // Several User-agent lines in a row open one group together.
      if (!inGroup) {
        toAll = false;
        toUs = false;
      }
      inGroup = true;
      if (value === "*") toAll = true;
      if (value.toLowerCase() === READER_NAME.toLowerCase()) {
        toUs = true;
        named = true;
      }
    } else {
      inGroup = false;
      if (field !== "disallow" || !value) continue;
      if (toUs) ours.push(value);
      if (toAll) everybody.push(value);
    }
  }
  return named ? ours : everybody;
}

/**
 * Whether one Disallow rule covers a path, read as robots.txt means it
 * (RFC 9309): the rule is a prefix of the path, "*" stands for any run of
 * characters, and "$" at the end means the path ends there. Shopify's own
 * robots.txt, on every Shopify store, closes the cart under any first
 * folder with a rule that starts "/" and a star: read as a prefix up to its
 * star, that rule would close the whole site, which is not what it says.
 */
function ruleCovers(rule: string, path: string): boolean {
  const toEnd = rule.endsWith("$");
  const parts = (toEnd ? rule.slice(0, -1) : rule).split("*");
  if (!path.startsWith(parts[0])) return false;
  if (parts.length === 1) return !toEnd || path.length === parts[0].length;
  let at = parts[0].length;
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (toEnd && i === parts.length - 1) return path.length - at >= part.length && path.endsWith(part);
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}

/** `path`: the path of the page, with its query when it has one. */
export function robotsAllows(disallows: string[], path: string): boolean {
  return !disallows.some((rule) => rule !== "" && ruleCovers(rule, path));
}

// ---- May this one be written ---------------------------------------------------

export type PitchProblem =
  /** The country's law asks for consent first, or has not been read yet. */
  | "country"
  /** There only a company may be written to, and the creator did not say it is one. */
  | "company"
  /** There only a desk's address may be written to, and this one names a person. */
  | "person"
  /** The page says it does not want proposals. */
  | "refuses"
  /** They asked this creator to stop. */
  | "stopped"
  /** This creator wrote to them too recently. */
  | "recent"
  /** Today's number is used. */
  | "day"
  /** The creator's own name or postal address is missing. */
  | "sender";

/** What each refusal says to the creator. */
export const PITCH_PROBLEMS: Record<PitchProblem, string> = {
  country: "A first email to a business there cannot be written from here.",
  company: "There, only a company may be written to without asking first. Confirm that this is a company, not a sole trader.",
  person: "For that country, pick an address that names a desk, like partnerships@ or hello@, not a person.",
  refuses: "Their page says they do not want proposals, so this one is not written.",
  stopped: "They asked you to stop, so nothing more is written to them.",
  recent: "You wrote to them recently. Give it time before writing again.",
  day: "That is today's number of first emails. More than this in a day is how a mailbox gets marked as spam.",
  sender: "Add your name and your postal address first: the email has to carry both.",
};

/**
 * First emails one store opens in a day. Hunter, which sends from its
 * customers' own mailboxes, starts new senders at fifteen and says why:
 * "higher daily sending volumes typically result in deliverability issues".
 * A mailbox that sends strangers a hundred emails a day stops reaching
 * anybody, the people who asked to hear from it included.
 */
export const PITCHES_PER_DAY = 15;
/** Days before the same business may be written to again by the same store. */
export const REPITCH_DAYS = 180;
/** Pitches a store keeps. The oldest that came to nothing make room. */
export const MAX_PITCHES = 400;

export type Sender = { name: string; address: string };

export const MAX_SENDER_NAME = 60;
export const MAX_SENDER_ADDRESS = 200;

export function cleanSender(raw: { name?: unknown; address?: unknown } | null | undefined): Sender {
  const line = (value: unknown, max: number) => (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);
  return { name: line(raw?.name, MAX_SENDER_NAME), address: line(raw?.address, MAX_SENDER_ADDRESS) };
}

export function pitchProblem(input: {
  country: CountryRule;
  address: Pick<FoundAddress, "role">;
  isCompany: boolean;
  pageRefuses: boolean;
  stopped: boolean;
  lastWrittenAt: number | null;
  sentToday: number;
  sender: Sender;
  now: number;
}): PitchProblem | null {
  if (!input.country.allowed) return "country";
  if (input.stopped) return "stopped";
  if (input.pageRefuses) return "refuses";
  if (input.country.companiesOnly && !input.isCompany) return "company";
  if (input.country.roleOnly && !input.address.role) return "person";
  if (!input.sender.name || !input.sender.address) return "sender";
  if (input.lastWrittenAt !== null && input.now - input.lastWrittenAt < REPITCH_DAYS * 86_400) return "recent";
  if (input.sentToday >= PITCHES_PER_DAY) return "day";
  return null;
}

// ---- What every one of them carries --------------------------------------------

/** The most the creator's own words may run to, so the whole email still opens as a draft. */
export const MAX_PITCH_SUBJECT = 90;
export const MAX_PITCH_BODY = 1_100;

/**
 * The lines under the creator's words, the same on every pitch and not
 * theirs to remove, because each is something a law above asks for:
 *
 *   - who is writing, and where they can be reached by post (CAN-SPAM, CASL,
 *     the Spam Act, PECR: a sender who cannot be identified is the offense);
 *   - where the address came from (GDPR art. 14 and the CNIL ask for the
 *     source; everywhere else it is simply the honest thing to say);
 *   - how to stop it, in one reply or one press on a link that needs
 *     nobody's goodwill to work (every one of them);
 *   - in the United States, that it is a commercial message.
 */
export function pitchFooter(input: { sender: Sender; storeUrl: string; page: string; country: CountryRule; stopUrl: string }): string {
  const lines = [
    input.sender.name,
    input.storeUrl,
    input.sender.address,
    "",
    `I found this address on your website (${input.page}).${input.country.saysCommercial ? " This is a business proposal, sent once." : ""}`,
    `If you would rather not hear from me, reply and say so, or stop it here: ${input.stopUrl}`,
  ];
  return lines.join("\n");
}

/** The key in a pitch's own stop link (lib/outreach.ts): it is the whole key, so it is long and random. */
export const STOP_LINK = /^[0-9a-f]{32}$/;

/** The whole email as it is opened: the creator's words, then the footer. */
export function pitchText(body: string, footer: string): string {
  return `${body.replace(/\r\n?/g, "\n").trim()}\n\n${footer}`;
}

/** As a link carries a line break (RFC 6068): CR LF, percent-encoded with everything else. */
const forLink = (text: string) => encodeURIComponent(text.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));

/** Past this a link stops opening in some browsers and mail programs; the draft is copied instead. */
export const MAX_LINK_CHARS = 7_000;

/**
 * The draft, opened in the creator's own mailbox: Gmail's own compose page,
 * or whatever program the device opens for an email address. Nothing is sent
 * by either: each opens a draft, and the creator presses Send. Null when the
 * email is too long to travel in a link, where the studio offers to copy it.
 */
export function draftLinks(to: string, subject: string, text: string): { gmail: string; mailto: string } | null {
  const query = `su=${forLink(subject)}&body=${forLink(text)}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&${query}`;
  const mailto = `mailto:${encodeURIComponent(to).replace(/%40/g, "@")}?subject=${forLink(subject)}&body=${forLink(text)}`;
  if (gmail.length > MAX_LINK_CHARS || mailto.length > MAX_LINK_CHARS) return null;
  return { gmail, mailto };
}

// ---- What is kept of each -------------------------------------------------------

export type PitchStatus =
  /** Written, not opened to send yet. */
  | "draft"
  /** Opened in the creator's mailbox, and they said they sent it. */
  | "sent"
  | "replied"
  | "deal"
  /** They asked the creator to stop. Kept, so they are never written to again. */
  | "stopped";

export const PITCH_STATUSES: PitchStatus[] = ["draft", "sent", "replied", "deal", "stopped"];

export type Pitch = {
  id: string;
  goal: OutreachGoal;
  /** The business's own domain, which is what a "stop" is kept under. */
  domain: string;
  company: string;
  to: string;
  role: boolean;
  country: string;
  /** Where the address was read, the words around it, and when: the proof it was published. */
  page: string;
  line: string;
  foundAt: number;
  subject: string;
  body: string;
  footer: string;
  /** The key of the link in the footer, by which the business itself can close the door. */
  stop: string;
  status: PitchStatus;
  createdAt: number;
  sentAt: number;
};

export function parsePitch(raw: unknown): Pitch | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Pitch>;
    if (typeof v.id !== "string" || typeof v.domain !== "string" || typeof v.to !== "string") return null;
    const text = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      id: v.id,
      goal: isGoal(v.goal) ? v.goal : "sponsor",
      domain: v.domain,
      company: text(v.company, 120),
      to: v.to,
      role: v.role === true,
      country: text(v.country, 2),
      page: text(v.page, 600),
      line: text(v.line, 400),
      foundAt: num(v.foundAt),
      subject: text(v.subject, MAX_PITCH_SUBJECT),
      body: text(v.body, MAX_PITCH_BODY),
      footer: text(v.footer, 1_000),
      stop: typeof v.stop === "string" && STOP_LINK.test(v.stop) ? v.stop : "",
      status: PITCH_STATUSES.includes(v.status as PitchStatus) ? (v.status as PitchStatus) : "draft",
      createdAt: num(v.createdAt),
      sentAt: num(v.sentAt),
    };
  } catch {
    return null;
  }
}

/**
 * What to expect, said before anybody spends an afternoon on it. First
 * emails between businesses were answered 3.43% of the time on average in
 * 2025 (Instantly's benchmark report, January 2026), and four in five paid
 * collaborations with creators were for under $300 (Collabstr, 2026 report).
 */
export const EXPECTATION =
  "Most first emails get no answer: about 3 or 4 in 100 do, on the published averages, and most sponsorships for small creators pay under $300. A short, specific email to the right business does better than many to everybody.";
