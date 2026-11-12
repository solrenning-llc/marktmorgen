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
 *   - Show one person's draft to another. Each person signed in on this
 *     device has their own entry, under a scope made from their account
 *     (draftScope, never the address itself), and the inbox reads only the
 *     signed-in person's: a teammate who logs in on the same computer never
 *     sees, or sends, someone else's unsent words (review of #3521).
 *   - Keep a draft for long. Each one goes when its answer is sent; every
 *     person's go whenever the sign-in page is shown on this device, which is
 *     where every log-out and every ended session lands (an expired or
 *     refused session, "log in again", a log-out everywhere seen here;
 *     components/forget-inbox-drafts.tsx); and DRAFT_DAYS after it was last
 *     typed, whichever comes first: an old one leaves storage the first time
 *     it is read after that. No more than MAX_DRAFTS are kept for a
 *     person, the oldest going first.
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
 * not ours to read reads as no drafts and is removed, as an old draft is.
 */
function readAll(storage: DraftStorage | null, now: number): Kept | null {
  return readState(storage, now)?.kept ?? null;
}

/**
 * readAll, and whether words that are no longer shown are still in storage
 * because the device refused to remove them (stuck): then the 7-day promise
 * is not kept, and the inbox says so (Codex U on #3521). Every read tries the
 * removal again, so it goes as soon as the device accepts.
 */
function readState(storage: DraftStorage | null, now: number): { kept: Kept; stuck: boolean } | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(DRAFTS_KEY);
  } catch {
    return null;
  }
  if (!raw) return { kept: {}, stuck: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kept: {}, stuck: !purge(storage, {}) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kept: {}, stuck: !purge(storage, {}) };
  }
  const kept: Kept = {};
  let dropped = false;
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const { text, at } = value && typeof value === "object" ? (value as { text?: unknown; at?: unknown }) : {};
    if (!CONVERSATION_ID.test(id) || typeof text !== "string" || !text.trim() || typeof at !== "number" || !Number.isFinite(at) || at > now + DAY_MS || now - at > DRAFT_DAYS * DAY_MS) {
      dropped = true;
      continue;
    }
    kept[id] = { text: text.slice(0, MAX_MESSAGE), at };
  }
  // A draft past DRAFT_DAYS, or an entry that is not one, leaves storage as soon as it is read, so its words are
  // not kept on the device after they stop being shown (Codex U on #3521). A refused write is reported as stuck, never as gone.
  return { kept, stuck: dropped && !purge(storage, kept) };
}

/** Writes back only what is still kept; nothing left removes the entry. Never throws; false when storage refused. */
function purge(storage: DraftStorage, kept: Kept): boolean {
  return writeAll(storage, kept);
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
 * True when a draft past DRAFT_DAYS (or an entry that is not one) is still on
 * this device because it refused to remove it: hidden, but not gone. Looking
 * tries the removal again. False when nothing old is left, and when there is
 * no storage at all (then nothing was ever kept).
 */
export function oldDraftsStuck(storage: DraftStorage | null, now = Date.now()): boolean {
  return readState(storage, now)?.stuck ?? false;
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

/** A whole storage, with its keys listed: what forgetting every person's drafts needs. */
export type ListedStorage = DraftStorage & Pick<Storage, "length" | "key">;

/** Removes every person's drafts from this device, as the sign-in page does; false when the storage refused. */
export function forgetEveryonesDrafts(storage: ListedStorage | null): boolean {
  if (!storage) return false;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key === DRAFTS_KEY || key?.startsWith(`${DRAFTS_KEY}:`)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * The scope of one person's drafts: a short hash of their account (FNV-1a,
 * twice), so the address itself is never written in the browser's storage.
 * Not a secret: it only keeps one person's drafts apart from another's.
 */
export function draftScope(who: string): string {
  const text = who.trim().toLowerCase();
  const hash = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return `${hash(2166136261)}${hash(3735928559)}`;
}

/** One person's drafts in a storage: the same rules, under that person's own entry only. Null without a person. */
export function personDrafts(storage: DraftStorage | null, who: string): DraftStorage | null {
  if (!storage || !who.trim()) return null;
  const key = (k: string) => (k === DRAFTS_KEY ? `${DRAFTS_KEY}:${draftScope(who)}` : k);
  return {
    getItem: (k) => storage.getItem(key(k)),
    setItem: (k, v) => storage.setItem(key(k), v),
    removeItem: (k) => storage.removeItem(key(k)),
  };
}

/** The browser's own storage, whole, or null when there is none or it may not be touched. */
export function browserStorage(): ListedStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The signed-in person's drafts in this browser, or null. */
export function browserDrafts(who: string): DraftStorage | null {
  return personDrafts(browserStorage(), who);
}
