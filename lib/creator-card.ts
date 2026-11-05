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
import { type DataStore, DataRoomError, TAKE_DATA, dataKey, dataTakenOf, monthOf } from "@/lib/store-data";
import { contentRoomFor, dataBytes } from "@/lib/store-data-rules";

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
  /** A phone number in the international form (+ and the country code), or nothing. */
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
  const typedPhone = line(raw.phone, 40);
  const phone = typedPhone ? crmPhone(typedPhone) : "";
  if (typedPhone === null || phone === null) return { ok: false, error: "phone" };
  const typedSite = line(raw.website, 200);
  const website = typedSite ? crmUrl(typedSite) : "";
  if (typedSite === null || website === null || (website && !website.startsWith("https://"))) return { ok: false, error: "website" };
  const note = line(raw.note, MAX_CARD_NOTE);
  if (note === null) return { ok: false, error: "note" };
  return { ok: true, card: { on, name, title, email: typedEmail, phone, website, note } };
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
 */
export function cardVcard(card: CreatorCard, storeName: string, storeUrl: string): string | null {
  if (!card.on || !card.name) return null;
  const lines = ["BEGIN:VCARD", "VERSION:4.0", `FN:${vcardText(card.name)}`, "KIND:individual"];
  if (card.title) lines.push(`TITLE:${vcardText(card.title)}`);
  if (storeName && storeName !== card.name) lines.push(`ORG:${vcardText(storeName)}`);
  if (card.email) lines.push(`EMAIL:${vcardText(card.email)}`);
  if (card.phone) lines.push(`TEL;VALUE=uri:tel:${card.phone}`);
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

const cardKey = (statsId: string) => `nl:vcard:${statsId}`;
/** The card's slot in the store's data room, as SAVE_CARD and DROP_CARD set it. */
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
  // The card and its slot in one script (SAVE_CARD): the slot is set to the card written, so a save that does not fit
  // writes nothing (DataRoomError), and two saves at once never leave a card larger than its slot (Codex L, #1961).
  const key = dataKey(room);
  if (!key || !isRedisConfigured()) throw new Error("the store's data room could not be counted");
  const now = Date.now();
  const [reply] = await redisPipeline([["EVAL", SAVE_CARD, 2, key, cardKey(statsId), contentRoomFor(room, now / 1000), monthOf(now), dataBytes([json], 1), json]]);
  const taken = dataTakenOf(room, reply, now / 1000);
  if (taken.ok) return read;
  if (taken.reason === "full") throw new DataRoomError(taken);
  throw new Error("the store's data room could not be counted");
}

/**
 * Forgets the card and gives back its room, in one script (DROP_CARD): only
 * the card read here is deleted and its slot set to nothing, and a card saved
 * since (another version) is left with its own slot (Codex L, #1961).
 */
export async function dropCreatorCard(statsId: string | null, room: DataStore): Promise<void> {
  const key = dataKey(room);
  if (!statsId || !key || !isRedisConfigured()) return;
  const [held] = await redisPipeline([["GET", cardKey(statsId)]]);
  const now = Date.now();
  await redisPipeline([["EVAL", DROP_CARD, 2, key, cardKey(statsId), contentRoomFor(room, now / 1000), monthOf(now), typeof held === "string" ? held : ""]]);
}

/** The data room's own steps (TAKE_DATA) for the card's slot, set to `size`, inside a script whose KEYS[1] is the room. */
const CARD_ROOM = `local function cardRoom(limit, always, month, size)
  local KEYS = {KEYS[1]}
  local ARGV = {limit, always, month, 's', '${CARD_SLOT}', size}
${TAKE_DATA}
end`;

/** Writes the card (KEYS[2]) and sets its slot to its size in the same step; nothing when it does not fit. Modelled by lib/redis-memory.ts. */
export const SAVE_CARD = `-- marktmorgen:card-save:v1
${CARD_ROOM}
local taken = cardRoom(ARGV[1], '0', ARGV[2], ARGV[3])
if taken[1] ~= 1 then return taken end
redis.call('SET', KEYS[2], ARGV[4])
return taken`;

/** Deletes the card (KEYS[2]) only while it is the one read (ARGV[3], "" for none) and sets its slot to nothing; a card saved since keeps its slot. Modelled by lib/redis-memory.ts. */
export const DROP_CARD = `-- marktmorgen:card-drop:v1
${CARD_ROOM}
local held = redis.call('GET', KEYS[2])
if (held or '') ~= ARGV[3] then return {2, 0} end
if held then redis.call('DEL', KEYS[2]) end
return cardRoom(ARGV[1], '1', ARGV[2], '0')`;
