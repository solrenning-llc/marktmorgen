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
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { claimMark, releaseMark } from "@/lib/claim-mark";
import { type Held, LockBusyError, deleteIfHeldOnly, releaseLock, takeLock, withLock } from "@/lib/redis-lock";
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
  SHA_PATTERN,
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

/**
 * One agreement by its id, or null. Read exactly (CX-123 rule 24): null only when the record is confirmed absent
 * (GET null); any other reply, or a kept text that does not read as an agreement, throws UnknownReplyError, so a
 * withdraw or a delete is never told "gone" while the record may still be there (Claude 5 on #3268).
 */
export async function readAgreement(id: string): Promise<Agreement | null> {
  if (!ID_PATTERN.test(id) || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["GET", recordKey(id)]]), 1);
  if (!reply || (reply[0] !== null && typeof reply[0] !== "string")) throw new UnknownReplyError("reading an agreement");
  const raw = reply[0];
  if (raw === null) return null;
  let agreement: Agreement | null = null;
  try {
    agreement = parseAgreement(JSON.parse(raw));
  } catch {
    agreement = null;
  }
  if (!agreement) throw new UnknownReplyError("reading an agreement");
  return agreement;
}

/**
 * Whether the stored record names version n with this fingerprint, read exactly (CX-123 rule 24): "yes", "no" (the
 * record is there and does not, or there is no record at all), or "unknown" (no reply, a reply of another shape, or
 * a record that does not read).
 */
async function recordNames(id: string, n: number, sha256: string): Promise<"yes" | "no" | "unknown"> {
  try {
    const reply = repliesFor(await redisPipeline([["GET", recordKey(id)]]), 1);
    if (!reply) return "unknown";
    if (reply[0] === null) return "no";
    if (typeof reply[0] !== "string") return "unknown";
    // Read at the edge of a clean-up, strictly (Codex CX1 on #2723): parseAgreement drops rows it does not understand
    // and cuts at MAX_VERSIONS, which is right for a page but would turn a record that still names this version into
    // "no" here. Any row that names it exactly is "yes"; "no" only when every row is understood and the list is whole.
    const raw: unknown = JSON.parse(reply[0]);
    const rows = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.getOwnPropertyDescriptor(raw, "versions")?.value : undefined;
    if (!Array.isArray(rows)) return "unknown";
    const field = (row: unknown, name: string): unknown =>
      row && typeof row === "object" && !Array.isArray(row) ? Object.getOwnPropertyDescriptor(row, name)?.value : undefined;
    if (rows.some((row) => field(row, "n") === n && field(row, "sha256") === sha256)) return "yes";
    const understood = rows.every((row) => {
      const at = field(row, "n"), sha = field(row, "sha256");
      return Number.isSafeInteger(at) && (at as number) >= 1 && typeof sha === "string" && SHA_PATTERN.test(sha);
    });
    if (!understood || rows.length > MAX_VERSIONS || !parseAgreement(raw)) return "unknown";
    return "no";
  } catch {
    return "unknown";
  }
}

/**
 * Whether the stored record carries exactly this signature on version n with this fingerprint, read exactly: "yes",
 * "no" (no record, or one that does not), or "unknown" (no reply, another shape, or a record that does not read).
 */
async function recordSigned(id: string, n: number, sha256: string, signature: Signature): Promise<"yes" | "no" | "unknown"> {
  try {
    const reply = repliesFor(await redisPipeline([["GET", recordKey(id)]]), 1);
    if (!reply) return "unknown";
    if (reply[0] === null) return "no";
    if (typeof reply[0] !== "string") return "unknown";
    const raw: unknown = JSON.parse(reply[0]);
    const own = (value: unknown, name: string): unknown =>
      value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;
    const rows = own(raw, "versions");
    if (!Array.isArray(rows)) return "unknown";
    const signed = rows.some((row) => {
      const mark = own(row, "signature");
      return own(row, "n") === n && own(row, "sha256") === sha256 &&
        own(mark, "name") === signature.name && own(mark, "at") === signature.at && own(mark, "sha256") === signature.sha256;
    });
    return signed ? "yes" : "no";
  } catch {
    return "unknown";
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
/** Whether a version's own key is there, without reading its text: for a list that shows only its title. */
export async function versionExists(a: Pick<Agreement, "id" | "versions">, n: number): Promise<boolean> {
  if (!a.versions.some((m) => m.n === n) || !isRedisConfigured()) return false;
  const [there] = await redisPipeline([["EXISTS", versionKey(a.id, n)]]);
  return Number(there) === 1;
}

export async function readVersion(a: Pick<Agreement, "id" | "versions">, n: number): Promise<AgreementVersion | null> {
  // As before for the studio, the signing page and the emails: a reply of another shape is "can't be read right now".
  return readVersionExact(a, n).catch((error: unknown) => {
    if (error instanceof UnknownReplyError) return null;
    throw error;
  });
}

/**
 * Version n's text, read exactly (CX-123 rules 24 and 30), for the person's
 * data copy (lib/person-copy.ts): null when the version is not one the record
 * lists, is confirmed absent (GET null) or does not read as its fingerprint
 * says; a reply of any other shape throws UnknownReplyError, so a copy is
 * never handed over with a version's text silently missing.
 */
export async function readVersionExact(a: Pick<Agreement, "id" | "versions">, n: number): Promise<AgreementVersion | null> {
  const mark = a.versions.find((m) => m.n === n);
  if (!mark || !isRedisConfigured()) return null;
  const reply = repliesFor(await redisPipeline([["GET", versionKey(a.id, n)]]), 1);
  if (!reply || (reply[0] !== null && typeof reply[0] !== "string")) throw new UnknownReplyError("reading an agreement's version");
  const raw = reply[0];
  if (raw === null) return null;
  try {
    const v = parseVersion(JSON.parse(raw));
    return v && v.n === n && v.sha256 === mark.sha256 && fingerprint(v.text) === mark.sha256 ? v : null;
  } catch {
    return null;
  }
}

/**
 * The record written back only while the agreement's lock still holds this writer's token, with its expiry, in one
 * step (Codex M on #3151): a signature or a new version held up past its lock (a slow network, a paused function)
 * cannot land a stale copy after the lock ran out, in particular after a person's erasure took the lock and deleted
 * the agreement. Modeled step for step in lib/redis-memory.ts.
 */
export const AGREEMENT_SAVE = `-- marktmorgen:agreement-save:v1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
return 1`;

/** The agreement's lock was no longer this writer's when it wrote: nothing was written. */
export class AgreementLockLostError extends Error {
  constructor() {
    super("the agreement's lock ran out before the write: nothing written");
    this.name = "AgreementLockLostError";
  }
}

/**
 * Writes the record back as it now is, for the rest of the days it is kept, only while `held` (the agreement's lock)
 * is still this writer's. Versions are never written here. Read exactly (CX-123 rule 24, Claude 3 on #2723): 1 is
 * written; 0 is the lock lost, nothing written (AgreementLockLostError); anything else is unknown (UnknownReplyError).
 */
export async function saveAgreement(a: Agreement, held: Held, now = Date.now()): Promise<void> {
  const saved = repliesFor(
    await redisPipeline([["EVAL", AGREEMENT_SAVE, 2, held.key, recordKey(a.id), held.token, JSON.stringify(a), keepSeconds(a, now)]]),
    1,
  );
  if (saved?.[0] === 0) throw new AgreementLockLostError();
  if (!saved || saved[0] !== 1) throw new UnknownReplyError("saving an agreement");
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
  return withLock(lockKey(id), 10, 5_000, async (held) => {
    const current = await agreementOf(store, id);
    if (!current) return null;
    const next = change(current);
    if (!next) return current;
    await saveAgreement(next, held, now);
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
    // A version's key is written once: never over one already there. Read exactly (CX-123 rule 24): the record names
    // it only when the key holds this version's own text. One that cannot be read is let go only while it holds this
    // text, so the next try can write version n; another text there is never touched.
    const text = JSON.stringify(version);
    const written = await claimMark(versionKey(a.id, n), keepSeconds(a, now), text);
    if (written === "unknown") await releaseMark(versionKey(a.id, n), text);
    if (written !== "ours") return unavailable();
    const next: Agreement = {
      ...a,
      versions: [...a.versions, { n, sha256: version.sha256, title: version.title, createdAt: now, signature: null }],
      expiresAt: now + SIGN_MS,
      payRequest: draft.payRequest,
      failed: "",
    };
    try {
      await saveAgreement(next, held, now);
    } catch (error) {
      // The save's answer may be lost while the save landed (Codex CX1 on #2723): the record is read back exactly
      // first. Naming this version, the change went through; known not to name it, the text is let go (only while it
      // is this text), so the next try writes version n (Claude 3 on #2723); not known, the text is kept, never let go
      // under a record that may name it.
      const named = await recordNames(a.id, n, version.sha256);
      if (named === "yes") return { ok: true, agreement: next, version };
      if (named === "no") await releaseMark(versionKey(a.id, n), text);
      throw error;
    }
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
    try {
      await saveAgreement(next, held, now);
    } catch (error) {
      // The write may have landed and only its reply been lost (Revisor 1 on #2723): read the record back exactly,
      // and only this very signature on this version counts as signed, so the copies still go out once.
      if ((await recordSigned(a.id, latest.n, latest.sha256, signature)) !== "yes") throw error;
    }
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
    // Each reply read from its own slots (lib/redis-reply.ts, rule 30): the person's data copy reads through here.
    const index = repliesFor(await redisPipeline([["ZREVRANGE", storeKey(store.sid), 0, MAX_KEPT_AGREEMENTS - 1]]), 1);
    const list = index ? stringList(index[0]) : null;
    if (!list || list.length > MAX_KEPT_AGREEMENTS || new Set(list).size !== list.length || !list.every((id) => ID_PATTERN.test(id))) return null;
    if (!list.length) return [];
    const ids = list;
    const records = repliesFor(await redisPipeline([["MGET", ...ids.map(recordKey)]]), 1);
    const values = records ? repliesFor(records[0], ids.length) : null;
    if (!values) return null;
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
    // The person's set read exactly (rule 30, as forgetAgreementsPerson reads it): another shape is null, never "none".
    const listed = repliesFor(await redisPipeline([["SMEMBERS", personSet(store.sid, email)]]), 1);
    const members = listed ? stringList(listed[0]) : null;
    if (!members) return null;
    const ids = members.filter((id) => ID_PATTERN.test(id)).slice(0, MAX_PER_PERSON * 2);
    if (!ids.length) return [];
    const read = repliesFor(await redisPipeline([["MGET", ...ids.map(recordKey)]]), 1);
    const values = read ? repliesFor(read[0], ids.length) : null;
    if (!values) return null;
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
    await saveAgreement(done, held, now);
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

/**
 * Deleted only on each removal's exact count (CX-123 rules 24 and 30, Claude 5 on #3268): DEL answers how many of the
 * agreement's keys it removed, ZREM and SREM 0 or 1. Any other reply throws UnknownReplyError, so the studio says it
 * could not be done instead of "deleted" while the record may still be kept.
 */
async function forget(a: Agreement): Promise<void> {
  const keys = agreementKeys(a.id);
  const replies = repliesFor(await redisPipeline([
    ["DEL", ...keys],
    ["ZREM", storeKey(a.sid), a.id],
    ["SREM", personSet(a.sid, a.email), a.id],
  ]), 3);
  const [removed, unlisted, unnamed] = replies ? replies.map(countOf) : [];
  if (removed == null || unlisted == null || unnamed == null || removed > keys.length || unlisted > 1 || unnamed > 1) {
    throw new UnknownReplyError("deleting an agreement");
  }
}

/** How many agreements one pass of an erasure deletes: their DEL and ZREM go in one pipeline. */
const FORGET_BATCH = MAX_PER_PERSON * 2;
/** How long an erasure waits for a signature or a new version in progress to let go of an agreement's lock. */
const ERASE_LOCK_WAIT_MS = 5_000;

/**
 * Deletes every agreement a store keeps for one person (lib/person-erasure.ts),
 * signed or not, with every version's text: an open one stops taking a
 * signature. The copies already emailed stay with whoever received them.
 * Answers how many were deleted.
 *
 * Exact (CX-123 rules 24 and 30): the person's set is the only way to find
 * their agreements, so it is read exactly and deleted last. A reply of another
 * shape to the set, or to any delete, throws UnknownReplyError (the erasure is
 * then not finished and can be pressed again); the set goes only once every
 * agreement's delete has answered with a count, so a retry still finds every
 * one. Only an exact empty set is "nothing to erase".
 */
export async function forgetAgreementsPerson(sid: string, email: string): Promise<number> {
  if (!isRedisConfigured() || !sid) return 0;
  const person = personSet(sid, email);
  const listed = repliesFor(await redisPipeline([["SMEMBERS", person]]), 1);
  const members = listed ? stringList(listed[0]) : null;
  if (!members) throw new UnknownReplyError("listing a person's agreements");
  // Sorted, so two erasures of the same person take the locks in the same order.
  const ids = [...new Set(members.filter((id) => ID_PATTERN.test(id)))].sort();
  for (let at = 0; at < ids.length; at += FORGET_BATCH) {
    const batch = ids.slice(at, at + FORGET_BATCH);
    // One agreement at a time: its lock (the one a signature, a new version or a change holds while it reads the record
    // and writes it back), then its record and texts deleted in one script only while that lock is still this
    // erasure's own (deleteIfHeldOnly), then the lock let go (Codex M on #3151). A writer in progress finishes first;
    // a writer held up past its own lock cannot write (saveAgreement is fenced the same way); and an erasure held up
    // past its lock deletes nothing. A lock still taken after the wait, or lost before the delete, throws: the erasure
    // is not finished, the person's set is kept, and a retry finds everything.
    for (const id of batch) {
      const held = await takeLock(lockKey(id), 10, ERASE_LOCK_WAIT_MS);
      try {
        if (!(await deleteIfHeldOnly(held, agreementKeys(id)))) throw new LockBusyError("an agreement's lock was lost before its erasure");
      } finally {
        await letGo(held);
      }
    }
    // Then out of the store's list (ZREM answers 0 or 1); the records it names are already gone.
    const replies = repliesFor(await redisPipeline(batch.map((id) => ["ZREM", storeKey(sid), id])), batch.length);
    if (!replies?.every((reply) => {
      const n = countOf(reply);
      return n !== null && n <= 1;
    })) throw new UnknownReplyError("deleting a person's agreements");
  }
  const dropped = repliesFor(await redisPipeline([["DEL", person]]), 1);
  const gone = dropped ? countOf(dropped[0]) : null;
  if (gone === null || gone > 1) throw new UnknownReplyError("deleting a person's agreement list");
  return ids.length;
}
