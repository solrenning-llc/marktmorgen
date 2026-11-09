import { leadsKey } from "@/lib/contacts";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { EXPORT_BYTES_PER_UNIT, EXPORT_COMMANDS_PER_UNIT } from "@/lib/store-export";
import { holdStudio } from "@/lib/studio-route";
import type { Store } from "@/lib/store";

/**
 * What downloading a store's list costs, counted before the list is read (R31,
 * finding 4): the list as a file (app/api/store/leads/route.ts, lib/free.ts
 * listAsCsv) and its buyers as an audience file (app/api/store/audience/route.ts,
 * lib/ad-audience.ts). Both walk the whole list, up to MAX_LEADS contacts on
 * every plan, so each takes from the store's studio figure the units of what
 * it reads and sends, at the unit of a whole store export (lib/store-export.ts:
 * EXPORT_COMMANDS_PER_UNIT commands, or EXPORT_BYTES_PER_UNIT bytes, a unit),
 * on top of the essential request that let it in.
 */

/** Contacts a page of the walk reads (HSCAN COUNT 1000 in lib/free.ts and lib/contacts.ts): a command each. */
export const LIST_CONTACTS_PER_COMMAND = 1_000;
/**
 * Bytes one contact moves through the database when its list is walked: its
 * address and its record with the reply's framing. A review ceiling, nearly
 * three times what a contact with a name and two labels reads (370 bytes in
 * the R31 proof); the file's own text is counted again on top of it (twice
 * the bytes sent, below), so a record with long product names or many form
 * answers pays for them by the file it makes.
 */
export const LIST_READ_BYTES_PER_CONTACT = 1_000;
/** Bytes held for each contact's line of the file before it is written (193 in the R31 proof); settled at what was sent. */
export const LIST_SENT_BYTES_PER_CONTACT = 500;
/** Bytes held for the file's header, the store's own fields' names among them; settled at what was sent. */
export const LIST_HEADER_BYTES = 65_536;

/**
 * The studio units a download of a list of `contacts` takes, once it has sent
 * `sent` bytes: one for the request, the walk's commands, and every byte it
 * reads and sends (the file's text counted twice: read from the database and
 * sent to the browser).
 */
export function listDownloadUnits(contacts: number, sent: number): number {
  const count = Math.max(0, Math.ceil(contacts));
  const bytes = count * LIST_READ_BYTES_PER_CONTACT + 2 * Math.max(0, Math.ceil(sent));
  return 1 + Math.ceil(Math.ceil(count / LIST_CONTACTS_PER_COMMAND) / EXPORT_COMMANDS_PER_UNIT) + Math.ceil(bytes / EXPORT_BYTES_PER_UNIT);
}

/** The units held before a download of a list of `contacts` reads it: its file at the held size of each line. */
export function listDownloadHeld(contacts: number): number {
  return listDownloadUnits(contacts, Math.max(0, contacts) * LIST_SENT_BYTES_PER_CONTACT + LIST_HEADER_BYTES);
}

/**
 * How many contacts a list holds, read in its exact shape (CX-123 rule 24):
 * one HLEN, a whole count from zero up. Any other answer throws
 * UnknownReplyError, so a download is never priced as an empty list. No list,
 * or no database, holds none.
 */
export async function listContactCount(listId: string | null | undefined): Promise<number> {
  if (!listId || !isRedisConfigured()) return 0;
  const count = countOf(repliesFor(await redisPipeline([["HLEN", leadsKey(listId)]]), 1)?.[0]);
  if (count === null) throw new UnknownReplyError("a list's HLEN");
  return count;
}

/** Said when the list's count does not read: nothing of the list was read, and nothing was taken. */
export const LIST_UNREAD_WORDS = "We could not read your list right now. Try again in a moment.";

/**
 * Takes a download's units from the store's studio figure before its list is
 * read: counted first, then held at the file's held size. Refused (nothing
 * read, nothing taken) when the count does not read (502, as a list that did
 * not read) or the figure has not the units (429, with the figure's own
 * words, as a whole store export is). `settle(sent)` then gives back what the
 * file did not need, or counts what it sent beyond them; a download whose
 * list did not read settles nothing, so nothing is given back on a read it
 * cannot measure.
 */
export async function holdListDownload(
  store: Store,
): Promise<{ ok: true; settle: (sent: number) => Promise<void> } | { ok: false; status: 429 | 502; message: string }> {
  let contacts: number;
  try {
    contacts = await listContactCount(store.listId);
  } catch (error) {
    console.error("counting a list before its download failed", error);
    return { ok: false, status: 502, message: LIST_UNREAD_WORDS };
  }
  const units = listDownloadHeld(contacts);
  const held = await holdStudio(store, units);
  if (!held.ok) return { ok: false, status: 429, message: held.message };
  return {
    ok: true,
    settle: async (sent) => {
      const used = listDownloadUnits(contacts, sent);
      if (used < units) await held.give(units - used);
      else if (used > units) await held.force(used - units);
    },
  };
}
