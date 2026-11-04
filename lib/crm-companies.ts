/**
 * Companies as records in the CRM: 639 [GL7](4), unit 1. A company the
 * creator sells to as a team (a school, a business buying seats) has a name,
 * a website and a note, and the people who work there, each linked by the
 * same key their tasks and fields are kept under (lib/person-key.ts), never
 * by their address. A person belongs to one company at most: linking them to
 * another moves them.
 *
 *   nl:crm:co:<statsId>   hash: <company id> -> the company, as JSON
 *   nl:crm:co:lock:<statsId>   held for at most 10 seconds while one change is written
 *
 * One change at a time (the lock): two people saving at once never write
 * over each other, and a person linked to two companies at once is never
 * left in both. The second change is refused ("busy") and writes nothing.
 *
 * Each write takes, or gives back, room in the store's data room first, for
 * what the record grows or shrinks by; what is read back is checked again;
 * a person deleted from the store is taken off every company
 * (forgetCompanyPerson, from forgetCrmPerson in lib/crm.ts).
 */
import { randomBytes } from "node:crypto";
import { crmUrl } from "@/lib/crm-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

export const MAX_COMPANIES = 300;
export const MAX_COMPANY_NAME = 80;
export const MAX_COMPANY_NOTE = 300;
export const MAX_COMPANY_PEOPLE = 50;
export const COMPANY_ID = /^[a-f0-9]{10}$/;
const PERSON = /^[0-9a-f]{32}$/;

export type Company = { id: string; name: string; website: string; note: string; people: string[]; createdAt: number };

export type CompanyRefusal = "name" | "taken" | "website" | "note" | "full" | "people" | "unknown" | "busy";

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
};

export type CompanyResult = { ok: true; companies: Company[] } | { ok: false; error: CompanyRefusal };

/** One line: control characters and runs of spaces made single spaces, trimmed; null when longer than allowed. */
function line(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : null;
}

/** What the creator typed for a company, made safe, or what is wrong with it. Never cut. */
export function readCompanyInput(raw: Record<string, unknown>): { ok: true; value: Pick<Company, "name" | "website" | "note"> } | { ok: false; error: CompanyRefusal } {
  const name = line(raw.name, MAX_COMPANY_NAME);
  if (!name) return { ok: false, error: "name" };
  const typed = line(raw.website, 200);
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

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A new company, last; refused when the name is taken or the store is full. */
export function addCompany(companies: readonly Company[], value: Pick<Company, "name" | "website" | "note">, id: string, nowSeconds: number): CompanyResult {
  if (companies.length >= MAX_COMPANIES) return { ok: false, error: "full" };
  if (companies.some((c) => sameName(c.name, value.name))) return { ok: false, error: "taken" };
  if (!COMPANY_ID.test(id) || companies.some((c) => c.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, companies: [...companies, { id, ...value, people: [], createdAt: Math.floor(nowSeconds) }] };
}

/** A company's name, website and note changed in place; its people stay. */
export function editCompany(companies: readonly Company[], id: string, value: Pick<Company, "name" | "website" | "note">): CompanyResult {
  const at = companies.findIndex((c) => c.id === id);
  if (at < 0) return { ok: false, error: "unknown" };
  if (companies.some((c) => c.id !== id && sameName(c.name, value.name))) return { ok: false, error: "taken" };
  const next = [...companies];
  next[at] = { ...companies[at], ...value };
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

/** The company a person works at, or null. */
export function companyOf(companies: readonly Company[], person: string): Company | null {
  return companies.find((c) => c.people.includes(person)) ?? null;
}

const companiesKey = (statsId: string) => `nl:crm:co:${statsId}`;
const COMPANIES_SLOT = "crm:co";
const lockKey = (statsId: string) => `nl:crm:co:lock:${statsId}`;
const LOCK_SECONDS = 10;

/** The store's companies held for one change, or null when another change holds them. */
async function takeLock(statsId: string): Promise<string | null> {
  const token = randomBytes(12).toString("hex");
  const [claimed] = await redisPipeline([["SET", lockKey(statsId), token, "NX", "EX", LOCK_SECONDS]]);
  return claimed === "OK" ? token : null;
}

async function letGo(statsId: string, token: string): Promise<void> {
  const [held] = await redisPipeline([["GET", lockKey(statsId)]]).catch(() => [null]);
  if (held === token) await redisPipeline([["DEL", lockKey(statsId)]]).catch(() => {});
}
const MAX_STORED_COMPANY = (MAX_COMPANY_NAME + 200 + MAX_COMPANY_NOTE) * 6 + MAX_COMPANY_PEOPLE * 35 + 256;

/** Every company of the store, oldest first; none when they cannot be read. */
export async function readCompanies(statsId: string | null): Promise<Company[]> {
  if (!statsId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["HGETALL", companiesKey(statsId)]]);
  const values: unknown[] = Array.isArray(raw) ? raw.filter((_, i) => i % 2 === 1) : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : [];
  const out: Company[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.length > MAX_STORED_COMPANY) continue;
    try {
      const company = parseCompany(JSON.parse(value));
      if (company) out.push(company);
    } catch {
      // A record that cannot be read is left out, never guessed.
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, MAX_COMPANIES);
}

/**
 * Writes what changed between the companies read and the result: each
 * company changed is set, each gone is deleted, and the room is taken (or
 * given back) for exactly what the record grew (or shrank) by, before.
 */
async function writeChanges(statsId: string, before: readonly Company[], after: readonly Company[], room: DataStore): Promise<void> {
  const weight = (c: Company | undefined) => (c ? dataBytes([c.id, JSON.stringify(c)], 1) : 0);
  const was = new Map(before.map((c) => [c.id, c]));
  const now = new Map(after.map((c) => [c.id, c]));
  const commands: (string | number)[][] = [];
  let grown = 0;
  for (const company of after) {
    const old = was.get(company.id);
    if (old && JSON.stringify(old) === JSON.stringify(company)) continue;
    grown += weight(company) - weight(old);
    commands.push(["HSET", companiesKey(statsId), company.id, JSON.stringify(company)]);
  }
  for (const company of before) {
    if (now.has(company.id)) continue;
    grown -= weight(company);
    commands.push(["HDEL", companiesKey(statsId), company.id]);
  }
  if (!commands.length) return;
  // Room first: a change that does not fit throws DataRoomError and nothing is written.
  if (grown > 0) await needData(room, [{ slot: COMPANIES_SLOT, bytes: grown }]);
  await redisPipeline(commands);
  if (grown < 0) await giveData(room, [{ slot: COMPANIES_SLOT, bytes: -grown }]);
}

/**
 * Reads the companies, applies the change, and writes what it changed, all
 * under the lock; a refusal writes nothing, and so does a change while
 * another is being written ("busy").
 */
export async function changeCompanies(statsId: string, room: DataStore, change: (companies: Company[]) => CompanyResult): Promise<CompanyResult> {
  const token = await takeLock(statsId);
  if (!token) return { ok: false, error: "busy" };
  try {
    const before = await readCompanies(statsId);
    const result = change(before);
    if (result.ok) await writeChanges(statsId, before, result.companies, room);
    return result;
  } finally {
    await letGo(statsId, token);
  }
}

/** A company id made by the store (COMPANY_ID): ten lowercase hex characters. */
export const newCompanyId = () => randomBytes(5).toString("hex");

/**
 * A person deleted from the store taken off every company; how many
 * companies changed. A deletion is never skipped: it waits for a change
 * being written (up to the lock's own 10 seconds) and throws when it still
 * cannot take the lock, so the deletion is reported as not done.
 */
export async function forgetCompanyPerson(statsId: string | null, person: string, waitMs = LOCK_SECONDS * 1_000): Promise<number> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return 0;
  let token = await takeLock(statsId);
  for (let waited = 0; !token && waited < waitMs; waited += 250) {
    await new Promise((done) => setTimeout(done, 250));
    token = await takeLock(statsId);
  }
  if (!token) throw new Error("companies busy: the person could not be taken off them");
  try {
    const before = await readCompanies(statsId);
    const after = unlinkPerson(before, person);
    const changed = after.filter((c, i) => c.people.length !== before[i].people.length);
    if (!changed.length) return 0;
    await redisPipeline(changed.map((c) => ["HSET", companiesKey(statsId), c.id, JSON.stringify(c)]));
    return changed.length;
  } finally {
    await letGo(statsId, token);
  }
}
