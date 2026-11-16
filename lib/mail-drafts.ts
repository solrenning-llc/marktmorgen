/**
 * Emails written and kept for later, before anyone sends them.
 *
 * A draft is what someone on a store's team who writes but does not send (an
 * Editor, lib/team-roles.ts) hands over: the subject, the text and who it is
 * meant for. The owner or an Admin opens it in the studio's email page, reads
 * it, and sends or schedules it themselves; sending takes the draft away.
 * Nothing in a draft ever reaches the list on its own.
 *
 *   nl:mail:drafts:<listId>   the store's drafts, one field each (a hash)
 *
 * Twenty at most per store, each as long as an email may be. Kept under the
 * store's list, like its broadcasts, so a new address or a new owner address
 * moves nothing.
 */
import { readDraftSubjectTest, type DraftSubjectTest } from "@/lib/mail-draft-test";
import { readDraftAudience, type DraftAudience } from "@/lib/mail-draft-audience";
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor, stringList } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { MAX_MAIL_BODY, MAX_SUBJECT } from "@/lib/mail";
import type { Store } from "@/lib/store";
import { hasProduct } from "@/lib/catalog";

/** A write may have happened even when its acknowledgement is lost. */
export class DraftWriteUnconfirmed extends Error {
  constructor() { super("Draft write could not be confirmed"); this.name = "DraftWriteUnconfirmed"; }
}

/** Failed preflight reads must not be treated as an empty draft collection. */
export class DraftReadUnavailable extends Error {
  constructor() { super("Draft preflight could not be read"); this.name = "DraftReadUnavailable"; }
}

async function draftPreflight(command: ["HLEN", string] | ["HEXISTS", string, string]): Promise<number> {
  let response: unknown;
  try { response = await redisPipeline([command]); } catch { throw new DraftReadUnavailable(); }
  if (!Array.isArray(response) || response.length !== 1 || typeof response[0] !== "number" || !Number.isSafeInteger(response[0]) || response[0] < 0 || (command[0] === "HEXISTS" && response[0] > 1)) throw new DraftReadUnavailable();
  return response[0];
}

/** Deletion may already have happened when its acknowledgement is lost. */
export class DraftRemovalUnconfirmed extends Error {
  constructor() { super("Draft removal could not be confirmed"); this.name = "DraftRemovalUnconfirmed"; }
}

export class DraftRemovalConflict extends Error {
  constructor() { super("A newer draft version must not be removed"); this.name = "DraftRemovalConflict"; }
}

export const MAX_DRAFTS = 20;
export const DRAFT_ID = /^[0-9a-f]{16}$/;

export type Draft = {
  /** Missing on legacy drafts; null means the test was explicitly disabled. */
  subjectTest?: DraftSubjectTest | null;
  /** Absent only in drafts saved before audience persistence existed. */
  audience?: DraftAudience;
  id: string;
  subject: string;
  body: string;
  /** Everyone who may be written to, or only those who got one product. */
  productId: string | null;
  /** Who last saved it: their sign-in address. */
  by: string;
  /** ISO time it was last saved. */
  savedAt: string;
};

const draftsKey = (listId: string) => `nl:mail:drafts:${listId}`;

function parse(raw: unknown): Draft | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Draft>;
    if (typeof value.id !== "string" || !DRAFT_ID.test(value.id)) return null;
    const audience = Object.hasOwn(value, "audience") ? readDraftAudience(value.audience) : undefined;
    if (audience === null) return null;
    const subjectTest = readDraftSubjectTest(value.subjectTest);
    if (Object.hasOwn(value, "subjectTest") && subjectTest === undefined) return null;
    return {
      ...(subjectTest !== undefined ? { subjectTest } : {}),
      ...(audience ? { audience } : {}),
      id: value.id,
      subject: typeof value.subject === "string" ? value.subject.slice(0, MAX_SUBJECT) : "",
      body: typeof value.body === "string" ? value.body.slice(0, MAX_MAIL_BODY) : "",
      productId: typeof value.productId === "string" && value.productId ? value.productId : null,
      by: typeof value.by === "string" ? value.by : "",
      savedAt: typeof value.savedAt === "string" ? value.savedAt : "",
    };
  } catch {
    return null;
  }
}

/** A complete hash or unknown: never silently drop an unreadable saved draft. */
export function parseDraftList(raw: unknown): Draft[] | null {
  const rows = stringList(raw);
  if (!rows || rows.length % 2 !== 0) return null;
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 2) {
    const id = rows[i];
    if (!DRAFT_ID.test(id) || seen.has(id)) return null;
    let value: unknown;
    try { value = JSON.parse(rows[i + 1]); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const draft = value as Record<string, unknown>;
    if (draft.id !== id || typeof draft.subject !== "string" || typeof draft.body !== "string" || !(draft.productId === null || (typeof draft.productId === "string" && draft.productId !== "")) || typeof draft.by !== "string" || typeof draft.savedAt !== "string" || !Number.isFinite(Date.parse(draft.savedAt))) return null;
    const audience = Object.hasOwn(draft, "audience") ? readDraftAudience(draft.audience) : undefined;
    if (audience === null) return null;
    const subjectTest = readDraftSubjectTest(draft.subjectTest);
    if (Object.hasOwn(draft, "subjectTest") && subjectTest === undefined) return null;
    seen.add(id);
    drafts.push({ ...(subjectTest !== undefined ? { subjectTest } : {}), ...(audience ? { audience } : {}), id, subject: draft.subject, body: draft.body, productId: draft.productId, by: draft.by, savedAt: draft.savedAt });
  }
  return drafts.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** Studio reader: confirmed emptiness is different from an unavailable list. */
export async function listDraftsStrict(listId: string | null): Promise<Draft[]> {
  if (!listId) return [];
  if (!isRedisConfigured()) throw new Error("Draft storage is unavailable");
  const response = repliesFor(await redisPipeline([["HGETALL", draftsKey(listId)]]), 1);
  if (!response) throw new Error("Draft list response is incomplete");
  const drafts = parseDraftList(response[0]);
  if (drafts === null) throw new Error("Draft list could not be read");
  return drafts;
}

/** A store's drafts, the most recently saved first. */
export async function listDrafts(listId: string | null): Promise<Draft[]> {
  return listDraftsStrict(listId);
}

export type DraftResult =
  | { ok: true; draft: Draft }
  | { ok: false; reason: "subject" | "body" | "product" | "full" | "unknown" | "list" | "audience" | "draft_test" | "draft_conflict" | "draft_busy" };

/**
 * A draft set, or deleted, only while its lease still holds this save's or delete's own value, checked in the same
 * step as the write: a save or delete whose 90 seconds ran out never lands over what another tab saved since (Claude 2
 * on #3343). -1 when the lease is not ours, with nothing written; otherwise HSET's or HDEL's own reply. The first line
 * names each for the local stand-in (lib/redis-memory.ts).
 */
const DRAFT_SET_HELD = '-- marktmorgen:draft-set-held:v1\nif redis.call("GET", KEYS[2]) ~= ARGV[1] then return -1 end\nreturn redis.call("HSET", KEYS[1], ARGV[2], ARGV[3])';
const DRAFT_DEL_HELD = '-- marktmorgen:draft-del-held:v1\nif redis.call("GET", KEYS[2]) ~= ARGV[1] then return -1 end\nreturn redis.call("HDEL", KEYS[1], ARGV[2])';
type Lease = { key: string; value: string };

/**
 * Saves a draft: a new one without `id`, or over the one with it. The text is
 * trimmed to what an email may hold, and the product it is meant for has to
 * be one this store has. An existing draft is written only while `lease` is
 * still ours; a lease that ran out is refused as busy, never saved.
 */
async function saveDraftUnlocked(
  store: Store,
  who: string,
  input: { id?: string; subject: string; body: string; productId: string; audience?: unknown; subjectTest?: unknown; expectedSavedAt?: unknown },
  lease?: Lease,
): Promise<DraftResult> {
  if (!store.listId) return { ok: false, reason: "list" };
  const subject = input.subject.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);
  const body = input.body.trim().slice(0, MAX_MAIL_BODY);
  if (!subject) return { ok: false, reason: "subject" };
  if (!body) return { ok: false, reason: "body" };
  const productId = input.productId || null;
  if (productId && !hasProduct(store, productId)) return { ok: false, reason: "product" };

  let audience = input.audience === undefined ? undefined : readDraftAudience(input.audience);
  if (audience === null) return { ok: false, reason: "audience" };
  if (audience?.notProductId && !hasProduct(store, audience.notProductId)) return { ok: false, reason: "product" };
  let subjectTest = input.subjectTest === undefined ? undefined : readDraftSubjectTest(input.subjectTest);
  if (input.subjectTest !== undefined && subjectTest === undefined) return { ok: false, reason: "draft_test" };
  let savedAt = new Date().toISOString();
  const key = draftsKey(store.listId);
  let id = input.id ?? "";
  if (id) {
    if (!DRAFT_ID.test(id)) return { ok: false, reason: "unknown" };
    const exists = await draftPreflight(["HEXISTS", key, id]);
    if (exists !== 1) return { ok: false, reason: "unknown" };
    let previous: Draft;
    try {
      const response = await redisPipeline([["HGET", key, id]]);
      if (!Array.isArray(response) || response.length !== 1) throw new DraftReadUnavailable();
      const parsed = parse(response[0]);
      if (!parsed || parsed.id !== id || !Number.isFinite(Date.parse(parsed.savedAt))) throw new DraftReadUnavailable();
      previous = parsed;
    } catch { throw new DraftReadUnavailable(); }
    if (input.expectedSavedAt !== undefined && input.expectedSavedAt !== previous.savedAt) return { ok: false, reason: "draft_conflict" };
    // Under the draft lock, each successful update gets a distinct version even in one millisecond.
    savedAt = new Date(Math.max(Date.now(), Date.parse(previous.savedAt) + 1)).toISOString();
    if (input.audience === undefined) audience = previous.audience;
    if (input.subjectTest === undefined) subjectTest = previous.subjectTest;
  } else {
    const count = await draftPreflight(["HLEN", key]);
    if (count >= MAX_DRAFTS) return { ok: false, reason: "full" };
    id = randomBytes(8).toString("hex");
  }
  const draft: Draft = { ...(subjectTest !== undefined ? { subjectTest } : {}), ...(audience ? { audience } : {}), id, subject, body, productId, by: who.toLowerCase(), savedAt };
  let acknowledgement: unknown[] | null;
  try {
    acknowledgement = repliesFor(await redisPipeline([lease
      ? ["EVAL", DRAFT_SET_HELD, 2, key, lease.key, lease.value, id, JSON.stringify(draft)]
      : ["HSET", key, id, JSON.stringify(draft)]]), 1);
  } catch {
    throw new DraftWriteUnconfirmed();
  }
  const answer = acknowledgement?.[0];
  // Our lease ran out before the write: nothing was written, so it is refused as busy and the text stays in the editor.
  if (lease && answer === -1) return { ok: false, reason: "draft_busy" };
  if (answer !== 0 && answer !== 1) throw new DraftWriteUnconfirmed();
  return { ok: true, draft };
}

/** Throws a draft away. True when there was one to throw away. */
export async function removeDraft(store: Store, id: string, expectedSavedAt?: unknown): Promise<boolean> {
  if (!store.listId || !DRAFT_ID.test(id)) return false;
  let acquired: string | null = null;
  try {
    acquired = await claimDraftLock(store.listId, id);
    if (!acquired) throw new DraftRemovalUnconfirmed();
    if (expectedSavedAt !== undefined) {
      if (typeof expectedSavedAt !== "string" || !Number.isFinite(Date.parse(expectedSavedAt))) throw new DraftRemovalConflict();
      const read = await redisPipeline([["HGET", draftsKey(store.listId), id]]);
      if (!Array.isArray(read) || read.length !== 1) throw new DraftRemovalUnconfirmed();
      if (read[0] === null) return false;
      const current = parse(read[0]);
      if (!current || current.id !== id || !Number.isFinite(Date.parse(current.savedAt))) throw new DraftRemovalUnconfirmed();
      if (current.savedAt !== expectedSavedAt) throw new DraftRemovalConflict();
    }
    // Deleted only while the lease is still ours; -1 (it ran out, nothing deleted) is refused like a busy lease.
    const response = repliesFor(await redisPipeline([["EVAL", DRAFT_DEL_HELD, 2, draftsKey(store.listId), draftLockKey(store.listId, id), acquired, id]]), 1);
    const answer = response?.[0];
    if (answer !== 0 && answer !== 1) throw new DraftRemovalUnconfirmed();
    return answer === 1;
  } catch (error) {
    if (error instanceof DraftRemovalConflict) throw error;
    throw new DraftRemovalUnconfirmed();
  }
  finally { if (acquired) await releaseDraftLock(store.listId, id, acquired); }
}

/** Cleanup cannot undo a confirmed campaign; a lost reply must not invite resending it. */
export async function finishBroadcastDraft(store: Store, id: string, expectedSavedAt?: unknown): Promise<boolean> {
  if (!id) return true;
  if (!store.listId || !DRAFT_ID.test(id)) return false;
  try { await removeDraft(store, id, expectedSavedAt); return true; } catch { return false; }
}

const draftLockKey = (listId: string, id: string) => draftsKey(listId) + ":lock:" + id;
/**
 * The lease holds a value only this claim writes (lib/claim-mark.ts) and is let go only while it still holds it:
 * a slow save or delete whose 90 seconds ran out never deletes the lease another tab took since (rule 24). Our
 * value when ours, null when another holds it; an unknown claim is never ours and throws.
 */
async function claimDraftLock(listId: string, id: string): Promise<string | null> {
  const value = claimValue();
  const claimed = await claimMark(draftLockKey(listId, id), 90, value);
  if (claimed === "unknown") throw new DraftReadUnavailable();
  return claimed === "ours" ? value : null;
}
async function releaseDraftLock(listId: string, id: string, value: string): Promise<void> {
  await releaseMark(draftLockKey(listId, id), value);
}
/** Existing drafts are read, version-checked and written under the same lease as deletion, and written only while it holds. */
export async function saveDraft(store: Store, who: string, input: { id?: string; subject: string; body: string; productId: string; audience?: unknown; subjectTest?: unknown; expectedSavedAt?: unknown }): Promise<DraftResult> {
  if (!store.listId) return { ok: false, reason: "list" };
  if (!input.id) return saveDraftUnlocked(store, who, input);
  if (!DRAFT_ID.test(input.id)) return { ok: false, reason: "unknown" };
  let acquired: string | null;
  try { acquired = await claimDraftLock(store.listId, input.id); } catch { throw new DraftReadUnavailable(); }
  if (!acquired) return { ok: false, reason: "draft_busy" };
  try { return await saveDraftUnlocked(store, who, input, { key: draftLockKey(store.listId, input.id), value: acquired }); }
  finally { await releaseDraftLock(store.listId, input.id, acquired); }
}
