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
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type Company, type CompanyResult, MAX_COMPANIES, MAX_COMPANY_NAME, MAX_COMPANY_NOTE, MAX_COMPANY_PEOPLE, PERSON_KEY, parseCompany, unlinkPerson } from "@/lib/crm-companies-rules";

export * from "@/lib/crm-companies-rules";

const PERSON = PERSON_KEY;

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
