import { CONTACT_READ_BYTES, LIST_PAGE_READ_BYTES, type ListRead, leadsKey, plainRead } from "@/lib/contacts";
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
 * What downloading a store's list costs, held before each read of the list
 * and counted at what each read moved (R31, finding 4; second cost review of
 * #3354): the list as a file (app/api/store/leads/route.ts, lib/free.ts
 * listAsCsv) and its buyers as an audience file (app/api/store/audience/route.ts,
 * lib/ad-audience.ts). Both walk the whole list, up to MAX_LEADS contacts on
 * every plan, so each takes from the store's studio figure the units of what
 * it reads and sends, at the unit of a whole store export (lib/store-export.ts:
 * EXPORT_COMMANDS_PER_UNIT commands, or EXPORT_BYTES_PER_UNIT bytes, a unit),
 * on top of the essential request that let it in.
 */

/** Contacts a page of the walk reads (HSCAN COUNT 1000 in lib/free.ts and lib/contacts.ts): a command each. */
export const LIST_CONTACTS_PER_COMMAND = 1_000;
/** Bytes held for each contact's read before the walk, at a contact with a name and two labels (370 bytes in the R31 proof); settled at what was read. */
export const LIST_READ_BYTES_PER_CONTACT = 1_000;
/** Bytes held for each contact's line of the file before it is written (193 in the R31 proof); settled at what was sent. */
export const LIST_SENT_BYTES_PER_CONTACT = 500;
/** Bytes held for the file's header, the store's own fields' names among them; settled at what was sent. */
export const LIST_HEADER_BYTES = 65_536;
/** The bytes around each command's answer in a pipeline's reply ({"result":…}, and a comma). */
export const REPLY_FRAME_BYTES = 12;

/**
 * The studio units a download takes once it has sent `commands` commands and
 * moved `bytes` bytes, read from the database and sent to the browser: one for
 * the request, and the rest at the unit of a whole store export.
 */
export function listDownloadUnits(commands: number, bytes: number): number {
  return 1 + Math.ceil(Math.max(0, Math.ceil(commands)) / EXPORT_COMMANDS_PER_UNIT) + Math.ceil(Math.max(0, Math.ceil(bytes)) / EXPORT_BYTES_PER_UNIT);
}

/**
 * The most bytes a page of the walk of a list of `contacts` can answer with:
 * HSCAN's COUNT is only a hint (a small hash answers whole, and so does
 * lib/redis-memory.ts), so a page is held at the larger of a page of COUNT
 * contacts and the whole list as counted, each contact at CONTACT_READ_BYTES.
 */
export function listPageMost(contacts: number): number {
  return Math.max(LIST_PAGE_READ_BYTES, Math.max(0, Math.ceil(contacts)) * CONTACT_READ_BYTES);
}

/**
 * The units held before a download of a list of `contacts` reads it: its
 * pages, each contact read and written at the held size, and a page at the
 * most it can answer with (listPageMost), so a list of ordinary contacts is
 * held once. Each read is held again before it is made when what was read
 * so far and that read at its most need more (holdListDownload).
 */
export function listDownloadHeld(contacts: number): number {
  const count = Math.max(0, Math.ceil(contacts));
  return listDownloadUnits(Math.ceil(count / LIST_CONTACTS_PER_COMMAND) + 1, count * (LIST_READ_BYTES_PER_CONTACT + LIST_SENT_BYTES_PER_CONTACT) + LIST_HEADER_BYTES + listPageMost(count));
}

/**
 * The most bytes `value` takes written as JSON, as the database's answer
 * writes it: every character at its widest (a control character, a <, > or &,
 * or a line or paragraph separator escaped in six; a quote or a backslash in
 * two; a lone surrogate in six), so what a read moved is never counted short.
 */
export function jsonBytes(value: unknown): number {
  if (typeof value === "string") {
    let n = 2;
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      if (c < 0x20 || c === 0x26 || c === 0x3c || c === 0x3e || c === 0x2028 || c === 0x2029) n += 6;
      else if (c === 0x22 || c === 0x5c) n += 2;
      else if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        n += 4;
        i += 1;
      } else if (c >= 0xd800 && c <= 0xdfff) n += 6;
      else n += 3;
    }
    return n;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + jsonBytes(v) + 1, 2);
  if (value && typeof value === "object") return Object.entries(value).reduce((sum, [k, v]) => sum + jsonBytes(k) + jsonBytes(v) + 2, 2);
  return 4;
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
function shortWords(store: Store, units: number, held: { limit: number; left?: number; reset?: string }, atLeast = false): string {
  const period = standingOf(store) === "trial" ? "in this trial" : "this month";
  const needs = `This download needs ${atLeast ? "at least " : ""}${units.toLocaleString("en-US")} of your ${KIND_WORDS.studio.many} ${period}`;
  if (held.left === undefined) return `${needs}, and your studio has ${held.limit.toLocaleString("en-US")} ${period} in all.`;
  const left = held.left === 0 ? "none are left" : held.left === 1 ? "only 1 is left" : `only ${held.left.toLocaleString("en-US")} are left`;
  return `${needs}, and ${left}.${held.reset ? ` ${held.reset}` : ""}`;
}

/**
 * A download let through: `read` is how its list is read (held before each
 * read, counted after it), `send` holds the file's bytes before it is sent,
 * and `settle` gives back what was held and not used, once.
 */
type ListHeld = { ok: true; read: ListRead; send: (bytes: number) => Promise<void>; settle: () => Promise<void> };
type ListHold = ListHeld | { ok: false; status: 429 | 502 | 503; message: string };

/** A read or the file a download could not hold first (429), or whose take could not be counted (503): what was read before it is paid for, and nothing is sent. */
export class ListDownloadRefused extends Error {
  readonly status: 429 | 503;
  constructor(status: 429 | 503, message: string) {
    super(message);
    this.name = "ListDownloadRefused";
    this.status = status;
  }
}

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
  // Its reads are priced at the largest list its room can hold, with its closing, so they are read as they are.
  return { ok: true, read: plainRead, send: async () => {}, settle: async () => {} };
}

/**
 * Takes a download's units from the store's studio figure before its list is
 * read: counted first, then held at listDownloadHeld. Refused (nothing read,
 * nothing taken) when the count does not read (502, as a list that did not
 * read), what it takes could not be counted (503), or the figure has not the
 * units (429, saying how many it needs and how many are left). A store whose
 * plan has ended takes from its own list downloads instead
 * (holdEndedListDownload).
 *
 * Then every read of the list goes through `read`, which holds before the
 * read the units of everything counted so far and of that read at the most it
 * can move (its commands, every byte it sends and `most` for its answer), and
 * counts after it every byte it moved, measured on the answer (jsonBytes).
 * A read the figure has not the units for is never made: ListDownloadRefused
 * (429, what it needs and what is left; 503 when the take could not be
 * counted). A read that fails is counted at its most, since it is never
 * measured. `send` holds the file's bytes the same way before it is sent.
 * `settle` gives back what was held and not used. An answer larger than its
 * most (a page longer than its COUNT) is counted at what it moved and held
 * with the next read or the file; when the figure has not those units, what
 * was read is counted past it, since it has been read, and nothing more is
 * read or sent (second cost review of #3354).
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
  const holds = [{ units, give: held.give, force: held.force }];
  let holding = units;
  let commands = 0;
  let bytes = 0;
  let settled = false;
  /** Holds what was counted so far with `more` commands and `most` bytes on top, before they are spent. */
  const cover = async (more: number, most: number): Promise<void> => {
    const need = listDownloadUnits(commands + more, bytes + most);
    if (need <= holding) return;
    const top = await holdStudio(store, need - holding);
    if (!top.ok) {
      if (top.reason === "unknown") throw new ListDownloadRefused(503, top.message);
      // What the figure had for this download: what is left beside it, and what it holds.
      throw new ListDownloadRefused(429, top.reason === "used" ? shortWords(store, need, { limit: top.limit, left: top.left === undefined ? undefined : top.left + holding, reset: top.reset }, true) : top.message);
    }
    holds.push({ units: need - holding, give: top.give, force: top.force });
    holding = need;
  };
  return {
    ok: true,
    read: async (list, most) => {
      const out = jsonBytes(list) + REPLY_FRAME_BYTES * list.length;
      // A page of this store's list is held at the most a page can answer with, the whole list as counted.
      const page = list.length === 1 && list[0][0] === "HSCAN" && !!store.listId && list[0][1] === leadsKey(store.listId);
      const ceiling = Math.max(0, most, page ? listPageMost(contacts) : 0);
      await cover(list.length, out + ceiling);
      commands += list.length;
      let replies: unknown[];
      try {
        replies = await redisPipeline(list);
      } catch (error) {
        bytes += out + ceiling;
        throw error;
      }
      bytes += out + jsonBytes(replies);
      return replies;
    },
    send: async (sent) => {
      await cover(0, sent);
      bytes += Math.max(0, sent);
    },
    settle: async () => {
      if (settled) return;
      settled = true;
      const used = listDownloadUnits(commands, bytes);
      try {
        if (used > holding) await holds[0].force(used - holding);
        let back = holding - used;
        for (let i = holds.length - 1; i >= 0 && back > 0; i -= 1) {
          const n = Math.min(back, holds[i].units);
          await holds[i].give(n);
          back -= n;
        }
      } catch (error) {
        // What could not be given back stays taken: the safe side.
        console.error("settling a list download failed", error);
      }
    },
  };
}
