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
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    const id = raw[i];
    if (typeof id !== "string" || !DRAFT_ID.test(id) || seen.has(id) || typeof raw[i + 1] !== "string") return null;
    let value: unknown;
    try { value = JSON.parse(raw[i + 1]); } catch { return null; }
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
  const response = await redisPipeline([["HGETALL", draftsKey(listId)]]);
  if (!Array.isArray(response) || response.length !== 1) throw new Error("Draft list response is incomplete");
  const drafts = parseDraftList(response[0]);
  if (drafts === null) throw new Error("Draft list could not be read");
  return drafts;
}

/** A store's drafts, the most recently saved first. */
export async function listDrafts(listId: string | null): Promise<Draft[]> {
  if (!listId || !isRedisConfigured()) return [];
  const [flat] = await redisPipeline([["HGETALL", draftsKey(listId)]]);
  const values = Array.isArray(flat) ? flat.filter((_, i) => i % 2 === 1) : [];
  return values
    .map(parse)
    .filter((d): d is Draft => d !== null)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export type DraftResult =
  | { ok: true; draft: Draft }
  | { ok: false; reason: "subject" | "body" | "product" | "full" | "unknown" | "list" | "audience" | "draft_test" | "draft_conflict" | "draft_busy" };

/**
 * Saves a draft: a new one without `id`, or over the one with it. The text is
 * trimmed to what an email may hold, and the product it is meant for has to
 * be one this store has.
 */
async function saveDraftUnlocked(
  store: Store,
  who: string,
  input: { id?: string; subject: string; body: string; productId: string; audience?: unknown; subjectTest?: unknown; expectedSavedAt?: unknown },
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
  let acknowledgement: unknown;
  try {
    acknowledgement = await redisPipeline([["HSET", key, id, JSON.stringify(draft)]]);
  } catch {
    throw new DraftWriteUnconfirmed();
  }
  if (!Array.isArray(acknowledgement) || acknowledgement.length !== 1 || (acknowledgement[0] !== 0 && acknowledgement[0] !== 1)) throw new DraftWriteUnconfirmed();
  return { ok: true, draft };
}

/** Throws a draft away. True when there was one to throw away. */
export async function removeDraft(store: Store, id: string, expectedSavedAt?: unknown): Promise<boolean> {
  if (!store.listId || !DRAFT_ID.test(id)) return false;
  let acquired = false;
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
    const response = await redisPipeline([["HDEL", draftsKey(store.listId), id]]);
    if (!Array.isArray(response) || response.length !== 1 || (response[0] !== 0 && response[0] !== 1)) throw new DraftRemovalUnconfirmed();
    return response[0] === 1;
  } catch (error) {
    if (error instanceof DraftRemovalConflict) throw error;
    throw new DraftRemovalUnconfirmed();
  }
  finally { if (acquired) await releaseDraftLock(store.listId, id); }
}

/** Cleanup cannot undo a confirmed campaign; a lost reply must not invite resending it. */
export async function finishBroadcastDraft(store: Store, id: string, expectedSavedAt?: unknown): Promise<boolean> {
  if (!id) return true;
  if (!store.listId || !DRAFT_ID.test(id)) return false;
  try { await removeDraft(store, id, expectedSavedAt); return true; } catch { return false; }
}

const draftLockKey = (listId: string, id: string) => draftsKey(listId) + ":lock:" + id;
async function claimDraftLock(listId: string, id: string): Promise<boolean> {
  const response = await redisPipeline([["SET", draftLockKey(listId, id), "1", "NX", "EX", 90]]);
  if (!Array.isArray(response) || response.length !== 1 || (response[0] !== "OK" && response[0] !== null)) throw new DraftReadUnavailable();
  return response[0] === "OK";
}
async function releaseDraftLock(listId: string, id: string): Promise<void> {
  await redisPipeline([["DEL", draftLockKey(listId, id)]]).catch(() => {});
}
/** Existing drafts are read, version-checked and written under the same lease as deletion. */
export async function saveDraft(store: Store, who: string, input: { id?: string; subject: string; body: string; productId: string; audience?: unknown; subjectTest?: unknown; expectedSavedAt?: unknown }): Promise<DraftResult> {
  if (!store.listId) return { ok: false, reason: "list" };
  if (!input.id) return saveDraftUnlocked(store, who, input);
  if (!DRAFT_ID.test(input.id)) return { ok: false, reason: "unknown" };
  let acquired: boolean;
  try { acquired = await claimDraftLock(store.listId, input.id); } catch { throw new DraftReadUnavailable(); }
  if (!acquired) return { ok: false, reason: "draft_busy" };
  try { return await saveDraftUnlocked(store, who, input); }
  finally { await releaseDraftLock(store.listId, input.id); }
}
