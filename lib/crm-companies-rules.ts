/**
 * The rules of companies as records in the CRM (639 [GL7](4)), shared by the
 * studio's screen and the server (lib/crm-companies.ts). Browser-safe.
 */
import { crmUrl } from "@/lib/crm-rules";
import { PAGE_INCLUDED_BYTES, sentBytes, sentUnits } from "@/lib/sent-bytes";

export const MAX_COMPANIES = 300;
export const MAX_COMPANY_NAME = 80;
export const MAX_COMPANY_NOTE = 300;
export const MAX_COMPANY_PEOPLE = 50;
export const COMPANY_ID = /^[a-f0-9]{10}$/;
export const PERSON_KEY = /^[0-9a-f]{32}$/;
/** A company's website address, at most this many characters as typed. */
export const MAX_COMPANY_WEBSITE = 200;
/**
 * The most one company's record weighs as kept, in bytes: its name and note
 * at three bytes a character at most (a character outside the Basic
 * Multilingual Plane is two characters of four bytes; a quote escaped is
 * two), its website as the browser writes it (ASCII), its people's keys
 * quoted, and its id, date and field names.
 */
export const MAX_COMPANY_RECORD_BYTES = 3 * (MAX_COMPANY_NAME + MAX_COMPANY_NOTE) + MAX_COMPANY_WEBSITE + MAX_COMPANY_PEOPLE * 35 + 256;
/** The most a store's companies weigh, every record and its id: what reading them all moves at the most. */
export const MAX_COMPANIES_BYTES = MAX_COMPANIES * (MAX_COMPANY_RECORD_BYTES + 10);
/**
 * Studio requests reading `kept` company records costs beyond the page or
 * request that asked (round 5, M1): each at the most a record weighs, none
 * within the request's own fifty kilobytes (PAGE_INCLUDED_BYTES), then one a
 * megabyte (tests/plan-cost-registry.ts, COMPANIES_PAGE_READ). `kept` is the
 * hash's length (one HLEN), and one more for the record a change may add.
 */
export function companiesReadUnits(kept: number): number {
  const bytes = Math.min(Math.max(0, kept), MAX_COMPANIES + 1) * (MAX_COMPANY_RECORD_BYTES + 10);
  return bytes <= PAGE_INCLUDED_BYTES ? 0 : Math.ceil(bytes / 1_000_000);
}
/**
 * Studio requests a companies request counts beyond its own: every company
 * read (companiesReadUnits), and every company sent back in its answer, as
 * JSON, at the most each weighs.
 */
export function companiesRequestUnits(kept: number): number {
  return companiesReadUnits(kept + 1) + sentUnits(Math.min(Math.max(0, kept + 1), MAX_COMPANIES) * MAX_COMPANY_RECORD_BYTES);
}
/** The most a companies request counts, its own included: held against COMPANIES_REQUEST in tests/plan-cost-registry.ts. */
export const COMPANIES_REQUEST_UNITS = 1 + companiesRequestUnits(MAX_COMPANIES);
/** The most a page's reading of every company counts: held against COMPANIES_PAGE_READ. */
export const COMPANIES_READ_UNITS = companiesReadUnits(MAX_COMPANIES);
export { PAGE_INCLUDED_BYTES, STUDIO_UNIT_SENT_BYTES, htmlBytes, sentBytes, sentUnits } from "@/lib/sent-bytes";
/** The page's own markup around one company (its heading, buttons and lines), in bytes at the most. */
export const COMPANY_MARKUP_BYTES = 1_500;
/** A person's page's own markup around one company it offers to choose (an option), in bytes at the most. */
export const COMPANY_OPTION_MARKUP_BYTES = 150;
/** The page's own markup around one person at a company (their line, link and button), in bytes at the most. */
export const COMPANY_PERSON_MARKUP_BYTES = 250;
/**
 * The most bytes one byte of the records' JSON becomes on its way to the
 * browser (round 4, M1): written in the page as text (an "&" is "&amp;", five
 * bytes) and again in what React reads to take it over, a JSON string inside
 * the page whose "<", ">" and "&" are written as six-byte \u escapes, a quote
 * as two. Used for the worst case in tests/plan-cost-registry.ts.
 */
export const SENT_TIMES = 12;

/**
 * Studio requests what a page sends on costs beyond its own, counted before
 * it is drawn: the records it shows (`json`) as Next sends them (sentBytes),
 * and its own markup around them; none within PAGE_INCLUDED_BYTES.
 */
export function companiesSentUnits(json: string, markupBytes: number): number {
  return sentUnits(sentBytes(json) + Math.max(0, markupBytes));
}
const PERSON = PERSON_KEY;

export type Company = { id: string; name: string; website: string; note: string; people: string[]; createdAt: number };

export type CompanyRefusal = "name" | "taken" | "website" | "note" | "full" | "people" | "unknown" | "busy" | "unconfirmed";

/** What each refusal tells the creator, in plain words, with what to do. */
export const COMPANY_REFUSALS: Record<CompanyRefusal, string> = {
  name: `Type the company's name, up to ${MAX_COMPANY_NAME} characters.`,
  taken: "You already have a company with that name. Open it instead, or give this one another name.",
  website: "Type the website's whole address, like https://example.com, or leave it empty.",
  note: `Keep the note to ${MAX_COMPANY_NOTE} characters.`,
  full: `Your store has ${MAX_COMPANIES} companies, the most it can keep. Delete one you no longer need first.`,
  people: `A company can have up to ${MAX_COMPANY_PEOPLE} people. Take someone off it first.`,
  unknown: "That company is no longer there. Reload the page.",
  busy: "Someone else is changing your companies right now. Try again in a moment.",
  unconfirmed: "That change may not have been saved. Reload the page to see your companies as they are, then try again if it is not there.",
};

export type CompanyResult = { ok: true; companies: Company[] } | { ok: false; error: CompanyRefusal };

/**
 * Characters that change how the text around them is drawn without being
 * seen: the bidirectional embeddings, overrides and isolates (a name that
 * reads backwards from where it is shown, Unicode Technical Report 36), the
 * byte order mark, the invisible "function" signs, the soft hyphen, the
 * zero-width space and the direction marks U+200E and U+200F: one rule with
 * the tasks' words (lib/person-tasks.ts) and lib/sequence-import.ts (round 4,
 * L6). The joiners (U+200C, U+200D) that some scripts and emoji need stay.
 */
const UNSEEN = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * One line: control characters (C0 and C1) and runs of spaces made single
 * spaces, the unseen formatting signs taken out, half a character pair (a
 * lone surrogate, never typed) shown as U+FFFD, in the composed form (NFC) so
 * a name typed with an accent as one character or as two is the same text;
 * trimmed; null when longer than allowed.
 */
function line(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const value = raw.replace(LONE_SURROGATE, "\ufffd").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(UNSEEN, "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : null;
}

/**
 * True when the text has a character that is drawn: not only spaces,
 * joiners, marks or fillers. Private-use characters count as not drawn, so a
 * name of only those (a font's own icons) is refused.
 */
const seen = (value: string) => /[^\s\p{C}\p{M}\u115f\u1160\u3164\uffa0\u2800]/u.test(value);

/**
 * What a company's name is compared by, so one name is kept once: the
 * compatibility form (NFKC: wide letters are the usual ones), without the
 * signs that are not drawn (a zero-width space), and with case folded fully
 * (sharp s is "ss", a final sigma is a sigma). Names that only look alike
 * across scripts (a Cyrillic "а" for a Latin "a") are not merged: a warning
 * on a name that mixes scripts is left for later (round 4, L2, noted).
 */
export function companyNameKey(name: string): string {
  // Fillers drawn as blank are a space; every sign Unicode says to ignore when drawing (zero-width signs, the
  // combining grapheme joiner, variation selectors, tags) is taken out, so a name never differs only by them.
  const plain = name.normalize("NFKC").replace(/[\u115f\u1160\u2800\u3164\uffa0]/g, " ").replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  // Each character folded on its own, as Unicode's full case folding does: the Turkish dotless ı has no folding
  // there and stays itself ("Ilık" and "Ilik" are two names), and İ folds to i with its dot ("İstanbul" and
  // "Istanbul" are two names too), never through the upper case, where ı would become I and then i.
  // The capital sharp S (U+1E9E) folds to "ss" as the small one does.
  return [...plain].map((ch) => (ch === "\u0131" ? ch : ch === "\u1e9e" ? "ss" : ch.toUpperCase().toLowerCase())).join("");
}

/** What the creator typed for a company, made safe, or what is wrong with it. Never cut. */
export function readCompanyInput(raw: Record<string, unknown>): { ok: true; value: Pick<Company, "name" | "website" | "note"> } | { ok: false; error: CompanyRefusal } {
  const name = line(raw.name, MAX_COMPANY_NAME);
  if (!name || !seen(name)) return { ok: false, error: "name" };
  const typed = line(raw.website, MAX_COMPANY_WEBSITE);
  const website = typed ? crmUrl(typed) : "";
  if (typed === null || website === null) return { ok: false, error: "website" };
  const note = line(raw.note, MAX_COMPANY_NOTE);
  if (note === null) return { ok: false, error: "note" };
  return { ok: true, value: { name, website, note } };
}

/** A company as read back, checked again; null when any of it fails. */
export function parseCompany(raw: unknown): Company | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && COMPANY_ID.test(value.id) ? value.id : "";
  const input = readCompanyInput(value);
  const people = Array.isArray(value.people) ? [...new Set(value.people.filter((p): p is string => typeof p === "string" && PERSON.test(p)))].slice(0, MAX_COMPANY_PEOPLE) : [];
  const createdAt = typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt >= 0 ? Math.floor(value.createdAt) : 0;
  return id && input.ok ? { id, ...input.value, people, createdAt } : null;
}

const sameName = (a: string, b: string) => companyNameKey(a) === companyNameKey(b);

/** A new company, last; refused when the name is taken or the store is full. */
export function addCompany(companies: readonly Company[], value: Pick<Company, "name" | "website" | "note">, id: string, nowSeconds: number): CompanyResult {
  if (companies.length >= MAX_COMPANIES) return { ok: false, error: "full" };
  if (companies.some((c) => sameName(c.name, value.name))) return { ok: false, error: "taken" };
  if (!COMPANY_ID.test(id) || companies.some((c) => c.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, companies: [...companies, { id, ...value, people: [], createdAt: Math.floor(nowSeconds) }] };
}

/**
 * A deleted company put back, with its people (the studio's undo): one
 * change, so nobody is linked one at a time. Only the people who are not at
 * another company now come back; someone who moved since stays where they
 * went. `kept`, when given, are the people the store itself kept with the
 * company deleted: nobody else comes back, so a person deleted from the
 * store since, taken out of what was kept, never does (Codex G2, MEDIUM 3 on
 * #2574). `skipped` are those left out.
 */
export function restoreCompany(companies: readonly Company[], value: Pick<Company, "name" | "website" | "note">, id: string, nowSeconds: number, people: readonly unknown[], kept?: readonly string[]): { ok: true; companies: Company[]; skipped: string[] } | { ok: false; error: CompanyRefusal } {
  const added = addCompany(companies, value, id, nowSeconds);
  if (!added.ok) return added;
  const asked = [...new Set(people.filter((p): p is string => typeof p === "string" && PERSON.test(p)))].slice(0, MAX_COMPANY_PEOPLE);
  const back = asked.filter((p) => (!kept || kept.includes(p)) && !companies.some((c) => c.people.includes(p)));
  return { ok: true, companies: added.companies.map((c) => (c.id === id ? { ...c, people: back } : c)), skipped: asked.filter((p) => !back.includes(p)) };
}

/**
 * A company's name, website and note changed in place; its people stay. A
 * website or a note left out of `value` stays as it is (an empty one clears
 * it).
 */
export function editCompany(companies: readonly Company[], id: string, value: Pick<Company, "name"> & Partial<Pick<Company, "website" | "note">>): CompanyResult {
  const at = companies.findIndex((c) => c.id === id);
  if (at < 0) return { ok: false, error: "unknown" };
  // Taken only when the name compared changes: two companies kept before the names were compared this way can still
  // have their website or note changed, or their name written another way.
  if (companyNameKey(value.name) !== companyNameKey(companies[at].name) && companies.some((c) => c.id !== id && sameName(c.name, value.name))) return { ok: false, error: "taken" };
  const next = [...companies];
  const { name, website = companies[at].website, note = companies[at].note } = value;
  next[at] = { ...companies[at], name, website, note };
  return { ok: true, companies: next };
}

/** A company deleted; the people linked to it are not touched, only no longer linked. */
export function dropCompany(companies: readonly Company[], id: string): CompanyResult {
  return companies.some((c) => c.id === id) ? { ok: true, companies: companies.filter((c) => c.id !== id) } : { ok: false, error: "unknown" };
}

/** A person linked to a company, and taken off any other: a person works at one company at most. */
export function linkPerson(companies: readonly Company[], id: string, person: string): CompanyResult {
  const target = companies.find((c) => c.id === id);
  if (!target || !PERSON.test(person)) return { ok: false, error: "unknown" };
  if (!target.people.includes(person) && target.people.length >= MAX_COMPANY_PEOPLE) return { ok: false, error: "people" };
  return {
    ok: true,
    companies: companies.map((c) => (c.id === id ? { ...c, people: c.people.includes(person) ? c.people : [...c.people, person] } : c.people.includes(person) ? { ...c, people: c.people.filter((p) => p !== person) } : c)),
  };
}

/** A person taken off every company. */
export function unlinkPerson(companies: readonly Company[], person: string): Company[] {
  return companies.map((c) => (c.people.includes(person) ? { ...c, people: c.people.filter((p) => p !== person) } : c));
}

/**
 * The companies a person's page sends on: the one they work at whole, and
 * every other by its id and name only (what the choice of a company shows),
 * so the page never sends every company's note and people.
 */
export function companiesForPerson(companies: readonly Company[], person: string): Company[] {
  return companies.map((c) => (c.people.includes(person) ? c : { id: c.id, name: c.name, website: "", note: "", people: [], createdAt: c.createdAt }));
}

/** The company a person works at, or null. */
export function companyOf(companies: readonly Company[], person: string): Company | null {
  return companies.find((c) => c.people.includes(person)) ?? null;
}
