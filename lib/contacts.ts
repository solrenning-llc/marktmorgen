/**
 * A store's list: everyone who gave the creator their address, and whether
 * they agreed to hear more.
 *
 * Three ways onto it as someone the creator may write to, and none of them is
 * a box ticked for anyone:
 *
 *   - asking for something free and ticking "also send me emails", then using
 *     the link we emailed (so the address is proved);
 *   - buying something and ticking the same box on the store page;
 *   - being imported by the creator, who confirms each time that the people
 *     on their file agreed to hear from them.
 *
 * One way off of their own: the unsubscribe link in every email, which works
 * in one press and is kept for good. Nothing — an import, a later purchase
 * without the box — puts somebody back on who left, except that person
 * ticking the box again.
 *
 * And one way off that is not theirs to press: an address the sender could
 * not deliver to, for good, or whose owner marked an email as spam, is taken
 * off the same way and for the same length of time (stopWriting, below, and
 * lib/mail-health.ts for why).
 *
 *   nl:store:leads:<listId>          address -> Contact (JSON)
 *   nl:store:leads:<listId>:agreed   how many agreed, ever
 *   nl:store:leads:<listId>:unsub    how many of those have since left
 *   nl:mail:unsub:<token>            listId|address|handle, for the link in an email
 *   nl:erased:<listId>               one-way fingerprints of the addresses deleted from the store (lib/suppression.ts)
 *
 * And one way off for good, by the person or the creator: deleting them
 * (lib/person-erasure.ts). Their row and its token go; what stays is a
 * fingerprint of the address, so nothing but their own yes, given again,
 * puts them back on as someone who may be written to (forgetContactPerson).
 */
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { MAX_CONTACT_NAME, MAX_IMPORT, MAX_LEADS, readTags } from "@/lib/contact-rules";
import { liftCommand, suppressedAmongCommand, suppressedCommand, wasSuppressed } from "@/lib/suppression";
import { joinedCommands } from "@/lib/joined-stores";
import { type DataStore, needData } from "@/lib/store-data";
import { type DataOwner, orderWrite } from "@/lib/order-data";
import { dataBytes } from "@/lib/store-data-rules";

/** How many product names one address keeps. */
const MAX_TITLES = 20;

// Re-exported so the many callers that import them from here keep working;
// they are declared in lib/contact-rules.ts, which a page may import too.
export { MAX_IMPORT, MAX_LEADS };

export type ContactSource = "free" | "buyer" | "import";

export type Contact = {
  /** Agreed to hear from the creator. */
  agreed: boolean;
  agreedAt: string;
  firstAt: string;
  lastAt: string;
  /** What they asked for or bought, by the name it had at the time. */
  titles: string[];
  /** The same, by product id, so a list can be narrowed to one product. */
  ids: string[];
  /** How they first agreed. */
  source: ContactSource | "";
  /** Left through the unsubscribe link, or was taken off (see `gone`). Kept for good. */
  unsub: boolean;
  unsubAt: string;
  /**
   * Why, when it was not their own unsubscribe: the address bounced for
   * good, or they marked an email as spam. Absent when they left themselves.
   */
  gone?: "bounced" | "complained";
  /** The token in their unsubscribe link, made the first time they are sent to. */
  t: string;
  /** Their name, when an import brought one (lib/imports.ts). "" when unknown. */
  name: string;
  /** Labels an import brought with them, as the creator's old platform had them. */
  tags: string[];
  /** When an import brought them or marked them as agreeing; "" when none did. */
  importedAt: string;
  /**
   * When they allowed the creator to see which links in a sequence's emails
   * they use (lib/mail-clicks.ts), by ticking a box of its own when they
   * joined; absent when they did not, or took it back. Never set by an import.
   */
  clicks?: string;
};

// Labels' rules live with the list's other pure rules, so a page may read them too (99 [E2-TAG-BROADCAST]).
export { MAX_CONTACT_NAME, MAX_CONTACT_TAGS, MAX_TAG_LENGTH, readTags } from "@/lib/contact-rules";

/**
 * What contacts take in the store's data room (lib/store-data.ts), all in
 * one slot. A contact put on the list by an order is part of what the order
 * left, so those writes pass `room` as { order: store } and are written by
 * lib/order-data.ts, which charges the room what each really adds (a buyer
 * already on the list, only what their record grew by); every other way on
 * (a sign-up, an import, the API, labels a sequence adds) takes what it grows
 * the list by first, and is refused with DataRoomError when it does not fit.
 * A contact counts for its record and, from the start, the unsubscribe link
 * it will be given (TOKEN_BYTES) and the few flags leaving adds. `room` null
 * is for the company's own lists, which are not a store's.
 */
const CONTACTS_SLOT = "ct";
export const TOKEN_BYTES = dataBytes(["0".repeat(40), "x".repeat(40 + 254 + 40)], 1) + 64;
const contactBytes = (contact: Contact | null) => (contact ? dataBytes([JSON.stringify(contact)], 1) + TOKEN_BYTES : 0);

/** Who a contact's write is counted for: the store's room, an order of the store's, or nobody (the company's own lists). */
export type ContactRoom = DataStore | { order: DataOwner } | null;

/** Takes what writing these contacts over what they were grows the list by; nothing when the writes are an order's. */
async function needContacts(room: ContactRoom, pairs: { before: Contact | null; next: Contact }[]): Promise<void> {
  if (!room || "order" in room) return;
  const grown = pairs.reduce((sum, { before, next }) => sum + Math.max(0, contactBytes(next) - contactBytes(before)), 0);
  if (grown > 0) await needData(room, [{ slot: CONTACTS_SLOT, bytes: grown }]);
}

export const leadsKey = (listId: string) => `nl:store:leads:${listId}`;
export const agreedKey = (listId: string) => `nl:store:leads:${listId}:agreed`;
export const unsubKey = (listId: string) => `nl:store:leads:${listId}:unsub`;
export const tokenKey = (token: string) => `nl:mail:unsub:${token}`;
export const UNSUB_TOKEN = /^[0-9a-f]{40}$/;

export function parseContact(raw: unknown): Contact | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Contact>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").slice(-MAX_TITLES) : []);
    return {
      agreed: value.agreed === true,
      agreedAt: typeof value.agreedAt === "string" ? value.agreedAt : "",
      firstAt: typeof value.firstAt === "string" ? value.firstAt : "",
      lastAt: typeof value.lastAt === "string" ? value.lastAt : "",
      titles: list(value.titles),
      ids: list(value.ids),
      source: value.source === "free" || value.source === "buyer" || value.source === "import" ? value.source : "",
      unsub: value.unsub === true,
      unsubAt: typeof value.unsubAt === "string" ? value.unsubAt : "",
      ...(value.unsub === true && (value.gone === "bounced" || value.gone === "complained") ? { gone: value.gone } : {}),
      t: typeof value.t === "string" && UNSUB_TOKEN.test(value.t) ? value.t : "",
      // Contacts written before imports kept names and labels have neither.
      name: typeof value.name === "string" ? value.name.slice(0, MAX_CONTACT_NAME) : "",
      tags: Array.isArray(value.tags) ? readTags(value.tags.filter((t): t is string => typeof t === "string")) : [],
      importedAt: typeof value.importedAt === "string" ? value.importedAt : "",
      ...(typeof value.clicks === "string" && value.clicks ? { clicks: value.clicks } : {}),
    };
  } catch {
    return null;
  }
}

/** Whether the creator may email this person now. */
export function mailable(contact: Contact): boolean {
  return contact.agreed && !contact.unsub;
}

export type AddResult = {
  /** Now on the list as someone who may be written to, and was not before. */
  joined: boolean;
  /** Newly recorded as having got or bought this product. */
  gotProduct: boolean;
  full: boolean;
};

/**
 * Puts an address on the list, or updates it.
 *
 * `agreed` is what this person said this time. An explicit yes — the box
 * ticked by them — also undoes an earlier unsubscribe; an import never does.
 */
export async function upsertContact(
  listId: string,
  rawEmail: string,
  input: {
    agreed: boolean;
    explicit: boolean;
    source: ContactSource;
    productId?: string;
    title?: string;
    at?: string;
    /** They also ticked the box allowing their link use to be seen (lib/mail-clicks.ts). */
    clicks?: boolean;
    /** The store's id, given when the person typed the address themselves, so asking to be deleted from every store finds this one (lib/joined-stores.ts). */
    sid?: string;
  },
  /** The store whose data room the contact takes from; { order: store } for one an order put on (lib/order-data.ts); null for the company's own lists. */
  room: ContactRoom,
): Promise<AddResult> {
  const none = { joined: false, gotProduct: false, full: false };
  if (!isRedisConfigured() || !listId) return none;
  const email = normaliseEmail(rawEmail);
  if (!email || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return none;
  const key = leadsKey(listId);
  const [raw, size, erased] = await redisPipeline([
    ["HGET", key, email],
    ["HLEN", key],
    suppressedCommand(listId, email),
  ]);
  const before = parseContact(raw);
  if (!before && Number(size) >= MAX_LEADS) return { ...none, full: true };

  const now = new Date().toISOString();
  const wasMailable = before ? mailable(before) : false;
  // Somebody deleted from this store is kept, by a fingerprint, from being
  // written to again: only their own yes, given now, lifts it. A purchase
  // without the box still records the purchase, as anyone's does.
  const deleted = wasSuppressed(erased);
  const ownYes = input.agreed && input.explicit;
  const agreed = Boolean(before?.agreed) || (input.agreed && (!deleted || ownYes));
  // A yes only undoes an unsubscribe when it was given after it: a thank-you
  // page reloaded, or a download link opened again, repeats an old tick.
  const saidAt = Date.parse(input.at || now);
  const leftAt = Date.parse(before?.unsubAt || "");
  const resubscribe =
    Boolean(before?.unsub) &&
    input.agreed &&
    input.explicit &&
    (!Number.isFinite(leftAt) || !Number.isFinite(saidAt) || saidAt > leftAt);
  const titles = before ? [...before.titles] : [];
  if (input.title && !titles.includes(input.title)) titles.push(input.title);
  const ids = before ? [...before.ids] : [];
  const gotProduct = Boolean(input.productId) && !ids.includes(input.productId!);
  if (input.productId && gotProduct) ids.push(input.productId);

  const next: Contact = {
    agreed,
    agreedAt: before?.agreed ? before.agreedAt : agreed ? input.at || now : "",
    firstAt: before?.firstAt || now,
    lastAt: now,
    titles: titles.slice(-MAX_TITLES),
    ids: ids.slice(-MAX_TITLES),
    source: before?.source || input.source,
    unsub: resubscribe ? false : Boolean(before?.unsub),
    unsubAt: resubscribe ? "" : before?.unsubAt ?? "",
    // Their own yes, given since, clears why they were taken off as well.
    ...(before?.gone && !resubscribe ? { gone: before.gone } : {}),
    t: before?.t ?? "",
    name: before?.name ?? "",
    tags: before?.tags ?? [],
    importedAt: before?.importedAt ?? "",
  };
  // Allowed only by their own tick, given with a yes to the list; kept once
  // given, unless they left since — coming back, they are asked again.
  const allowed = input.clicks === true && input.agreed && input.explicit;
  const clicks = resubscribe ? (allowed ? input.at || now : "") : before?.clicks || (allowed ? input.at || now : "");
  if (clicks) next.clicks = clicks;
  if (deleted && !agreed) delete next.clicks;
  await needContacts(room, [{ before, next }]);
  const commands: (string | number)[][] = [["HSET", key, email, JSON.stringify(next)]];
  if (agreed && !before?.agreed) commands.push(["INCR", agreedKey(listId)]);
  if (resubscribe) commands.push(["DECR", unsubKey(listId)]);
  if (deleted && ownYes) commands.push(liftCommand(listId, email));
  if (input.sid) commands.push(...joinedCommands(input.sid, email));
  if (room && "order" in room) await orderWrite(room.order, commands);
  else await redisPipeline(commands);
  return { joined: mailable(next) && !wasMailable, gotProduct, full: false };
}

/**
 * Notes that someone already on the list got a product, without adding
 * anyone who is not. Says whether they may be written to.
 */
export async function noteProduct(listId: string, rawEmail: string, productId: string, title: string, order: DataOwner): Promise<boolean> {
  if (!isRedisConfigured() || !listId) return false;
  const email = normaliseEmail(rawEmail);
  const [raw] = await redisPipeline([["HGET", leadsKey(listId), email]]);
  const before = parseContact(raw);
  if (!before) return false;
  if (!before.ids.includes(productId)) {
    const next: Contact = {
      ...before,
      lastAt: new Date().toISOString(),
      ids: [...before.ids, productId].slice(-MAX_TITLES),
      titles: (before.titles.includes(title) ? before.titles : [...before.titles, title]).slice(-MAX_TITLES),
    };
    // An order's: counted at what the record grew by (lib/order-data.ts).
    await orderWrite(order, [["HSET", leadsKey(listId), email, JSON.stringify(next)]]);
  }
  return mailable(before);
}

/** Whether this address may be written to now. */
export async function isMailable(listId: string, rawEmail: string): Promise<boolean> {
  if (!isRedisConfigured() || !listId) return false;
  const [raw] = await redisPipeline([["HGET", leadsKey(listId), normaliseEmail(rawEmail)]]);
  const contact = parseContact(raw);
  return contact !== null && mailable(contact);
}

/**
 * Brings in addresses the creator says agreed to hear from them, a few
 * hundred per round trip. Nobody who left is put back, and nobody already on
 * the list is changed except to mark that they agreed.
 */
export async function importContacts(
  listId: string,
  emails: string[],
  data: DataStore,
): Promise<{ added: number; already: number; full: boolean }> {
  if (!isRedisConfigured() || !listId || !emails.length) return { added: 0, already: emails.length, full: false };
  const key = leadsKey(listId);
  const [size] = await redisPipeline([["HLEN", key]]);
  let room = MAX_LEADS - (Number(size) || 0);
  const now = new Date().toISOString();
  let added = 0;
  let full = false;
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const [rows, prints] = await redisPipeline([["HMGET", key, ...chunk], suppressedAmongCommand(listId, chunk)]);
    const found = Array.isArray(rows) ? rows : [];
    const deleted = Array.isArray(prints) ? prints : [];
    const pairs: string[] = [];
    const sizes: { before: Contact | null; next: Contact }[] = [];
    let newlyAgreed = 0;
    chunk.forEach((email, j) => {
      // Deleted from this store: an import never brings them back.
      if (deleted[j] !== null && deleted[j] !== undefined) return;
      const before = parseContact(found[j]);
      if (!before) {
        if (room <= 0) {
          full = true;
          return;
        }
        room -= 1;
      }
      if (before && (before.agreed || before.unsub)) return;
      const next: Contact = {
        agreed: true,
        agreedAt: now,
        firstAt: before?.firstAt || now,
        lastAt: now,
        titles: before?.titles ?? [],
        ids: before?.ids ?? [],
        source: before?.source || "import",
        unsub: false,
        unsubAt: "",
        t: before?.t ?? "",
        name: before?.name ?? "",
        tags: before?.tags ?? [],
        importedAt: now,
      };
      pairs.push(email, JSON.stringify(next));
      sizes.push({ before, next });
      newlyAgreed += 1;
    });
    if (pairs.length) {
      await needContacts(data, sizes);
      await redisPipeline([
        ["HSET", key, ...pairs],
        ["INCRBY", agreedKey(listId), newlyAgreed],
      ]);
      added += newlyAgreed;
    }
  }
  return { added, already: emails.length - added, full };
}

/**
 * One row of a file of contacts, already read (lib/imports.ts). `consent` is
 * what the file and the creator together say about email (lib/clickfunnels-csv.ts):
 * absent or "agreed" for someone the creator confirmed agreed, the rule every
 * import had; "none" for a contact with no recorded consent; "unsubscribed"
 * or "undeliverable" for one who left, or could not be written to, where the
 * file came from.
 */
export type ImportedContact = { email: string; name: string; tags: string[]; consent?: "agreed" | "none" | "unsubscribed" | "undeliverable" };

/**
 * What became of one row: put on the list as someone who agreed ("added"),
 * already on it ("already"), someone who unsubscribed and is left alone
 * ("left"), no room on the list ("full"), put on it as a contact who may not
 * be emailed ("contact"), or somebody the creator could email until now whose
 * opt-out elsewhere is kept here too ("stopped").
 */
export type ContactOutcome = "added" | "already" | "left" | "full" | "contact" | "stopped";

/**
 * What one row would become, decided from what the list holds for its
 * address now; the same decision for a dry run and for the import itself.
 * `next` is what the import writes, or null when it writes nothing.
 */
export function decideContact(
  before: Contact | null,
  row: ImportedContact,
  now: string,
  /** The address was deleted from this store (lib/suppression.ts): left alone, as one who left is. */
  deleted = false,
): { outcome: Exclude<ContactOutcome, "full">; next: Contact | null; fresh: boolean } {
  if (before?.unsub || deleted) return { outcome: "left", next: null, fresh: false };
  const consent = row.consent ?? "agreed";
  const name = before?.name || row.name.slice(0, MAX_CONTACT_NAME);
  const tags = readTags([...(before?.tags ?? []), ...row.tags]);
  if (consent === "unsubscribed" || consent === "undeliverable") {
    // Their opt-out where they were is kept: taken off as if they had used
    // the link here, so no later import puts them back; only their own tick
    // on one of the creator's pages can (upsertContact).
    const base: Contact = before
      ? { ...before, name, tags }
      : { agreed: false, agreedAt: "", firstAt: now, lastAt: now, titles: [], ids: [], source: "import", unsub: false, unsubAt: "", t: "", name, tags, importedAt: now };
    const { clicks: _left, ...kept } = base;
    void _left;
    const next: Contact = { ...kept, unsub: true, unsubAt: now, ...(consent === "undeliverable" ? { gone: "bounced" as const } : {}) };
    return { outcome: before ? (before.agreed ? "stopped" : "already") : "contact", next, fresh: !before };
  }
  if (consent === "none") {
    if (before) {
      const changed = name !== before.name || tags.length !== before.tags.length;
      return { outcome: "already", next: changed ? { ...before, name, tags } : null, fresh: false };
    }
    return {
      outcome: "contact",
      next: { agreed: false, agreedAt: "", firstAt: now, lastAt: now, titles: [], ids: [], source: "import", unsub: false, unsubAt: "", t: "", name, tags, importedAt: now },
      fresh: true,
    };
  }
  if (before?.agreed) {
    // Already agreeing: only a missing name or new labels are written.
    const changed = name !== before.name || tags.length !== before.tags.length;
    return { outcome: "already", next: changed ? { ...before, name, tags } : null, fresh: false };
  }
  return {
    outcome: "added",
    next: {
      agreed: true,
      agreedAt: now,
      firstAt: before?.firstAt || now,
      lastAt: now,
      titles: before?.titles ?? [],
      ids: before?.ids ?? [],
      source: before?.source || "import",
      unsub: false,
      unsubAt: "",
      t: before?.t ?? "",
      name,
      tags,
      importedAt: now,
    },
    fresh: !before,
  };
}

/**
 * What a chunk of rows would become, read from the list but written nowhere:
 * the dry run of importContactRows, and how many new addresses the list still
 * has room for.
 */
export async function previewContactRows(
  listId: string | null,
  rows: ImportedContact[],
): Promise<{ outcomes: { outcome: Exclude<ContactOutcome, "full">; fresh: boolean }[]; room: number }> {
  const now = new Date().toISOString();
  const decide = (before: Contact | null, row: ImportedContact, deleted = false) => {
    const { outcome, fresh } = decideContact(before, row, now, deleted);
    return { outcome, fresh };
  };
  if (!rows.length) return { outcomes: [], room: MAX_LEADS };
  // A store whose list is made when its first import starts: everything is new.
  if (!isRedisConfigured() || !listId) return { outcomes: rows.map((row) => decide(null, row)), room: MAX_LEADS };
  const key = leadsKey(listId);
  const [size, found, prints] = await redisPipeline([
    ["HLEN", key],
    ["HMGET", key, ...rows.map((r) => r.email)],
    suppressedAmongCommand(listId, rows.map((r) => r.email)),
  ]);
  const existing = Array.isArray(found) ? found : [];
  const deleted = Array.isArray(prints) ? prints : [];
  return {
    outcomes: rows.map((row, i) => decide(parseContact(existing[i]), row, deleted[i] !== null && deleted[i] !== undefined)),
    room: Math.max(0, MAX_LEADS - (Number(size) || 0)),
  };
}

/**
 * Brings in one chunk of a file of contacts, in two round trips. The rules
 * are importContacts's, with the file's names and labels kept, and what each
 * row says about consent (decideContact):
 *
 *   - nobody who unsubscribed is put back, whatever the file says;
 *   - somebody already on the list who agreed keeps everything; the file
 *     only fills in a name they did not have and adds its labels;
 *   - somebody on the list who never agreed (they asked for something free
 *     and left the box empty) is marked as agreeing now, from the import,
 *     only when the creator confirmed it for this row;
 *   - somebody new is added as agreeing, marked as brought by an import on
 *     this date, or, without that confirmation, as a contact who may not be
 *     emailed;
 *   - somebody the file says left where they were is kept as having left here.
 *
 * Nobody is emailed because of any of it: no welcome, no sequence.
 *
 * Each address is written only if it is still as it was read (CAS_HSET): the
 * import reads a chunk, decides, then writes, and somebody who unsubscribes
 * in between must not be written back as agreeing. An address that changed
 * meanwhile is read again and left as it now is.
 */
export async function importContactRows(listId: string, rows: ImportedContact[], data: DataStore): Promise<ContactOutcome[]> {
  if (!isRedisConfigured() || !listId || rows.length === 0) return rows.map(() => "full");
  const key = leadsKey(listId);
  const [size, found, prints] = await redisPipeline([
    ["HLEN", key],
    ["HMGET", key, ...rows.map((r) => r.email)],
    suppressedAmongCommand(listId, rows.map((r) => r.email)),
  ]);
  let room = MAX_LEADS - (Number(size) || 0);
  const now = new Date().toISOString();
  const existing = Array.isArray(found) ? found : [];
  const deleted = Array.isArray(prints) ? prints : [];
  // Each write, with the fingerprint of what its address held when read.
  const writes: { email: string; value: string; was: string; row: number }[] = [];
  const sizes: { before: Contact | null; next: Contact }[] = [];
  let newlyAgreed = 0;
  let newlyLeft = 0;
  const outcomes = rows.map((row, i): ContactOutcome => {
    const before = parseContact(existing[i]);
    const decided = decideContact(before, row, now, deleted[i] !== null && deleted[i] !== undefined);
    if (decided.fresh) {
      if (room <= 0) return "full";
      room -= 1;
    }
    if (decided.next) {
      const raw = existing[i];
      writes.push({ email: row.email, value: JSON.stringify(decided.next), was: typeof raw === "string" ? sha1(raw) : "", row: i });
      sizes.push({ before, next: decided.next });
    }
    if (decided.outcome === "added") newlyAgreed += 1;
    if (decided.outcome === "stopped") newlyLeft += 1;
    return decided.outcome;
  });
  if (!writes.length) return outcomes;
  // What the rows grow the list by takes room first: past it, none of them is written.
  await needContacts(data, sizes);
  const written = await casWrite(key, writes);
  const lost = writes.filter((_, i) => !written[i]);
  if (lost.length) {
    // Changed in the moment between: whatever it is now stands.
    const [now] = await redisPipeline([["HMGET", key, ...lost.map((w) => w.email)]]);
    lost.forEach((w, i) => {
      const contact = parseContact(Array.isArray(now) ? now[i] : null);
      if (outcomes[w.row] === "added") newlyAgreed -= 1;
      if (outcomes[w.row] === "stopped") newlyLeft -= 1;
      outcomes[w.row] = contact?.unsub ? "left" : "already";
    });
  }
  const counters: (string | number)[][] = [];
  if (newlyAgreed > 0) counters.push(["INCRBY", agreedKey(listId), newlyAgreed]);
  // Somebody who agreed and has now left counts with those who left, as an unsubscribe does.
  if (newlyLeft > 0) counters.push(["INCRBY", unsubKey(listId), newlyLeft]);
  if (counters.length) await redisPipeline(counters);
  return outcomes;
}

const sha1 = (value: string) => createHash("sha1").update(value).digest("hex");

/** Sets each field only if it still holds what was read (by its SHA-1, "" for none); one step on the Redis side. */
const CAS_HSET = [
  "local out = {}",
  "for i = 1, #ARGV, 3 do",
  '  local cur = redis.call("HGET", KEYS[1], ARGV[i])',
  '  local seen = ""',
  "  if cur then seen = redis.sha1hex(cur) end",
  "  if seen == ARGV[i + 1] then",
  '    redis.call("HSET", KEYS[1], ARGV[i], ARGV[i + 2])',
  "    out[#out + 1] = 1",
  "  else",
  "    out[#out + 1] = 0",
  "  end",
  "end",
  "return out",
].join("\n");

/**
 * Writes each field that still holds what was read; says which were written.
 * Upstash runs the script; where a Redis does not (the local stand-ins), the
 * same check is made as a read just before the write, which keeps the rule
 * and only narrows the gap rather than closing it.
 */
async function casWrite(key: string, writes: { email: string; value: string; was: string }[]): Promise<boolean[]> {
  try {
    const [result] = await redisPipeline([["EVAL", CAS_HSET, 1, key, ...writes.flatMap((w) => [w.email, w.was, w.value])]]);
    if (Array.isArray(result) && result.length === writes.length) return result.map((v) => Number(v) === 1);
    throw new Error("unexpected answer");
  } catch {
    const [now] = await redisPipeline([["HMGET", key, ...writes.map((w) => w.email)]]);
    const same = writes.map((w, i) => {
      const raw = Array.isArray(now) ? now[i] : null;
      return (typeof raw === "string" ? sha1(raw) : "") === w.was;
    });
    const pairs = writes.flatMap((w, i) => (same[i] ? [w.email, w.value] : []));
    if (pairs.length) await redisPipeline([["HSET", key, ...pairs]]);
    return same;
  }
}

/**
 * Changes the labels of these contacts as `change` decides for each, read
 * the moment before: a new list of labels, "same" when they already are as
 * they should be, or "skip" when the change cannot be made. Each is written
 * only if the contact still holds what was read (casWrite), so an
 * unsubscribe or a purchase noted in the same moment is never written over;
 * one that changed is read again and decided again, three times at most.
 */
export async function changeLabels(
  listId: string,
  emails: string[],
  change: (tags: string[]) => string[] | "same" | "skip",
  /** The store whose data room new labels take from (DataRoomError when they do not fit). */
  room: DataStore,
): Promise<{ changed: string[]; same: string[] }> {
  const key = leadsKey(listId);
  const changed: string[] = [];
  const same: string[] = [];
  let pending = [...new Set(emails)];
  for (let round = 0; round < 3 && pending.length; round += 1) {
    const [rows] = await redisPipeline([["HMGET", key, ...pending]]);
    const writes: { email: string; value: string; was: string }[] = [];
    const sizes: { before: Contact | null; next: Contact }[] = [];
    pending.forEach((email, i) => {
      const raw = Array.isArray(rows) ? rows[i] : null;
      const contact = parseContact(raw);
      if (!contact || typeof raw !== "string") return;
      const next = change(contact.tags);
      if (next === "same") same.push(email);
      else if (next !== "skip") {
        writes.push({ email, value: JSON.stringify({ ...contact, tags: next }), was: sha1(raw) });
        sizes.push({ before: contact, next: { ...contact, tags: next } });
      }
    });
    if (!writes.length) break;
    await needContacts(room, sizes);
    const written = await casWrite(key, writes);
    pending = writes.filter((_, i) => !written[i]).map((w) => w.email);
    writes.forEach((w, i) => {
      if (written[i]) changed.push(w.email);
    });
  }
  return { changed, same };
}

/**
 * The token for each address's unsubscribe link, made once and kept. Read at
 * the moment of sending, so anyone who left since the send began is not in
 * the answer and is not written to.
 */
export async function tokensFor(
  listId: string,
  emails: string[],
  handle: string,
  /** Filled with those of them who allowed their link use to be seen (lib/mail-clicks.ts), when given. */
  counting?: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!emails.length) return out;
  const key = leadsKey(listId);
  let pending = [...emails];
  // A row changed between the read and the write (a purchase noted, a name
  // added) is read again and tried again; one that left meanwhile is dropped.
  for (let round = 0; round < 3 && pending.length; round += 1) {
    const [rows] = await redisPipeline([["HMGET", key, ...pending]]);
    const found = Array.isArray(rows) ? rows : [];
    const writes: { email: string; value: string; was: string; token: string }[] = [];
    pending.forEach((email, i) => {
      const raw = found[i];
      const contact = parseContact(raw);
      if (!contact || !mailable(contact) || typeof raw !== "string") return;
      if (contact.clicks) counting?.add(email);
      if (contact.t) {
        out.set(email, contact.t);
        return;
      }
      const token = randomBytes(20).toString("hex");
      writes.push({ email, value: JSON.stringify({ ...contact, t: token }), was: sha1(raw), token });
    });
    if (!writes.length) break;
    // The token's own record first, so a link is never sent that leads
    // nowhere; then each contact only if it is still as it was read, so an
    // unsubscribe made meanwhile is never written over, and two sends at
    // once keep one token between them.
    await redisPipeline(writes.map((w) => ["SET", tokenKey(w.token), `${listId}|${w.email}|${handle}`]));
    const done = await casWrite(key, writes);
    writes.forEach((w, i) => {
      if (done[i]) out.set(w.email, w.token);
    });
    const lost = writes.filter((_, i) => !done[i]);
    if (lost.length) await redisPipeline(lost.map((w) => ["DEL", tokenKey(w.token)]));
    pending = lost.map((w) => w.email);
  }
  return out;
}

/** Who an unsubscribe link belongs to, without acting on it. */
export async function readUnsubToken(
  token: string,
): Promise<{ listId: string; email: string; handle: string; contact: Contact } | null> {
  if (!UNSUB_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", tokenKey(token)]]);
  if (typeof raw !== "string") return null;
  // listId|address|handle — an address may itself hold a "|".
  const first = raw.indexOf("|");
  const last = raw.lastIndexOf("|");
  if (first < 1 || last <= first) return null;
  const listId = raw.slice(0, first);
  const email = raw.slice(first + 1, last);
  const handle = raw.slice(last + 1);
  if (!email) return null;
  const [row] = await redisPipeline([["HGET", leadsKey(listId), email]]);
  const contact = parseContact(row);
  return contact && contact.t === token ? { listId, email, handle, contact } : null;
}

/** Takes an address off the list for good. Safe to press twice. */
export async function unsubscribe(token: string): Promise<{ listId: string; email: string } | null> {
  const found = await readUnsubToken(token);
  if (!found) return null;
  const { listId, email, contact } = found;
  if (contact.unsub) return { listId, email };
  // Leaving takes back the permission to see their link use as well.
  const { clicks: _left, ...kept } = contact;
  void _left;
  const next: Contact = { ...kept, unsub: true, unsubAt: new Date().toISOString() };
  const commands: (string | number)[][] = [["HSET", leadsKey(listId), email, JSON.stringify(next)]];
  if (contact.agreed) commands.push(["INCR", unsubKey(listId)]);
  await redisPipeline(commands);
  return { listId, email };
}

/**
 * Takes an address off a list because the sender said so: it bounced for
 * good, or its owner marked an email as spam. Counted with those who left,
 * and kept as firmly — an import never puts it back.
 *
 * True when this took somebody off who could be written to until now; false
 * when the list does not hold the address, or it had already left.
 */
export async function stopWriting(listId: string, rawEmail: string, why: "bounced" | "complained"): Promise<boolean> {
  if (!isRedisConfigured() || !listId) return false;
  const email = normaliseEmail(rawEmail);
  if (!email || email.length > MAX_EMAIL_LENGTH) return false;
  const key = leadsKey(listId);
  // Written only if the address still holds what was read: a purchase noted,
  // or their own unsubscribe, in the same moment is not written over.
  for (let round = 0; round < 3; round += 1) {
    const [raw] = await redisPipeline([["HGET", key, email]]);
    const contact = parseContact(raw);
    if (!contact || contact.unsub || typeof raw !== "string") return false;
    const { clicks: _left, ...kept } = contact;
    void _left;
    const next: Contact = { ...kept, unsub: true, unsubAt: new Date().toISOString(), gone: why };
    const [written] = await casWrite(key, [{ email, value: JSON.stringify(next), was: sha1(raw) }]);
    if (!written) continue;
    if (contact.agreed) await redisPipeline([["INCR", unsubKey(listId)]]);
    return contact.agreed;
  }
  return false;
}

export type ListCounts = { total: number; agreed: number; left: number; mailable: number; full: boolean };

export async function listCounts(listId: string | null): Promise<ListCounts> {
  if (!listId || !isRedisConfigured()) return { total: 0, agreed: 0, left: 0, mailable: 0, full: false };
  const [total, agreed, left] = await redisPipeline([
    ["HLEN", leadsKey(listId)],
    ["GET", agreedKey(listId)],
    ["GET", unsubKey(listId)],
  ]);
  const t = Number(total) || 0;
  const a = Math.min(t, Number(agreed) || 0);
  const l = Math.min(a, Math.max(0, Number(left) || 0));
  return { total: t, agreed: a, left: l, mailable: a - l, full: t >= MAX_LEADS };
}

/**
 * Walks the whole list, page by page, calling `each` for every address. A
 * large list never has to fit in one answer from Redis.
 */
export async function forEachContact(
  listId: string,
  each: (email: string, contact: Contact) => void,
): Promise<void> {
  if (!isRedisConfigured()) return;
  const key = leadsKey(listId);
  let cursor = "0";
  for (let page = 0; page < MAX_LEADS / 500 + 10; page += 1) {
    const [reply] = await redisPipeline([["HSCAN", key, cursor, "COUNT", 1000]]);
    if (!Array.isArray(reply) || reply.length < 2) break;
    cursor = String(reply[0]);
    const flat = Array.isArray(reply[1]) ? (reply[1] as unknown[]) : [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const contact = parseContact(flat[i + 1]);
      if (contact) each(String(flat[i]), contact);
    }
    if (cursor === "0") break;
  }
}

/**
 * Everyone the creator may write to, narrowed when asked.
 *
 * `productId` keeps only the people who got that one thing. `notProductId`
 * drops everyone who already has another one — and that second filter is
 * the one that makes a list worth having. Until it existed a creator could
 * write to everybody, or to the buyers of one product, and not to the
 * obvious third group: the people who took the free guide and have not
 * bought the course. That is the letter that sells, and it could not be
 * addressed.
 *
 * Both read `ids`, which has been on every contact since the beginning —
 * what each person asked for or bought, by product id. No new tracking, no
 * new record, nothing stored about anybody that was not stored before.
 */
export async function audience(
  listId: string,
  productId?: string,
  notProductId?: string,
  who?: { kind: Who; paid: ReadonlySet<string> },
  /** What spending, channel and quiet days narrow it to (lib/segments.ts); undefined for no narrowing. */
  keep?: (email: string) => boolean,
  /** Only people who carry this label (99 [E2-TAG-BROADCAST]), compared as a sequence compares one: case and spaces at the ends aside. Read from the same record, so no extra read. */
  label?: string,
): Promise<string[]> {
  const out: string[] = [];
  const wanted = label?.trim().toLocaleLowerCase() ?? "";
  await forEachContact(listId, (email, contact) => {
    if (!mailable(contact)) return;
    if (productId && !contact.ids.includes(productId)) return;
    if (notProductId && contact.ids.includes(notProductId)) return;
    if (who && who.kind !== "all" && isBuyer(contact, who.paid) !== (who.kind === "buyers")) return;
    if (wanted && !contact.tags.some((t) => t.trim().toLocaleLowerCase() === wanted)) return;
    if (keep && !keep(email)) return;
    out.push(email);
  });
  return out;
}

/**
 * The two halves of a list that are worth writing to differently.
 *
 *   buyers   have paid for something. The cheapest sale there is: somebody
 *            who has already decided the creator is worth money.
 *   leads    agreed to hear from the creator — took something free, joined a
 *            waitlist, came in on an import — and have not bought yet. The
 *            people a first offer is for.
 *
 * Read from what a contact has always carried, like the two narrowings
 * above: what they asked for or bought, and how they first agreed. A buyer is
 * somebody holding a product that is sold for money today, or who first
 * agreed at a checkout — the second half so that deleting a product, or
 * making it free, does not turn the people who paid for it back into leads.
 */
export type Who = "all" | "buyers" | "leads";
export const WHO: readonly Who[] = ["all", "buyers", "leads"];

export function isBuyer(contact: Pick<Contact, "ids" | "source">, paid: ReadonlySet<string>): boolean {
  return contact.source === "buyer" || contact.ids.some((id) => paid.has(id));
}

/** Addresses read out of whatever the creator pasted or uploaded. */
export function readAddresses(text: string): { emails: string[]; skipped: number } {
  const found = new Set<string>();
  let skipped = 0;
  for (const piece of text.split(/[\s,;"'<>()]+/)) {
    const candidate = piece.trim();
    if (!candidate.includes("@")) continue;
    const email = normaliseEmail(candidate);
    if (email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email)) found.add(email);
    else skipped += 1;
  }
  return { emails: [...found], skipped };
}

/** Takes one from a count, never below nothing: a count that drifted is never made negative. */
export const DECR_TO_ZERO = `-- marktmorgen:decr-to-zero:v1
local n = tonumber(redis.call("GET", KEYS[1]) or "0") or 0
if n > 0 then return redis.call("DECR", KEYS[1]) end
return 0`;

/**
 * Deletes one address from the list (lib/person-erasure.ts): its row, the
 * token in its unsubscribe link, and its place in the list's counts. What
 * stays is lib/suppression.ts's fingerprint, written before this by the
 * erasure, so the address is never written to again. Answers how many
 * records went. Safe to run twice.
 */
export async function forgetContactPerson(listId: string | null, rawEmail: string): Promise<number> {
  if (!listId || !isRedisConfigured()) return 0;
  const email = normaliseEmail(rawEmail);
  const [raw] = await redisPipeline([["HGET", leadsKey(listId), email]]);
  const contact = parseContact(raw);
  if (!contact) return 0;
  const commands: (string | number)[][] = [["HDEL", leadsKey(listId), email]];
  if (contact.t) commands.push(["DEL", tokenKey(contact.t)]);
  if (contact.agreed) commands.push(["EVAL", DECR_TO_ZERO, 1, agreedKey(listId)]);
  if (contact.agreed && contact.unsub) commands.push(["EVAL", DECR_TO_ZERO, 1, unsubKey(listId)]);
  await redisPipeline(commands);
  return contact.t ? 2 : 1;
}
