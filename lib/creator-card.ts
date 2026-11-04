/**
 * The creator's digital business card: 639 [GL7](22), unit 1. What the
 * creator chooses to put on it (only what they typed for it: nothing is
 * copied from their account, their mail settings or their payments), the
 * "Save contact" file made from it (vCard 4.0, RFC 6350), and where it is
 * kept:
 *
 *   nl:vcard:<statsId> -> the card, as JSON (CreatorCard)
 *
 * The card is off until the creator turns it on, and only a card that is on
 * is ever shown or given as a file. The record takes room in the store's
 * data room (lib/store-data.ts) before it is written, is checked again when
 * read back (parseCard), and goes with the store.
 */
import { crmPhone, crmUrl } from "@/lib/crm-rules";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

export const MAX_CARD_NAME = 80;
export const MAX_CARD_TITLE = 80;
export const MAX_CARD_EMAIL = 254;
export const MAX_CARD_NOTE = 300;

export type CreatorCard = {
  /** Shown and given only while true. */
  on: boolean;
  /** The name on the card: a person's or the business's. */
  name: string;
  /** What they do, as they put it ("Course creator"), or nothing. */
  title: string;
  /** An address they want people to write to, or nothing. */
  email: string;
  /** A phone number as the creator typed it, grouped their way, with + (or 00) and the country code; dialled from its digits (crmPhone). Or nothing. */
  phone: string;
  /** Their own website, https, or nothing. */
  website: string;
  /** A short line under the name, or nothing. */
  note: string;
};

export const NO_CARD: CreatorCard = { on: false, name: "", title: "", email: "", phone: "", website: "", note: "" };

export type CardRefusal = "name" | "title" | "email" | "phone" | "website" | "note";

/** What each refusal tells the creator, in plain words, with what to do. */
export const CARD_REFUSALS: Record<CardRefusal, string> = {
  name: `Type the name for your card, up to ${MAX_CARD_NAME} characters.`,
  title: `Keep what you do to ${MAX_CARD_TITLE} characters.`,
  email: "Type a whole email address, like name@example.com, or leave it empty.",
  phone: "Type the phone number with + and the country code first, or leave it empty.",
  website: "Type your website's whole address, starting with https://, or leave it empty.",
  note: `Keep the line under your name to ${MAX_CARD_NOTE} characters.`,
};

const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,185}\.[^\s@<>()",;:]{2,63}$/;

/** One line of text: spaces and line breaks made single spaces, trimmed; null when longer than allowed. */
function line(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : null;
}

/** A card as the creator sent it, made safe, or what is wrong with it. Never cut: a value too long is refused. */
export function readCard(raw: Record<string, unknown>): { ok: true; card: CreatorCard } | { ok: false; error: CardRefusal } {
  const on = raw.on === true;
  const name = line(raw.name, MAX_CARD_NAME);
  if (name === null || (on && !name)) return { ok: false, error: "name" };
  const title = line(raw.title, MAX_CARD_TITLE);
  if (title === null) return { ok: false, error: "title" };
  const typedEmail = line(raw.email, MAX_CARD_EMAIL);
  if (typedEmail === null || (typedEmail && !EMAIL.test(typedEmail))) return { ok: false, error: "email" };
  // Kept as typed, so it shows grouped as the creator wrote it; only a number crmPhone dials is taken.
  const typedPhone = line(raw.phone, 40);
  if (typedPhone === null || (typedPhone && crmPhone(typedPhone) === null)) return { ok: false, error: "phone" };
  const typedSite = line(raw.website, 200);
  const website = typedSite ? crmUrl(typedSite) : "";
  if (typedSite === null || website === null || (website && !website.startsWith("https://"))) return { ok: false, error: "website" };
  const note = line(raw.note, MAX_CARD_NOTE);
  if (note === null) return { ok: false, error: "note" };
  return { ok: true, card: { on, name, title, email: typedEmail, phone: typedPhone, website, note } };
}

/** A card as read back: checked again, and off whenever any of it fails. */
export function parseCard(raw: unknown): CreatorCard {
  if (!raw || typeof raw !== "object") return NO_CARD;
  const read = readCard(raw as Record<string, unknown>);
  return read.ok ? read.card : NO_CARD;
}

/** A text value as a vCard writes it (RFC 6350 3.4): backslash, comma, semicolon and line breaks escaped. */
export function vcardText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r\n|\r|\n/g, "\\n");
}

/** A content line folded at 75 octets (RFC 6350 3.2), never inside a character, each piece ended by CRLF. */
export function foldLine(text: string): string {
  const pieces: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    // The first line holds 75 octets; each folded one starts with a space, so holds 74 more.
    if (octets + size > (pieces.length ? 74 : 75)) {
      pieces.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  pieces.push(current);
  return pieces.join("\r\n ") + "\r\n";
}

/**
 * The "Save contact" file for a card that is on, with the store's own page
 * as a second link; null for a card that is off. Only what the card holds.
 *
 * N, which vCard 3.0 requires and some contact apps still read, holds the
 * whole name as the given name: which word is a family name, or whether it
 * is a person's name at all (the field invites a business's), is never
 * guessed, so every app shows the name as typed. No KIND, for the same
 * reason: the card does not say whether it is a person or a business.
 */
export function cardVcard(card: CreatorCard, storeName: string, storeUrl: string): string | null {
  if (!card.on || !card.name) return null;
  const lines = ["BEGIN:VCARD", "VERSION:4.0", `FN:${vcardText(card.name)}`, `N:;${vcardText(card.name)};;;`];
  if (card.title) lines.push(`TITLE:${vcardText(card.title)}`);
  if (storeName && storeName !== card.name) lines.push(`ORG:${vcardText(storeName)}`);
  if (card.email) lines.push(`EMAIL:${vcardText(card.email)}`);
  const tel = card.phone ? crmPhone(card.phone) : null;
  if (tel) lines.push(`TEL;VALUE=uri:tel:${tel}`);
  if (card.website) lines.push(`URL:${card.website}`);
  if (storeUrl && storeUrl !== card.website) lines.push(`URL:${storeUrl}`);
  if (card.note) lines.push(`NOTE:${vcardText(card.note)}`);
  lines.push("END:VCARD");
  return lines.map(foldLine).join("");
}

/** The file's name: the card's name in plain letters, or "contact". */
export function vcardFileName(card: CreatorCard): string {
  const plain = card.name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .toLowerCase();
  return `${plain || "contact"}.vcf`;
}

/**
 * The same name as written, for Content-Disposition's filename* (RFC 6266,
 * RFC 8187), for a name with letters outside plain ASCII: letters in any
 * script kept, what a file name cannot hold made "-", percent-encoded as
 * UTF-8. Null for a plain ASCII name, whose plain file name says it already;
 * browsers that do not read filename* use the plain one.
 */
export function vcardFileNameStar(card: CreatorCard): string | null {
  if (!/[^\u0000-\u007f]/.test(card.name)) return null;
  const cleaned = card.name
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "");
  // Cut by characters, never inside one.
  const written = Array.from(cleaned).slice(0, 60).join("");
  const name = `${written || "contact"}.vcf`;
  return `UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

const cardKey = (statsId: string) => `nl:vcard:${statsId}`;
const CARD_SLOT = "card";
/** The longest record a card can make, with room for JSON's quoting. */
export const MAX_STORED_CARD_BYTES = (MAX_CARD_NAME + MAX_CARD_TITLE + MAX_CARD_EMAIL + 40 + 200 + MAX_CARD_NOTE) * 6 + 256;

/** A store's card, or the empty one that is off (also when it cannot be read). */
export async function readCreatorCard(statsId: string | null): Promise<CreatorCard> {
  if (!statsId || !isRedisConfigured()) return NO_CARD;
  const [raw] = await redisPipeline([["GET", cardKey(statsId)]]);
  if (typeof raw !== "string" || !raw || raw.length > MAX_STORED_CARD_BYTES) return NO_CARD;
  try {
    return parseCard(JSON.parse(raw));
  } catch {
    return NO_CARD;
  }
}

/** Keeps a card as sent, after its room is taken; refused with the rule's reason, and then nothing is written. */
export async function saveCreatorCard(statsId: string, raw: Record<string, unknown>, room: DataStore): Promise<{ ok: true; card: CreatorCard } | { ok: false; error: CardRefusal }> {
  const read = readCard(raw);
  if (!read.ok) return read;
  const json = JSON.stringify(read.card);
  // Room first: a save that does not fit throws DataRoomError and nothing is written.
  await needData(room, [{ slot: CARD_SLOT, bytes: dataBytes([json], 1), set: true }]);
  await redisPipeline([["SET", cardKey(statsId), json]]);
  return read;
}

/** Forgets the card and gives back its room. */
export async function dropCreatorCard(statsId: string | null, room: DataStore): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  await redisPipeline([["DEL", cardKey(statsId)]]);
  await giveData(room, [{ slot: CARD_SLOT, bytes: 0, set: true }]);
}
