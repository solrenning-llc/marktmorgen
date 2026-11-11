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
 *   nl:crm:co:undo:<statsId>   the last company deleted, as JSON, for a day: what its undo may put back
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
 * (forgetCompanyPerson, its own row of lib/person-erasure.ts).
 *
 * An erased person never comes back by an undo (Codex G2, MEDIUM 3 on
 * #2574). The undo of a deleted company puts back only the people the store
 * itself kept with it (UNDO_SECONDS, one company at a time, the last one
 * deleted), never the ones the page sends back from what it showed: a
 * person's deletion takes them out of what was kept, under the same lock and
 * in the same step as every other write (WRITE_COMPANIES), so an undo whose
 * read came before a deletion is refused ("busy") and one after it no longer
 * has them. Nothing is kept about the person once they are deleted.
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
const undoKey = (statsId: string) => `nl:crm:co:undo:${statsId}`;
/** How long the last company deleted is kept for its undo: a day. */
export const UNDO_SECONDS = 86_400;

/**
 * KEYS[1] the companies' lock, KEYS[2] their hash, KEYS[3] the last company
 * deleted (undoKey); ARGV[1] the token of the change that took the lock,
 * ARGV[2] what becomes of the company deleted ("" as it is, "-" deleted,
 * otherwise that record, kept ARGV[3] seconds, or, when ARGV[3] is "",
 * written over the one kept, only while it is, for the time it has left),
 * then (company id, record) two at a time, an empty record deleting it.
 * Writes only while the lock holds that token: 1 when written, 0 (nothing
 * written) when the lock ran out or went to another change.
 */
export const WRITE_COMPANIES = `-- marktmorgen:crm-companies-write:v2
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
for i = 4, #ARGV, 2 do
  if ARGV[i + 1] == "" then redis.call("HDEL", KEYS[2], ARGV[i]) else redis.call("HSET", KEYS[2], ARGV[i], ARGV[i + 1]) end
end
if ARGV[2] == "-" then
  redis.call("DEL", KEYS[3])
elseif ARGV[2] ~= "" and ARGV[3] == "" then
  redis.call("SET", KEYS[3], ARGV[2], "XX", "KEEPTTL")
elseif ARGV[2] ~= "" then
  redis.call("SET", KEYS[3], ARGV[2], "EX", ARGV[3])
end
return 1`;

const MAX_STORED_COMPANY = (MAX_COMPANY_NAME + 200 + MAX_COMPANY_NOTE) * 6 + MAX_COMPANY_PEOPLE * 35 + 256;

/** What the store keeps: its companies, read and checked, what every record in the hash weighs, read or not, and the text of each record that cannot be read. */
type Stored = { companies: Company[]; weights: Map<string, number>; unreadable: Map<string, string> };

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
  const unreadable = new Map<string, string>();
  for (const [id, value] of pairs) {
    weights.set(id, weightOf(id, value));
    let company: Company | null = null;
    try {
      company = value.length > MAX_STORED_COMPANY ? null : parseCompany(JSON.parse(value));
    } catch {
      company = null;
    }
    // A record that cannot be read is left out of what is shown, never guessed; it is still counted for what it
    // weighs, and its text is kept for the person's deletion and copy, which must never pass over it (Codex G2, #2574).
    if (company && company.id === id) companies.push(company);
    else unreadable.set(id, value);
  }
  return { companies: companies.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, MAX_COMPANIES), weights, unreadable };
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

/** The last company deleted, as kept for its undo: its text, or null when none is kept; CompaniesUnreadable when Redis's answer is not one. */
async function readUndo(statsId: string): Promise<string | null> {
  const raw = await oneReply(["GET", undoKey(statsId)]);
  if (raw !== null && typeof raw !== "string") throw new CompaniesUnreadable("GET");
  return raw;
}

/** The last company deleted, read as a company; null when none is kept or it cannot be read as one. */
function undoCompany(raw: string | null): Company | null {
  if (raw === null || raw.length > MAX_STORED_COMPANY) return null;
  try {
    return parseCompany(JSON.parse(raw));
  } catch {
    return null;
  }
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
 * `undo`: the company deleted to keep for its undo (for UNDO_SECONDS, or,
 * with `undoLeft`, written over the one kept for the time it has left), null
 * to delete what is kept, left out to leave it as it is (outside the room:
 * it goes by itself).
 */
async function writeChanges(statsId: string, held: Held, stored: Stored, after: readonly Company[], room: DataStore | null, drop: readonly string[] = [], rewrite: ReadonlyMap<string, string> = new Map(), undo?: Company | null, undoLeft = false): Promise<"written" | "refused" | "unconfirmed"> {
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
  // Unreadable records written again with a person taken off them (forgetCompanyPerson): only ones that are there.
  for (const [id, record] of rewrite) {
    if (!stored.unreadable.has(id)) continue;
    weights.set(id, weightOf(id, record));
    pairs.push(id, record);
  }
  // Unreadable records deleted with the change (round 3, L3): only ones that are there, and never a company read.
  for (const id of drop) {
    if (!weights.has(id) || was.has(id) || now.has(id)) continue;
    weights.delete(id);
    pairs.push(id, "");
  }
  if (!pairs.length && undo === undefined) return "written";
  // What the change grows (or shrinks) the hash by, against what every record in it weighs as read under the lock.
  const grown = total(weights) - total(stored.weights);
  const slot = (bytes: number) => [{ slot: COMPANIES_SLOT, bytes }];
  // Room first, by what it grows: a change that does not fit throws DataRoomError and nothing is written.
  if (room && grown > 0) await needData(room, slot(grown));
  // A write that throws may or may not have landed: the room it took stays taken (never less than what is kept).
  const kept = undo === undefined ? "" : undo === null ? "-" : JSON.stringify(undo);
  const reply = await redisPipeline([["EVAL", WRITE_COMPANIES, 3, lockKey(statsId), companiesKey(statsId), undoKey(statsId), held.token, kept, undoLeft ? "" : UNDO_SECONDS, ...pairs]]);
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
/**
 * A change asked of the companies: given them, the ids of the unreadable records (it may delete some of those,
 * `drop`) and, when asked for (`readsUndo`), the last company deleted as kept for its undo. A company it deletes
 * is kept for its undo, with its people, in place of the one kept before; it may say otherwise (`undo`: null lets
 * go of the one kept).
 */
export type CompanyChange = (companies: Company[], unreadable: readonly string[], undo: Company | null) => CompanyResult | { ok: true; companies: Company[]; drop?: string[]; undo?: Company | null };

export async function changeCompanies(statsId: string, room: DataStore, change: CompanyChange, readsUndo = false): Promise<CompanyResult> {
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
    const asked = change(stored.companies, unreadable, readsUndo ? undoCompany(await readUndo(statsId)) : null);
    if (!asked.ok) return asked;
    const drop = ("drop" in asked && asked.drop) || [];
    // A company deleted is kept a day for its undo, with its people (the last one, if one change deleted more).
    const now = new Set(asked.companies.map((c) => c.id));
    const deleted = stored.companies.filter((c) => !now.has(c.id)).at(-1);
    const undo = "undo" in asked ? asked.undo : deleted;
    // An unreadable record still takes its place: a change that adds a company counts them (round 3, L3).
    const left = unreadable.filter((id) => !drop.includes(id)).length;
    if (asked.companies.length > stored.companies.length && asked.companies.length + left > MAX_COMPANIES) return { ok: false, error: "full" };
    const outcome = await writeChanges(statsId, held, stored, asked.companies, room, drop, new Map(), undo);
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
    // The company kept for an undo is taken out of them, for the time it has left, or let go of when that cannot be
    // done whole: whatever else, an undo never puts them back, and nothing kept names them.
    const raw = await readUndo(statsId);
    const forgetUndo = raw !== null && namesPerson(raw, person) !== false;
    const kept = forgetUndo ? undoCompany(raw) : null;
    const cleaned = kept ? { ...kept, people: kept.people.filter((p) => p !== person) } : null;
    const undo = cleaned && !holds(cleaned, person) ? cleaned : null;
    const after = unlinkPerson(stored.companies, person);
    const changed = after.filter((c, i) => c.people.length !== stored.companies[i].people.length);
    // A record that cannot be read as a company but names the person (Codex G2, #2574): taken off it when its list
    // of people can be read, everything else in it kept as it is; otherwise the deletion is said not done, never done.
    const rewrite = new Map<string, string>();
    for (const [id, raw] of stored.unreadable) {
      const names = namesPerson(raw, person);
      if (names === false) continue;
      if (names === "unknown") throw new Error("a company record that cannot be read may name the person: the deletion is not done");
      const edited = withoutPerson(raw, person);
      if (edited === null) throw new Error("a company record that cannot be read names the person: the deletion is not done");
      rewrite.set(id, edited);
    }
    if (!changed.length && !rewrite.size && !forgetUndo) return 0;
    const outcome = await writeChanges(statsId, held, stored, after, room, [], rewrite, forgetUndo ? undo : undefined, true);
    if (outcome !== "written") throw new Error(`companies ${outcome === "refused" ? "busy" : "unconfirmed"}: the person could not be taken off them`);
    return changed.length + rewrite.size + (forgetUndo ? 1 : 0);
  } finally {
    await releaseLock(held);
  }
}

/**
 * A record that cannot be read as a company, with `person` taken off its list
 * of people and everything else kept as it was; null when its list of people
 * cannot be read, or the person is still named in it after that.
 */
function withoutPerson(raw: string, person: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.people)) return null;
  const kept = { ...record, people: record.people.filter((p) => p !== person) };
  return holds(kept, person) ? null : JSON.stringify(kept);
}

/** Whether a decoded value holds `person` anywhere: in a text, a key, or anything inside a list or an object. */
function holds(value: unknown, person: string): boolean {
  if (typeof value === "string") return value.includes(person);
  if (Array.isArray(value)) return value.some((item) => holds(item, person));
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => key.includes(person) || holds(item, person));
  return false;
}

/**
 * Whether a record that cannot be read as a company names `person`, read as
 * what it means, never as raw text (Codex G2, #2574: a key written with JSON's
 * escapes is the same key once decoded): JSON is decoded and every text in it
 * is searched. A record that is not even JSON cannot show that the person is
 * absent from it (a part of it may still decode to them), so it is "unknown":
 * the person's deletion is said not done and their copy fails, and the record
 * is kept as it is, for the creator to delete it from the studio.
 */
function namesPerson(raw: string, person: string): boolean | "unknown" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.includes(person) ? true : "unknown";
  }
  return holds(parsed, person);
}

/**
 * The companies a person is linked to, for their copy (lib/person-copy.ts),
 * and the company deleted that is kept for its undo when it lists them
 * (`deleted`): CompaniesUnreadable when a record that cannot be read names
 * them, so their copy is never said complete while it leaves a link out
 * (Codex G2, #2574).
 */
export async function companiesOfPerson(statsId: string | null, person: string): Promise<(Company & { deleted?: true })[]> {
  if (!statsId || !PERSON.test(person) || !isRedisConfigured()) return [];
  const stored = await readStored(statsId);
  if ([...stored.unreadable.values()].some((raw) => namesPerson(raw, person) !== false)) throw new CompaniesUnreadable("a record that cannot be read names this person");
  const linked: (Company & { deleted?: true })[] = stored.companies.filter((c) => c.people.includes(person));
  const raw = await readUndo(statsId);
  if (raw === null || namesPerson(raw, person) === false) return linked;
  const deleted = undoCompany(raw);
  if (!deleted || !deleted.people.includes(person)) throw new CompaniesUnreadable("the company kept for an undo names this person and cannot be read");
  return [...linked, { ...deleted, deleted: true }];
}
