import { leadsKey } from "@/lib/contacts";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { EXPORT_BYTES_PER_UNIT, EXPORT_COMMANDS_PER_UNIT } from "@/lib/store-export";
import { holdStudio } from "@/lib/studio-route";
import { standingOf } from "@/lib/plan-standing";
import { ENDED_LIST_DOWNLOADS } from "@/lib/plan-closing-rules";
import { PLANS_ON_SALE } from "@/lib/opening";
import { KIND_WORDS } from "@/lib/store-allowance-rules";
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
/**
 * Bytes a contact the file leaves out moves through the database on top of
 * LIST_READ_BYTES_PER_CONTACT: the agreed-only file and the buyers audience
 * read every record to choose, and the file's text pays for none of those
 * they leave out. A review ceiling over a record at every cap a contact has
 * (its name, its labels, MAX_TITLES products asked for) with the store's
 * MAX_CRM_FIELDS fields each holding a value at its cap: 6,353 bytes a
 * person in tests/list-download-units.test.ts (review of #3354).
 */
export const LIST_UNSENT_READ_BYTES_PER_CONTACT = 7_000;
/**
 * The same for a download that reads only the list, not the store's fields
 * (the buyers audience, lib/ad-audience.ts): a record at every cap, 3,973
 * bytes a person in tests/list-download-units.test.ts.
 */
export const LIST_UNSENT_RECORD_BYTES_PER_CONTACT = 3_500;
/** Bytes held for each contact's line of the file before it is written (193 in the R31 proof); settled at what was sent. */
export const LIST_SENT_BYTES_PER_CONTACT = 500;
/** Bytes held for the file's header, the store's own fields' names among them; settled at what was sent. */
export const LIST_HEADER_BYTES = 65_536;

/**
 * The studio units a download of a list of `contacts` takes, once it has sent
 * `sent` bytes and left `unsent` of the contacts out of its file: one for the
 * request, the walk's commands, and every byte it reads and sends (the file's
 * text counted twice: read from the database and sent to the browser; each
 * contact left out at `perUnsent` more, never less than a record at its caps).
 */
export function listDownloadUnits(contacts: number, sent: number, unsent = 0, perUnsent = LIST_UNSENT_READ_BYTES_PER_CONTACT): number {
  const count = Math.max(0, Math.ceil(contacts));
  const left = Math.min(count, Math.max(0, Math.ceil(unsent)));
  const bytes = count * LIST_READ_BYTES_PER_CONTACT + 2 * Math.max(0, Math.ceil(sent)) + left * Math.max(LIST_UNSENT_RECORD_BYTES_PER_CONTACT, perUnsent);
  return 1 + Math.ceil(Math.ceil(count / LIST_CONTACTS_PER_COMMAND) / EXPORT_COMMANDS_PER_UNIT) + Math.ceil(bytes / EXPORT_BYTES_PER_UNIT);
}

/**
 * How many people a CSV file of the list holds: its records, the header
 * aside. Every cell is quoted (lib/csv.ts csvCell), so a line break inside a
 * name or a field's value is inside quotes and never counted as a person.
 */
export function csvPeople(text: string): number {
  let quoted = false;
  let records = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 34) quoted = !quoted;
    else if (c === 10 && !quoted) records += 1;
  }
  return Math.max(0, records - 1);
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
/** Said when what a download takes could not be counted: nothing of the list was read. */
export const LIST_UNCOUNTED_WORDS = "This can't be counted right now. Try again in a minute.";

/** How long the count of list downloads since a plan ended is kept: past its closing day and the week a late last notice adds, as the whole export's. */
const ENDED_LIST_SECONDS = 60 * 86_400;

/** The words for a download the studio figure has some room for, but not enough: what it needs and what is left, as holdAllowanceAt says it. */
function shortWords(store: Store, units: number, held: { limit: number; left?: number; reset?: string }): string {
  const period = standingOf(store) === "trial" ? "in this trial" : "this month";
  const needs = `This download needs ${units.toLocaleString("en-US")} of your ${KIND_WORDS.studio.many} ${period}`;
  if (held.left === undefined) return `${needs}, and your studio has ${held.limit.toLocaleString("en-US")} ${period} in all.`;
  const left = held.left === 0 ? "none are left" : held.left === 1 ? "only 1 is left" : `only ${held.left.toLocaleString("en-US")} are left`;
  return `${needs}, and ${left}.${held.reset ? ` ${held.reset}` : ""}`;
}

type ListHold = { ok: true; settle: (sent: number, people: number, perUnsent?: number) => Promise<void> } | { ok: false; status: 429 | 502 | 503; message: string };

/**
 * A store whose plan has ended downloads its list from ENDED_LIST_DOWNLOADS
 * of its own, counted for that ending as its whole export is
 * (app/api/store/export/route.ts), never from its studio figure: a list of
 * any size leaves with its owner. Priced with its closing
 * (tests/plan-cost-registry.ts, closure). A count that does not read, in its
 * exact shape (CX-123 rule 24), refuses with nothing read.
 */
async function holdEndedListDownload(store: Store): Promise<ListHold> {
  if (!isRedisConfigured() || !store.statsId) return { ok: false, status: 503, message: LIST_UNCOUNTED_WORDS };
  const key = `nl:rl:export:${store.statsId}:list-ended:${Date.parse(store.planEndedAt) || 0}`;
  let taken: number | null = null;
  try {
    const replies = repliesFor(await redisPipeline([["SET", key, "0", "EX", ENDED_LIST_SECONDS, "NX"], ["INCR", key]]), 2);
    const count = replies && (replies[0] === "OK" || replies[0] === null) ? countOf(replies[1]) : null;
    taken = count !== null && count >= 1 ? count : null;
  } catch (error) {
    console.error("counting a list download since a plan ended failed", error);
  }
  if (taken === null) return { ok: false, status: 503, message: LIST_UNCOUNTED_WORDS };
  if (taken > ENDED_LIST_DOWNLOADS) {
    const times = ENDED_LIST_DOWNLOADS === 1 ? "once" : ENDED_LIST_DOWNLOADS === 2 ? "twice" : `${ENDED_LIST_DOWNLOADS} times`;
    return {
      ok: false,
      status: 429,
      message: `You have downloaded your list ${times} since your plan ended, which is what a store whose plan has ended keeps for this.${PLANS_ON_SALE ? " Starting a plan again lets you download it again." : ""}`,
    };
  }
  return { ok: true, settle: async () => {} };
}

/**
 * Takes a download's units from the store's studio figure before its list is
 * read: counted first, then held at the file's held size. Refused (nothing
 * read, nothing taken) when the count does not read (502, as a list that did
 * not read), what it takes could not be counted (503), or the figure has not
 * the units (429, saying how many it needs and how many are left). A store
 * whose plan has ended takes from its own list downloads instead
 * (holdEndedListDownload). `settle(sent, people)` then gives back what the
 * file did not need, or counts what it sent and read beyond them, the people
 * read and left out of the file among it (each at `perUnsent`: the fields'
 * values too, unless the download reads only the list); a download whose list did not read
 * settles nothing, so nothing is given back on a read it cannot measure.
 */
export async function holdListDownload(store: Store): Promise<ListHold> {
  if (standingOf(store) === "ended") return holdEndedListDownload(store);
  let contacts: number;
  try {
    contacts = await listContactCount(store.listId);
  } catch (error) {
    console.error("counting a list before its download failed", error);
    return { ok: false, status: 502, message: LIST_UNREAD_WORDS };
  }
  const units = listDownloadHeld(contacts);
  const held = await holdStudio(store, units);
  if (!held.ok) {
    if (held.reason === "unknown") return { ok: false, status: 503, message: held.message };
    return { ok: false, status: 429, message: held.reason === "used" ? shortWords(store, units, held) : held.message };
  }
  return {
    ok: true,
    settle: async (sent, people, perUnsent = LIST_UNSENT_READ_BYTES_PER_CONTACT) => {
      // People in the file that could not be counted are taken as none: every contact read and left out.
      const unsent = Number.isSafeInteger(people) && people >= 0 ? Math.max(0, contacts - people) : contacts;
      const used = listDownloadUnits(contacts, sent, unsent, perUnsent);
      if (used < units) await held.give(units - used);
      else if (used > units) await held.force(used - units);
    },
  };
}
