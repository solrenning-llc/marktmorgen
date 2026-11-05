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
 * (one slot, moved by what each change grows or shrinks the hash by, read
 * from the records as they are, unreadable ones included): taken first when
 * a change grows it, given back when its lock was lost and nothing landed,
 * and after a change or a deletion that shrinks it. A write that fails
 * without saying whether it landed keeps what it took: the room may count a
 * little more than is kept, never less, and the change is answered
 * "unconfirmed", never "saved" (Codex G2, #2574: only Redis's exact 1 is
 * written, only its exact 0 is nothing written). What is read back is checked
 * again, and only Redis's own answers count: a reply that is not one, whole,
 * is CompaniesUnreadable, never "no companies";
 * a person deleted from the store is taken off every company
 * (forgetCompanyPerson, from forgetCrmPerson in lib/crm.ts).
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { type DataStore, giveData, needData } from "@/lib/store-data";
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

/**
 * The store's companies could not be read: Redis's reply was not one whole
 * answer (Codex G2, #2574). Never taken for "no companies": a page, a copy of
 * a person's data or a deletion that meets it fails instead of saying none.
 */
export class CompaniesUnreadable extends Error {
  constructor(what: string) {
    super(`the store's companies could not be read (${what})`);
    this.name = "CompaniesUnreadable";
  }
}

/** The one reply to one command, or CompaniesUnreadable when Redis did not answer with exactly one. */
async function oneReply(command: (string | number)[]): Promise<unknown> {
  const reply = await redisPipeline([command]);
  if (!Array.isArray(reply) || reply.length !== 1) throw new CompaniesUnreadable(String(command[0]));
  return reply[0];
}

/** The hash's (field, record) pairs: a flat list of texts, an even number of them; an empty one when there is no hash. */
function pairsOf(raw: unknown): [string, string][] {
  if (Array.isArray(raw) && raw.length % 2 === 0 && raw.every((x) => typeof x === "string")) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i] as string, raw[i + 1] as string]);
    return pairs;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.values(raw).every((x) => typeof x === "string")) return Object.entries(raw as Record<string, string>);
  throw new CompaniesUnreadable("HGETALL");
}

async function readStored(statsId: string): Promise<Stored> {
  const pairs = pairsOf(await oneReply(["HGETALL", companiesKey(statsId)]));
  const companies: Company[] = [];
  const weights = new Map<string, number>();
  for (const [id, value] of pairs) {
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

/** The ids of the records kept that cannot be read as companies (round 3, L3). */
const unreadableOf = (stored: Stored) => {
  const read = new Set(stored.companies.map((c) => c.id));
  return [...stored.weights.keys()].filter((id) => !read.has(id)).sort();
};

/**
 * How many records the store's companies hash holds (one HLEN), so a page with
 * none reads and counts nothing more. CompaniesUnreadable when Redis's answer
 * is not one whole number: an unknown count is never none (Codex G2, #2574).
 */
export async function companiesKept(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const n = await oneReply(["HLEN", companiesKey(statsId)]);
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new CompaniesUnreadable("HLEN");
  return n;
}

/** Every company of the store, oldest first; CompaniesUnreadable when Redis's answer is not one whole reply. */
export async function readCompanies(statsId: string | null): Promise<Company[]> {
  if (!statsId || !isRedisConfigured()) return [];
  return (await readStored(statsId)).companies;
}

/**
 * Every company of the store, and the ids of the records kept that cannot be
 * read as one: they still take a place among MAX_COMPANIES and room in the
 * store, so the creator is shown them and can delete them.
 */
export async function readCompaniesAndUnreadable(statsId: string | null): Promise<{ companies: Company[]; unreadable: string[] }> {
  if (!statsId || !isRedisConfigured()) return { companies: [], unreadable: [] };
  const stored = await readStored(statsId);
  return { companies: stored.companies, unreadable: unreadableOf(stored) };
}

const total = (weights: Map<string, number>) => [...weights.values()].reduce((sum, n) => sum + n, 0);

/**
 * Writes what changed between the companies read and the result, only while
 * `held` is still this change's lock: each company changed is set, each gone
 * is deleted. The room's slot changes by what the hash grows or shrinks by:
 * taken first when it grows (DataRoomError when it does not fit, and nothing
 * is written), given back when the lock was lost and nothing was written, or
 * after a written change that shrank it. "written" on Redis's exact 1;
 * "refused" (the lock was lost, nothing written) on its exact 0; anything
 * else is "unconfirmed": it may have landed, so the room it took stays taken.
 */
async function writeChanges(statsId: string, held: Held, stored: Stored, after: readonly Company[], room: DataStore | null, drop: readonly string[] = []): Promise<"written" | "refused" | "unconfirmed"> {
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
  // Unreadable records deleted with the change (round 3, L3): only ones that are there, and never a company read.
  for (const id of drop) {
    if (!weights.has(id) || was.has(id) || now.has(id)) continue;
    weights.delete(id);
    pairs.push(id, "");
  }
  if (!pairs.length) return "written";
  // What the change grows (or shrinks) the hash by, against what every record in it weighs as read under the lock.
  const grown = total(weights) - total(stored.weights);
  const slot = (bytes: number) => [{ slot: COMPANIES_SLOT, bytes }];
  // Room first, by what it grows: a change that does not fit throws DataRoomError and nothing is written.
  if (room && grown > 0) await needData(room, slot(grown));
  // A write that throws may or may not have landed: the room it took stays taken (never less than what is kept).
  const reply = await redisPipeline([["EVAL", WRITE_COMPANIES, 2, lockKey(statsId), companiesKey(statsId), held.token, ...pairs]]);
  // Only Redis's own answer to the one script counts (Codex G2, #2574): exactly 1 written, exactly 0 nothing written.
  const answer = Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
  const outcome = answer === 1 ? "written" : answer === 0 ? "refused" : "unconfirmed";
  // Given back by difference, never set to a total read outside the lock, so another change's own room is never
  // undone: what a change that certainly did not land took (the lock was lost), or what a written one shrank by.
  if (room && outcome === "refused" && grown > 0) await giveData(room, slot(grown));
  if (room && outcome === "written" && grown < 0) await giveData(room, slot(-grown));
  return outcome;
}

/**
 * Reads the companies, applies the change, and writes what it changed, all
 * under the lock; a refusal writes nothing, and so does a change while
 * another is being written ("busy"), or one whose lock ran out before its
 * write landed ("busy"); a write Redis did not answer exactly is
 * "unconfirmed", and the room it took stays taken.
 */
/** A change asked of the companies: given them and the ids of the unreadable records; it may delete some of those (`drop`). */
export type CompanyChange = (companies: Company[], unreadable: readonly string[]) => CompanyResult | { ok: true; companies: Company[]; drop: string[] };

export async function changeCompanies(statsId: string, room: DataStore, change: CompanyChange): Promise<CompanyResult> {
  let held: Held;
  try {
    held = await takeLock(lockKey(statsId), LOCK_SECONDS, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, error: "busy" };
    throw error;
  }
  try {
    const stored = await readStored(statsId);
    const unreadable = unreadableOf(stored);
    const asked = change(stored.companies, unreadable);
    if (!asked.ok) return asked;
    const drop = "drop" in asked ? asked.drop : [];
    // An unreadable record still takes its place: a change that adds a company counts them (round 3, L3).
    const left = unreadable.filter((id) => !drop.includes(id)).length;
    if (asked.companies.length > stored.companies.length && asked.companies.length + left > MAX_COMPANIES) return { ok: false, error: "full" };
    const outcome = await writeChanges(statsId, held, stored, asked.companies, room, drop);
    if (outcome !== "written") return { ok: false, error: outcome === "refused" ? "busy" : "unconfirmed" };
    return { ok: true, companies: asked.companies };
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
    const outcome = await writeChanges(statsId, held, stored, after, room);
    if (outcome !== "written") throw new Error(`companies ${outcome === "refused" ? "busy" : "unconfirmed"}: the person could not be taken off them`);
    return changed.length;
  } finally {
    await releaseLock(held);
  }
}
