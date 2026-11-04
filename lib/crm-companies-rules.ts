/**
 * The rules of companies as records in the CRM (639 [GL7](4)), shared by the
 * studio's screen and the server (lib/crm-companies.ts). Browser-safe.
 */
import { crmUrl } from "@/lib/crm-rules";

export const MAX_COMPANIES = 300;
export const MAX_COMPANY_NAME = 80;
export const MAX_COMPANY_NOTE = 300;
export const MAX_COMPANY_PEOPLE = 50;
export const COMPANY_ID = /^[a-f0-9]{10}$/;
export const PERSON_KEY = /^[0-9a-f]{32}$/;
const PERSON = PERSON_KEY;

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
