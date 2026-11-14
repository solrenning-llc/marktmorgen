/**
 * The store's inbox (added 13 October 2026): ClickFunnels' MessageHub, for
 * what a creator's buyers and visitors actually write. One place in the
 * studio for:
 *
 *   - a chat on the store's pages, switched on by the creator: a visitor
 *     writes with their address, and sees the answer there while the page is
 *     open, or by email when they have gone;
 *   - the store's contact form, which also still goes to the creator's own
 *     inbox as before.
 *
 * In the studio: the conversations, open ones first; an answer written there
 * goes to the visitor's chat and their email; saved replies to put in with
 * one press; a conversation given to one person of the team; closed when it
 * is done; and, where the writing help is on, a suggested answer written
 * from the conversation and the store's own FAQ, for the creator to change
 * before it is sent (one of the month's AI jobs).
 *
 * What it never does: write to anybody but the person who wrote first, and
 * only in answer to them, except one of the store's own approved affiliates,
 * to whom the creator may write first (630 [HN6](5), lib/inbox.ts
 * writeToAffiliate); send a visitor's address or name to the writing
 * help (addresses, phone numbers and links are taken out first); keep a
 * conversation past KEEP_DAYS after its last message.
 *
 * Pure and browser-safe: the store's widget, the studio and the server read
 * these rules.
 */

export const MAX_MESSAGE = 2_000;
export const MIN_MESSAGE = 2;
export const MAX_NAME = 80;
export const MAX_SAVED = 20;
export const MAX_SAVED_TITLE = 60;
export const MAX_SAVED_TEXT = 1_500;
/** Messages kept in one conversation: the newest. */
export const MAX_MESSAGES = 200;
/** Conversations a store keeps: the newest by their last message. */
export const MAX_CONVERSATIONS = 500;
/** New conversations one store takes in a day, at most. */
export const NEW_PER_DAY = 60;
/** Messages one visitor sends into one conversation in an hour, at most. */
export const VISITOR_PER_HOUR = 20;
/** How long a conversation is kept after its last message. */
export const KEEP_DAYS = 180;
/** How often an open chat asks for an answer, and for how long after the last thing typed. */
export const POLL_SECONDS = 20;
export const POLL_FOR_MINUTES = 15;

export const CONVERSATION_ID = /^[a-z0-9]{12}$/;
export const CHAT_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/** Where a conversation began: the store's chat, its contact form, or the creator writing first to an affiliate (630 [HN6](5)). */
export type Source = "chat" | "contact" | "affiliate";
export type Status = "open" | "closed";

export type Message = { at: number; from: "visitor" | "store"; text: string; /** Who of the store's team wrote it. */ by?: string };

export type Conversation = {
  id: string;
  email: string;
  name: string;
  source: Source;
  status: Status;
  /** The team member it is given to, by sign-in address; "" for nobody yet. */
  assigned: string;
  startedAt: number;
  lastAt: number;
  lastFrom: "visitor" | "store";
  /** Messages from the visitor the store has not read since. */
  unread: number;
};

export type SavedReply = { id: string; title: string; text: string };

export type InboxSetting = {
  /** The chat on the store's pages. Off until the creator turns it on. */
  chat: boolean;
  saved: SavedReply[];
};

export const NO_INBOX: InboxSetting = { chat: false, saved: [] };

const oneLine = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** A message's words: line breaks kept, nothing else that is not text. */
export function messageText(value: unknown, max = MAX_MESSAGE): string {
  return typeof value === "string"
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, max)
    : "";
}

export function nameText(value: unknown): string {
  return oneLine(value, MAX_NAME);
}

export function parseInboxSetting(raw: unknown): InboxSetting {
  if (!raw || typeof raw !== "object") return { ...NO_INBOX, saved: [] };
  const v = raw as Record<string, unknown>;
  const saved: SavedReply[] = [];
  for (const entry of Array.isArray(v.saved) ? v.saved : []) {
    if (saved.length >= MAX_SAVED || !entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === "string" && /^[a-z0-9]{6}$/.test(row.id) ? row.id : "";
    const title = oneLine(row.title, MAX_SAVED_TITLE);
    const text = messageText(row.text, MAX_SAVED_TEXT);
    if (id && title && text && !saved.some((s) => s.id === id)) saved.push({ id, title, text });
  }
  return { chat: v.chat === true, saved };
}

export function parseConversation(raw: unknown): Conversation | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Conversation>;
    if (typeof v.id !== "string" || !CONVERSATION_ID.test(v.id) || typeof v.email !== "string") return null;
    return {
      id: v.id,
      email: v.email,
      name: typeof v.name === "string" ? v.name : "",
      source: v.source === "contact" ? "contact" : v.source === "affiliate" ? "affiliate" : "chat",
      status: v.status === "closed" ? "closed" : "open",
      assigned: typeof v.assigned === "string" ? v.assigned : "",
      startedAt: Number(v.startedAt) || 0,
      lastAt: Number(v.lastAt) || 0,
      lastFrom: v.lastFrom === "store" ? "store" : "visitor",
      unread: Math.max(0, Number(v.unread) || 0),
    };
  } catch {
    return null;
  }
}

export function parseMessage(raw: unknown): Message | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<Message>;
    const text = messageText(v.text);
    if (!text || (v.from !== "visitor" && v.from !== "store")) return null;
    return { at: Number(v.at) || 0, from: v.from, text, ...(typeof v.by === "string" && v.by ? { by: v.by } : {}) };
  } catch {
    return null;
  }
}

/** The conversations in the order the studio shows them: open first, then the newest. */
export function inboxOrder(list: Conversation[]): Conversation[] {
  return [...list].sort((a, b) => (a.status === b.status ? b.lastAt - a.lastAt : a.status === "open" ? -1 : 1));
}

/** Common top-level domains: a bare name ending in one, in any case ("mysite.com/deal", "MySite.Com"), is a link. */
const SITE_TLDS = "com|net|org|io|co|app|dev|shop|store|xyz|info|biz|me|ly|link|site|online|top|club|live|page|tech|us|uk|de|fr|es|it|nl|pt|br|eu|ca|au|ch|in|academy|courses|school|email|blog|website|space|digital";
const BARE_SITE = new RegExp(`(?<![\\p{L}\\p{N}@.\\-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+(${SITE_TLDS})(?![\\p{L}\\p{N}])(\\/\\S*)?`, "giu");
/** Top-level domains that are also a word starting a sentence after a dot with no space ("great.It helps", "aula.Eu gostei"). */
const SENTENCE_TLDS = new Set(["it", "in", "me", "us", "es", "de", "eu", "ca", "au", "co", "top", "live", "page", "site", "online", "space"]);
/** An address spelled out in words: "jane.doe at example dot com", "jane (at) example [dot] com", with a common top-level domain. */
const spelled = (words: string) => `(?:\\s+|\\s*[([]\\s*)(?:${words})(?:\\s+|\\s*[)\\]]\\s*)`;
const SPELLED_EMAIL = new RegExp(
  `(?<![\\p{L}\\p{N}._%+\\-])[\\p{L}\\p{N}._%+\\-]+${spelled("at|arroba")}[\\p{L}\\p{N}\\-]+(?:${spelled("dot|punto|ponto|point|punkt|punt")}[\\p{L}\\p{N}\\-]+)*?${spelled("dot|punto|ponto|point|punkt|punt")}(?:${SITE_TLDS})(?![\\p{L}\\p{N}])`,
  "giu",
);

/** A text as it may go to the writing help: addresses (an at sign of any width, or spelled out), phone numbers and links (a bare domain too, in any case) taken out. Pure. */
export function forAi(value: string, max = MAX_MESSAGE): string {
  return value
    .replace(/[^\s@\uFF20\uFE6B]+[@\uFF20\uFE6B][^\s@\uFF20\uFE6B]+[.\uFF0E\u3002][^\s@\uFF20\uFE6B]+/g, "[email]")
    .replace(SPELLED_EMAIL, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    // "great.It helps": a capitalized word after a dot, with no path, starts a sentence.
    .replace(BARE_SITE, (site: string, tld: string, path: string | undefined) => (!path && /^[A-Z][a-z]+$/.test(tld) && SENTENCE_TLDS.has(tld.toLowerCase()) ? site : "[link]"))
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .slice(0, max);
}
