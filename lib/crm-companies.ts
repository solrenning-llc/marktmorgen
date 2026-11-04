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
 * The write itself lands only while the lock still holds this change's token
 * (WRITE_COMPANIES, one step in Redis): a change held up past the lock's 10
 * seconds, while another went through, is refused ("busy") instead of
 * writing back what it read over the newer one.
 *
 * The store's data room counts what the companies weigh as they are kept
 * (one slot, set to the weight of every record in the hash): taken first
 * when a change grows it, set back when the write did not land, and set down
 * after a change or a deletion that shrinks it. What is read back is checked
 * again; a person deleted from the store is taken off every company
 * (forgetCompanyPerson, from forgetCrmPerson in lib/crm.ts).
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { type DataStore, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type Company, type CompanyResult, MAX_COMPANIES, MAX_COMPANY_NAME, MAX_COMPANY_NOTE, MAX_COMPANY_PEOPLE, PERSON_KEY, parseCompany, unlinkPerson } from "@/lib/crm-companies-rules";

export * from "@/lib/crm-companies-rules";

const PERSON = PERSON_KEY;

const companiesKey = (statsId: string) => `nl:crm:co:${statsId}`;
const COMPANIES_SLOT = "crm:co";
const lockKey = (statsId: string) => `nl:crm:co:lock:${statsId}`;
const LOCK_SECONDS = 10;

/**
 * KEYS[1] the companies' lock, KEYS[2] their hash; ARGV[1] the token of the
 * change that took the lock, then (company id, record) two at a time, an
 * empty record deleting it. Writes only while the lock holds that token:
 * 1 when written, 0 (nothing written) when the lock ran out or went to
 * another change.
 */
export const WRITE_COMPANIES = `-- marktmorgen:crm-companies-write:v1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
for i = 2, #ARGV, 2 do
  if ARGV[i + 1] == "" then redis.call("HDEL", KEYS[2], ARGV[i]) else redis.call("HSET", KEYS[2], ARGV[i], ARGV[i + 1]) end
end
return 1`;

const MAX_STORED_COMPANY = (MAX_COMPANY_NAME + 200 + MAX_COMPANY_NOTE) * 6 + MAX_COMPANY_PEOPLE * 35 + 256;

/** What the store keeps: its companies, read and checked, and what every record in the hash weighs, read or not. */
type Stored = { companies: Company[]; weights: Map<string, number> };

const weightOf = (id: string, record: string) => dataBytes([id, record], 1);

async function readStored(statsId: string): Promise<Stored> {
  const [raw] = await redisPipeline([["HGETALL", companiesKey(statsId)]]);
  const pairs: [string, unknown][] = [];
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([String(raw[i]), raw[i + 1]]);
  else if (raw && typeof raw === "object") pairs.push(...Object.entries(raw as Record<string, unknown>));
  const companies: Company[] = [];
  const weights = new Map<string, number>();
  for (const [id, value] of pairs) {
    if (typeof value !== "string") continue;
    weights.set(id, weightOf(id, value));
    if (value.length > MAX_STORED_COMPANY) continue;
    try {
      const company = parseCompany(JSON.parse(value));
      if (company && company.id === id) companies.push(company);
    } catch {
      // A record that cannot be read is left out, never guessed; it is still counted for what it weighs.
    }
  }
  return { companies: companies.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, MAX_COMPANIES), weights };
}

/** Every company of the store, oldest first; none when they cannot be read. */
export async function readCompanies(statsId: string | null): Promise<Company[]> {
  if (!statsId || !isRedisConfigured()) return [];
  return (await readStored(statsId)).companies;
}

const total = (weights: Map<string, number>) => [...weights.values()].reduce((sum, n) => sum + n, 0);

/**
 * Writes what changed between the companies read and the result, only while
 * `held` is still this change's lock: each company changed is set, each gone
 * is deleted. The room's slot is set to what the hash weighs after the
 * change, taken first when that is more (DataRoomError when it does not fit,
 * and nothing is written), and set to what it weighs when the write did not
 * land. False when the lock was lost and nothing was written.
 */
async function writeChanges(statsId: string, held: Held, stored: Stored, after: readonly Company[], room: DataStore | null): Promise<boolean> {
  const was = new Map(stored.companies.map((c) => [c.id, c]));
  const now = new Map(after.map((c) => [c.id, c]));
  const weights = new Map(stored.weights);
  const pairs: string[] = [];
  for (const company of after) {
    const old = was.get(company.id);
    const record = JSON.stringify(company);
    if (old && JSON.stringify(old) === record) continue;
    weights.set(company.id, weightOf(company.id, record));
    pairs.push(company.id, record);
  }
  for (const company of stored.companies) {
    if (now.has(company.id)) continue;
    weights.delete(company.id);
    pairs.push(company.id, "");
  }
  if (!pairs.length) return true;
  const before = total(stored.weights);
  const next = total(weights);
  const slot = (bytes: number) => [{ slot: COMPANIES_SLOT, bytes, set: true }];
  // Room first: a change that does not fit throws DataRoomError and nothing is written.
  if (room && next > before) await needData(room, slot(next));
  let written = false;
  try {
    const [reply] = await redisPipeline([["EVAL", WRITE_COMPANIES, 2, lockKey(statsId), companiesKey(statsId), held.token, ...pairs]]);
    written = reply === 1;
  } finally {
    // Counted as kept: the new weight once written (taken already when it grew). When nothing landed (a lost
    // lock, a failed write), what the hash weighs now, read again, since another change may have written in
    // between; when even that cannot be read, the room taken stays taken until the next change counts it, never
    // less than what is kept.
    if (room && written && next < before) await noteData(room, slot(next));
    else if (room && !written && next > before) {
      const now = await readStored(statsId).catch(() => null);
      if (now) await noteData(room, slot(total(now.weights)));
    }
  }
  return written;
}

/**
 * Reads the companies, applies the change, and writes what it changed, all
 * under the lock; a refusal writes nothing, and so does a change while
 * another is being written ("busy"), or one whose lock ran out before its
 * write landed ("busy").
 */
export async function changeCompanies(statsId: string, room: DataStore, change: (companies: Company[]) => CompanyResult): Promise<CompanyResult> {
  let held: Held;
  try {
    held = await takeLock(lockKey(statsId), LOCK_SECONDS, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, error: "busy" };
    throw error;
  }
  try {
    const stored = await readStored(statsId);
    const result = change(stored.companies);
    if (result.ok && !(await writeChanges(statsId, held, stored, result.companies, room))) return { ok: false, error: "busy" };
    return result;
  } finally {
    await releaseLock(held);
  }
}

/** A company id made by the store (COMPANY_ID): ten lowercase hex characters. */
export const newCompanyId = () => randomBytes(5).toString("hex");

/**
 * A person deleted from the store taken off every company; how many
 * companies changed, with the room they took given back when the store's
 * `room` is known. A deletion is never skipped: it waits for a change being
 * written (up to the lock's own 10 seconds) and throws when it still cannot
 * take the lock, or lost it before its write landed, so the deletion is
 * reported as not done.
 */
export async function forgetCompanyPerson(statsId: string | null, person: string, waitMs = LOCK_SECONDS * 1_000, room: DataStore | null = null): Promise<number> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return 0;
  let held: Held;
  try {
    held = await takeLock(lockKey(statsId), LOCK_SECONDS, waitMs);
  } catch (error) {
    if (error instanceof LockBusyError) throw new Error("companies busy: the person could not be taken off them");
    throw error;
  }
  try {
    const stored = await readStored(statsId);
    const after = unlinkPerson(stored.companies, person);
    const changed = after.filter((c, i) => c.people.length !== stored.companies[i].people.length);
    if (!changed.length) return 0;
    if (!(await writeChanges(statsId, held, stored, after, room))) throw new Error("companies busy: the person could not be taken off them");
    return changed.length;
  } finally {
    await releaseLock(held);
  }
}
