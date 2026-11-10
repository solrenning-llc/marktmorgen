/**
 * An unsent answer in the studio's inbox, kept per conversation on this
 * device only (complement WG of 487 [IT4], part (a); added 10 November 2026).
 *
 * Before this, choosing another conversation emptied the answer box, so an
 * answer half written was lost without a word. Now what is typed is kept in
 * this browser's own storage, under the conversation it was for: the list
 * says "Draft" beside that conversation, and the words come back when it is
 * opened again.
 *
 * What it never does:
 *
 *   - Send a draft anywhere. It is never written to the server: nothing new
 *     is stored, read or paid for by Marktmorgen.
 *   - Keep a draft for long. Each one goes when its answer is sent, when the
 *     creator logs out on this device (components/forget-inbox-drafts.tsx, on
 *     the page every log-out lands on) and DRAFT_DAYS after it was last
 *     typed, whichever comes first; and no more than MAX_DRAFTS are kept, the
 *     oldest going first.
 *   - Break the inbox when storage is blocked or full (a private window, a
 *     setting): every read and write is tried and, when it fails, the inbox
 *     works exactly as before, without drafts.
 *
 * Pure: the storage is passed in, so the rules are tested without a browser.
 */
import { CONVERSATION_ID, MAX_MESSAGE } from "@/lib/inbox-rules";

/** Where the drafts are kept in the browser's storage: one entry, so logging out clears them at once. */
export const DRAFTS_KEY = "mm:inbox-drafts:v1";
/** How long a draft is kept after it was last typed. */
export const DRAFT_DAYS = 7;
/** The most drafts kept on one device; the oldest goes first. */
export const MAX_DRAFTS = 50;

const DAY_MS = 86_400_000;

export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Kept = Record<string, { text: string; at: number }>;

/**
 * The drafts as kept, made safe and without the ones past DRAFT_DAYS; null
 * when the storage itself cannot be read (none, or blocked). An entry that is
 * not ours to read reads as no drafts, and the next one kept replaces it.
 */
function readAll(storage: DraftStorage | null, now: number): Kept | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFTS_KEY);
  } catch {
    return null;
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const kept: Kept = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!CONVERSATION_ID.test(id) || !value || typeof value !== "object") continue;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== "string" || !text.trim() || typeof at !== "number" || !Number.isFinite(at)) continue;
    if (at > now + DAY_MS || now - at > DRAFT_DAYS * DAY_MS) continue;
    kept[id] = { text: text.slice(0, MAX_MESSAGE), at };
  }
  return kept;
}

/** Writes them back, the newest MAX_DRAFTS only; false when storage refused. Nothing left removes the entry. */
function writeAll(storage: DraftStorage | null, kept: Kept): boolean {
  if (!storage) return false;
  const newest = Object.entries(kept).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_DRAFTS);
  try {
    if (!newest.length) storage.removeItem(DRAFTS_KEY);
    else storage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(newest)));
    return true;
  } catch {
    return false;
  }
}

/** The draft kept for a conversation, or "". */
export function readDraft(storage: DraftStorage | null, id: string, now = Date.now()): string {
  return readAll(storage, now)?.[id]?.text ?? "";
}

/** The conversations that have a draft on this device. */
export function draftIds(storage: DraftStorage | null, now = Date.now()): Set<string> {
  return new Set(Object.keys(readAll(storage, now) ?? {}));
}

/**
 * Keeps what is typed for a conversation; blank words remove its draft.
 * True when the storage took it (or there was nothing to remove), false when
 * it could not be read or written: then the words are only in the box, as
 * before.
 */
export function saveDraft(storage: DraftStorage | null, id: string, text: string, now = Date.now()): boolean {
  if (!CONVERSATION_ID.test(id)) return false;
  const kept = readAll(storage, now);
  if (!kept) return false;
  if (!text.trim()) {
    if (!(id in kept)) return true;
    delete kept[id];
  } else kept[id] = { text: text.slice(0, MAX_MESSAGE), at: now };
  return writeAll(storage, kept);
}

/** Removes a conversation's draft, once its answer is sent. */
export function clearDraft(storage: DraftStorage | null, id: string, now = Date.now()): boolean {
  return saveDraft(storage, id, "", now);
}

/** Removes every draft on this device, when the creator logs out. */
export function forgetDrafts(storage: DraftStorage | null): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(DRAFTS_KEY);
    return true;
  } catch {
    return false;
  }
}

/** The browser's own storage, or null when there is none or it may not be touched. */
export function browserDrafts(): DraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
