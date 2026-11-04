/**
 * Where proposals and agreements are kept (lib/agreement-rules.ts says what
 * one is), and where a signature is written.
 *
 *   nl:agree:r:<id>              the agreement: who it is for, each version's fingerprint and signature, for KEEP_DAYS from the day it was made
 *   nl:agree:v:<id>:<n>          version n's exact text, lines and fingerprint: written once (SET NX), never changed, kept as long as the agreement
 *   nl:agree:s:<sid>             the store's agreements: id -> when made
 *   nl:agree:p:<sid>:<person>    one person's agreements in the store (lib/person-key.ts), for the cap and for deleting them
 *   nl:agree:lock:<id>           a signature or a new version being written, ten seconds
 *
 * Every byte is counted in the store's data room before it is written
 * (lib/store-data.ts): the record with room for its five signatures when it
 * is made, and each version when it is made, until the day it goes by itself.
 *
 * A signature and a new version take the same lock and read the record
 * again under it, so a signature can only ever land on the version the
 * signer read (its number and fingerprint must still be the latest), and an
 * edit made while someone is signing becomes a new version that needs its
 * own signature. Every other change to the record (what the emails about it
 * write down) is made under the same lock on the record as it is then
 * (changeAgreement), never on one read before an email went: written back
 * as it had been read, it took off a signature or a version given while the
 * email was on its way (docs/security-audit-2026-10-18.md, MM-SA-03). The
 * lock is let go of only by whoever holds it (lib/redis-lock.ts).
 */
import { createHash, createHmac } from "node:crypto";
import { personKey } from "@/lib/person-key";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Held, LockBusyError, releaseLock, takeLock, withLock } from "@/lib/redis-lock";
import { type Store } from "@/lib/store";
import { dataBytes } from "@/lib/store-data-rules";
import { takeData } from "@/lib/store-data";
import { deriveKey } from "@/lib/secret-box";
import { normaliseEmail } from "@/lib/auth";
import { agreementWords } from "@/lib/buyer-words/agreements";
import {
  CONSENT_VERSION,
  ID_PATTERN,
  KEEP_MS,
  MAX_KEPT_AGREEMENTS,
  MAX_PER_PERSON,
  MAX_VERSIONS,
  SIGN_MS,
  type Agreement,
  type AgreementDraft,
  type AgreementVersion,
  type Signature,
  agreementText,
  agreementsAllowed,
  canRevise,
  latestOf,
  newAgreementId,
  parseAgreement,
  parseVersion,
  statusOf,
} from "@/lib/agreement-rules";

const recordKey = (id: string) => `nl:agree:r:${id}`;
const versionKey = (id: string, n: number) => `nl:agree:v:${id}:${n}`;
const storeKey = (sid: string) => `nl:agree:s:${sid}`;
const personSet = (sid: string, email: string) => `nl:agree:p:${sid}:${personKey(sid, email)}`;
const lockKey = (id: string) => `nl:agree:lock:${id}`;

/** Every key one agreement may have, for the walk that closes a store's records (lib/closed-store-data.ts). */
export function agreementKeys(id: string): string[] {
  return [recordKey(id), ...Array.from({ length: MAX_VERSIONS }, (_, i) => versionKey(id, i + 1))];
}

/** What a record may grow by after it is written: a signature on each version, a reason, the times it was sent. */
export const RECORD_GROWTH_BYTES = 3_072;

/** SHA-256 of a version's exact text, as UTF-8, in hex. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A one-way code made from the signer's internet address: an HMAC under a key
 * derived from the deployment's own secret and this agreement's id, so it can
 * show that two signatures came from the same address without keeping it, and
 * cannot be turned back into it by trying every address. "" when no secret
 * is set (then nothing is recorded, and the record says so).
 */
export function signerIpCode(id: string, ip: string): string {
  const key = deriveKey("agreement-signer-ip");
  if (!key || !ip || ip === "unknown") return "";
  return createHmac("sha256", key).update(`${id}|${ip}`).digest("hex");
}

const keepSeconds = (a: Pick<Agreement, "createdAt">, now: number) => Math.max(60, Math.ceil((a.createdAt + KEEP_MS - now) / 1000));

/** What the record takes from the data room when it is made: itself, its two index entries and room for its signatures. */
export function recordRoomBytes(a: Agreement): number {
  return dataBytes([JSON.stringify(a), a.id, a.id], 3) + RECORD_GROWTH_BYTES;
}

/** What one version takes: its own key, written once. */
export function versionRoomBytes(v: AgreementVersion): number {
  return dataBytes([JSON.stringify(v)], 1);
}

function makeVersion(store: Store, a: Pick<Agreement, "kind" | "email" | "name">, draft: Pick<AgreementDraft, "title" | "body" | "lines" | "total">, n: number, now: number): AgreementVersion {
  const base = { n, title: draft.title, body: draft.body, lines: draft.lines, currency: store.currency, total: draft.total, createdAt: now };
  const text = agreementText({ ...base, kind: a.kind }, { store: store.name, name: a.name, email: a.email }, agreementWords(store.language).text);
  return { ...base, text, sha256: fingerprint(text) };
}

export type Changed =
  | { ok: true; agreement: Agreement; version: AgreementVersion }
  | { ok: false; reason: "closed" | "kept" | "person" | "full" | "busy" | "gone" | "not_now" | "unavailable"; message: string };

const unavailable = (): Changed => ({ ok: false, reason: "unavailable", message: "This can't be saved right now. Try again in a minute." });

/** One agreement and its first version kept, within every count and the data room, before anything is sent. */
export async function createAgreement(store: Store, draft: AgreementDraft, now = Date.now()): Promise<Changed> {
  if (!isRedisConfigured() || !store.sid) return unavailable();
  if (!agreementsAllowed(store, now / 1000)) return { ok: false, reason: "closed", message: "Agreements can be sent while your plan, or free trial, is running." };
  const version = makeVersion(store, draft, draft, 1, now);
  const agreement: Agreement = {
    id: newAgreementId(),
    sid: store.sid,
    kind: draft.kind,
    email: draft.email,
    name: draft.name,
    createdAt: now,
    expiresAt: now + SIGN_MS,
    state: "open",
    versions: [{ n: 1, sha256: version.sha256, title: version.title, createdAt: now, signature: null }],
    sent: [],
    failed: "",
    payRequest: draft.payRequest,
    copies: 0,
    closedAt: 0,
  };
  const person = personSet(store.sid, draft.email);
  try {
    // A person's agreements that are no longer kept leave their count first.
    const membership = await redisPipeline([["SMEMBERS", person]]);
    if (!Array.isArray(membership) || membership.length !== 1 || !Array.isArray(membership[0])) return unavailable();
    const members: unknown[] = membership[0];
    if (new Set(members).size !== members.length || !Array.from(members).every((id) => typeof id === "string" && ID_PATTERN.test(id))) return unavailable();
    const ids = members as string[];
    if (ids.length) {
      const alive = await redisPipeline(ids.map((id) => ["EXISTS", recordKey(id)]));
      if (!Array.isArray(alive) || alive.length !== ids.length || !Array.from(alive).every((value) => value === 0 || value === 1)) return unavailable();
      const gone = ids.filter((_, i) => alive[i] === 0);
      if (gone.length) await redisPipeline([["SREM", person, ...gone]]);
    }
    const keep = Math.ceil(KEEP_MS / 1000);
    const counts = await redisPipeline([
      ["ZREMRANGEBYSCORE", storeKey(store.sid), "-inf", String(now - KEEP_MS)],
      ["ZADD", storeKey(store.sid), String(now), agreement.id],
      ["SADD", person, agreement.id],
      ["ZCARD", storeKey(store.sid)],
      ["SCARD", person],
      ["EXPIRE", storeKey(store.sid), keep],
      ["EXPIRE", person, keep],
    ]);
    // Unknown admission may have changed either index. Retain those references
    // instead of removing memberships we cannot prove this attempt created.
    if (!Array.isArray(counts) || counts.length !== 7) return unavailable();
    const verified = Array.from(counts);
    if (!verified.every((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return unavailable();
    const [kept, mine] = [verified[3], verified[4]];
    if (verified[1] !== 1 || verified[2] !== 1 || kept < 1 || mine < 1 || verified[5] !== 1 || verified[6] !== 1) return unavailable();
    const undo = () => redisPipeline([["ZREM", storeKey(store.sid), agreement.id], ["SREM", person, agreement.id]]).catch(() => undefined);
    if (kept > MAX_KEPT_AGREEMENTS) {
      await undo();
      return { ok: false, reason: "kept", message: `Your store keeps ${MAX_KEPT_AGREEMENTS} agreements at most. Delete some you no longer need.` };
    }
    if (mine > MAX_PER_PERSON) {
      await undo();
      return { ok: false, reason: "person", message: `This person already has ${MAX_PER_PERSON} agreements kept in your store. Delete some you no longer need.` };
    }
    const room = await takeData(store, [{ until: now + KEEP_MS, bytes: recordRoomBytes(agreement) + versionRoomBytes(version) }], now);
    if (!room.ok) {
      await undo();
      return room.reason === "full" ? { ok: false, reason: "full", message: room.message } : unavailable();
    }
    const ttl = keepSeconds(agreement, now);
    const written = await redisPipeline([
      ["SET", versionKey(agreement.id, 1), JSON.stringify(version), "NX", "EX", ttl],
      ["SET", recordKey(agreement.id), JSON.stringify(agreement), "EX", ttl],
    ]);
    // An unknown receipt may still have persisted either record. Keep its
    // indexes and funded data room; never report a verified save or erase it.
    if (!Array.isArray(written) || written.length !== 2 || !Array.from(written).every((value) => value === "OK")) return unavailable();
    return { ok: true, agreement, version };
  } catch (error) {
    console.error("keeping an agreement failed", error);
    return unavailable();
  }
}

/** One agreement by its id, or null. */
export async function readAgreement(id: string): Promise<Agreement | null> {
  if (!ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", recordKey(id)]]);
  if (typeof raw !== "string") return null;
  try {
    return parseAgreement(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** One of this store's agreements, or null: an agreement is only ever found under the store that made it. */
export async function agreementOf(store: Pick<Store, "sid">, id: string): Promise<Agreement | null> {
  const a = await readAgreement(id);
  return a && store.sid && a.sid === store.sid ? a : null;
}

/**
 * One version's exact text, or null. Read back only when the fingerprint of
 * what is stored is still the fingerprint recorded for it, so a page never
 * shows, and nobody signs, a text that is not the one recorded.
 */
export async function readVersion(a: Pick<Agreement, "id" | "versions">, n: number): Promise<AgreementVersion | null> {
  const mark = a.versions.find((m) => m.n === n);
  if (!mark || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", versionKey(a.id, n)]]);
  if (typeof raw !== "string") return null;
  try {
    const v = parseVersion(JSON.parse(raw));
    return v && v.n === n && v.sha256 === mark.sha256 && fingerprint(v.text) === mark.sha256 ? v : null;
  } catch {
    return null;
  }
}

/** Writes the record back as it now is, for the rest of the days it is kept. Versions are never written here. */
export async function saveAgreement(a: Agreement, now = Date.now()): Promise<void> {
  await redisPipeline([["SET", recordKey(a.id), JSON.stringify(a), "EX", keepSeconds(a, now)]]);
}

/** The agreement's lock, taken at once or not at all: null when somebody else holds it. */
async function hold(id: string): Promise<Held | null> {
  try {
    return await takeLock(lockKey(id), 10, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return null;
    throw error;
  }
}
const letGo = (held: Held) => releaseLock(held);

/**
 * Changes one of this store's agreements as it is now, under its lock,
 * waiting up to five seconds for a signature or a new version to finish:
 * `change` is handed the record and returns what it becomes, or null to
 * leave it. Null when the agreement is gone; throws LockBusyError when the
 * lock stayed taken, with nothing written.
 */
export async function changeAgreement(store: Pick<Store, "sid">, id: string, change: (current: Agreement) => Agreement | null, now = Date.now()): Promise<Agreement | null> {
  if (!ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  return withLock(lockKey(id), 10, 5_000, async () => {
    const current = await agreementOf(store, id);
    if (!current) return null;
    const next = change(current);
    if (!next) return current;
    await saveAgreement(next, now);
    return next;
  });
}

/**
 * A new version of an agreement, from what the studio sent: its text is
 * written once under its own key, the earlier versions and their signatures
 * stay as they were, and the link takes a signature for SIGN_DAYS more.
 */
export async function reviseAgreement(store: Store, id: string, draft: AgreementDraft, now = Date.now()): Promise<Changed> {
  if (!isRedisConfigured() || !store.sid) return unavailable();
  const held = await hold(id);
  if (!held) return { ok: false, reason: "busy", message: "Someone is signing it or it is being changed right now. Try again in a moment." };
  try {
    const a = await agreementOf(store, id);
    if (!a) return { ok: false, reason: "gone", message: "That agreement is gone. Reload the page." };
    const may = canRevise(a);
    if (!may.ok) return { ok: false, reason: "not_now", message: may.why };
    const n = (latestOf(a)?.n ?? 0) + 1;
    const version = makeVersion(store, a, draft, n, now);
    // The version's own key, and its title kept in the record's mark of it (the record's growth room is for signatures and sends).
    const room = await takeData(store, [{ until: a.createdAt + KEEP_MS, bytes: versionRoomBytes(version) + dataBytes([version.title], 1) }], now);
    if (!room.ok) return room.reason === "full" ? { ok: false, reason: "full", message: room.message } : unavailable();
    const [written] = await redisPipeline([["SET", versionKey(a.id, n), JSON.stringify(version), "NX", "EX", keepSeconds(a, now)]]);
    // A version's key is written once: never over one already there.
    if (written === null) return unavailable();
    const next: Agreement = {
      ...a,
      versions: [...a.versions, { n, sha256: version.sha256, title: version.title, createdAt: now, signature: null }],
      expiresAt: now + SIGN_MS,
      payRequest: draft.payRequest,
      failed: "",
    };
    await saveAgreement(next, now);
    return { ok: true, agreement: next, version };
  } catch (error) {
    console.error("a new version of an agreement failed", error);
    return unavailable();
  } finally {
    await letGo(held);
  }
}

export type SignInput = { n: number; sha256: string; name: string; email: string; consent: boolean; ip: string };
export type SignRefusal = "name" | "email" | "consent" | "changed" | "closed" | "busy" | "error";
export type Signed = { ok: true; agreement: Agreement; version: AgreementVersion; signature: Signature } | { ok: false; reason: SignRefusal };

/**
 * A signature, by the person it was sent to, on the version they read: the
 * address they type must be the one it was sent to, the version they read
 * must still be the latest and unsigned, its fingerprint must match what is
 * stored, and the consent box must be checked. Written once.
 */
export async function signAgreement(store: Store, id: string, input: SignInput, name: string | null, now = Date.now()): Promise<Signed> {
  if (!name) return { ok: false, reason: "name" };
  if (input.consent !== true) return { ok: false, reason: "consent" };
  if (!isRedisConfigured() || !store.sid) return { ok: false, reason: "error" };
  const held = await hold(id);
  if (!held) return { ok: false, reason: "busy" };
  try {
    const a = await agreementOf(store, id);
    if (!a || statusOf(a, now) !== "open") return { ok: false, reason: "closed" };
    if (normaliseEmail(input.email) !== normaliseEmail(a.email)) return { ok: false, reason: "email" };
    const latest = latestOf(a);
    if (!latest || latest.n !== input.n || latest.sha256 !== input.sha256 || latest.signature) return { ok: false, reason: "changed" };
    const version = await readVersion(a, latest.n);
    if (!version) return { ok: false, reason: "error" };
    const words = agreementWords(store.language);
    const signature: Signature = { name, at: now, ipHash: signerIpCode(a.id, input.ip), consent: words.consent, consentVersion: CONSENT_VERSION, sha256: version.sha256 };
    const next: Agreement = { ...a, versions: a.versions.map((m) => (m.n === latest.n ? { ...m, signature } : m)), closedAt: now };
    await saveAgreement(next, now);
    return { ok: true, agreement: next, version, signature };
  } catch (error) {
    console.error("signing an agreement failed", error);
    return { ok: false, reason: "error" };
  } finally {
    await letGo(held);
  }
}

/** The store's agreements, newest first; null when they cannot be read. */
export async function listAgreements(store: Store): Promise<Agreement[] | null> {
  if (!isRedisConfigured() || !store.sid) return null;
  try {
    const index = await redisPipeline([["ZREVRANGE", storeKey(store.sid), 0, MAX_KEPT_AGREEMENTS - 1]]);
    if (!Array.isArray(index) || index.length !== 1 || !Array.isArray(index[0])) return null;
    const list: unknown[] = index[0];
    if (list.length > MAX_KEPT_AGREEMENTS || new Set(list).size !== list.length || !list.every((id) => typeof id === "string" && ID_PATTERN.test(id))) return null;
    if (!list.length) return [];
    const ids = list as string[];
    const records = await redisPipeline([["MGET", ...ids.map(recordKey)]]);
    if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]) || records[0].length !== ids.length) return null;
    const values: unknown[] = records[0];
    const out: Agreement[] = [];
    const gone: string[] = [];
    ids.forEach((id, i) => {
      const raw = values[i];
      if (raw === null) { gone.push(id); return; }
      let agreement: Agreement | null = null;
      try { agreement = typeof raw === "string" ? parseAgreement(JSON.parse(raw)) : null; } catch { agreement = null; }
      if (!agreement || agreement.sid !== store.sid || agreement.id !== id) throw new Error("Agreement record could not be verified");
      out.push(agreement);
    });
    if (gone.length) await redisPipeline([["ZREM", storeKey(store.sid), ...gone]]);
    return out;
  } catch (error) {
    console.error("reading agreements failed", error);
    return null;
  }
}

/**
 * One person's agreements in the store, from their own set (at most
 * MAX_PER_PERSON, and twice that read at most): two commands whatever the
 * store keeps, for a page about one buyer (lib/buyer-waiting.ts). A record
 * gone is skipped; one that does not read as this store's is null.
 */
export async function agreementsOfPerson(store: Pick<Store, "sid">, email: string): Promise<Agreement[] | null> {
  if (!isRedisConfigured() || !store.sid) return null;
  try {
    const [members] = await redisPipeline([["SMEMBERS", personSet(store.sid, email)]]);
    if (!Array.isArray(members)) return null;
    const ids = members.map(String).filter((id) => ID_PATTERN.test(id)).slice(0, MAX_PER_PERSON * 2);
    if (!ids.length) return [];
    const [values] = await redisPipeline([["MGET", ...ids.map(recordKey)]]);
    if (!Array.isArray(values) || values.length !== ids.length) return null;
    const out: Agreement[] = [];
    ids.forEach((id, i) => {
      const raw = values[i];
      if (raw === null) return;
      const agreement = typeof raw === "string" ? parseAgreement(JSON.parse(raw)) : null;
      if (!agreement || agreement.sid !== store.sid || agreement.id !== id) throw new Error("Agreement record could not be verified");
      out.push(agreement);
    });
    return out;
  } catch (error) {
    console.error("reading a person's agreements failed", error);
    return null;
  }
}

/** Withdraws one waiting for a signature: its link stops taking one. A signed version stays signed. */
export async function withdrawAgreement(store: Store, id: string, now = Date.now()): Promise<Agreement | "not_open" | "busy" | null> {
  const held = await hold(id);
  if (!held) return "busy";
  try {
    const a = await agreementOf(store, id);
    if (!a) return null;
    const status = statusOf(a, now);
    if (status !== "open" && status !== "expired") return "not_open";
    const done: Agreement = { ...a, state: "withdrawn", closedAt: now };
    await saveAgreement(done, now);
    return done;
  } finally {
    await letGo(held);
  }
}

/** Deletes one that is not waiting for a signature. The copies already emailed stay with whoever received them. */
export async function deleteAgreement(store: Store, id: string, now = Date.now()): Promise<"deleted" | "open" | null> {
  const a = await agreementOf(store, id);
  if (!a) return null;
  if (statusOf(a, now) === "open") return "open";
  await forget(a);
  return "deleted";
}

async function forget(a: Agreement): Promise<void> {
  await redisPipeline([
    ["DEL", ...agreementKeys(a.id)],
    ["ZREM", storeKey(a.sid), a.id],
    ["SREM", personSet(a.sid, a.email), a.id],
  ]);
}

/**
 * Deletes every agreement a store keeps for one person (lib/person-erasure.ts),
 * signed or not, with every version's text: an open one stops taking a
 * signature. The copies already emailed stay with whoever received them.
 * Answers how many were deleted.
 */
export async function forgetAgreementsPerson(sid: string, email: string): Promise<number> {
  if (!isRedisConfigured() || !sid) return 0;
  const person = personSet(sid, email);
  const [members] = await redisPipeline([["SMEMBERS", person]]);
  const ids = (Array.isArray(members) ? members.map(String) : []).filter((id) => ID_PATTERN.test(id)).slice(0, MAX_PER_PERSON * 2);
  if (!ids.length) {
    await redisPipeline([["DEL", person]]);
    return 0;
  }
  await redisPipeline([...ids.flatMap((id) => [["DEL", ...agreementKeys(id)], ["ZREM", storeKey(sid), id]]), ["DEL", person]]);
  return ids.length;
}
