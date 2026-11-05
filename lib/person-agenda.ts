import { personKey } from "@/lib/person-key";
import { type DueTask, MAX_PERSON_TASKS, MAX_STORE_TASKS, MAX_TASK_TEXT, tasksDue } from "@/lib/person-tasks";
import { PAGE_INCLUDED_BYTES } from "@/lib/sent-bytes";
import { buyerLedger } from "@/lib/segments";
import type { Store } from "@/lib/store";

/**
 * The tasks agenda on the studio's buyers page (639 [GL7](6), unit 3). Tasks
 * are kept under a person's key, never their address (lib/crm.ts), so the
 * agenda finds who each one is about among the store's buyers, read from the
 * creator's Stripe account (`buyerLedger`, kept ten minutes), and keeps
 * nothing new. Someone who is not among those buyers (a list subscriber, or a
 * buyer past what one reading reaches) is said to be so, never guessed.
 */

/** Tasks listed in each group; the rest are counted. */
export const AGENDA_SHOWN = 50;
/** The most rows the agenda sends: each of its four groups at AGENDA_SHOWN, for each of the three days it is made for. */
export const AGENDA_MAX_ROWS = 3 * 4 * AGENDA_SHOWN;
/** The most one task weighs as kept, in bytes: its words at three bytes a character, its teammate's address, its id, date and times. */
export const MAX_TASK_RECORD_BYTES = 3 * MAX_TASK_TEXT + 254 + 160;
/** The agenda's own markup around one row (its line, date, teammate and link), in bytes at the most, beside what the row says. */
export const AGENDA_ROW_MARKUP_BYTES = 600;
/** The most every task of a store weighs, all read for the agenda (lib/crm.ts, readAllTasks). */
export const AGENDA_TASKS_BYTES = MAX_STORE_TASKS * MAX_TASK_RECORD_BYTES;
/**
 * The most one row of the agenda sends to the browser, in bytes: its task,
 * the person's address and the link, written in the page and again, escaped,
 * in what React reads to take it over (two and a half times, at the most).
 */
export const AGENDA_ROW_SENT_BYTES = Math.ceil(2.5 * (MAX_TASK_RECORD_BYTES + 2 * 254 + 200));
/**
 * Studio requests the agenda counts before it reads every task, beyond the
 * buyers page's own (round 5, M1): by how many people have tasks
 * (`peopleWithTasks`, one HLEN), each at the most a person's tasks can
 * weigh, none within PAGE_INCLUDED_BYTES, then one a megabyte. What it sends
 * on is counted after, by its measured size (lib/sent-bytes.ts), and the
 * buyers by what their reading weighs (lib/segments.ts).
 */
export function agendaReadUnits(peopleWithTasks: number): number {
  const bytes = Math.min(Math.max(0, peopleWithTasks) * MAX_PERSON_TASKS * MAX_TASK_RECORD_BYTES, AGENDA_TASKS_BYTES);
  return bytes <= PAGE_INCLUDED_BYTES ? 0 : Math.ceil(bytes / 1_000_000);
}

/** The most the agenda's reading and sending count together (every task, every row): held against AGENDA_READ. */
export const AGENDA_UNITS = agendaReadUnits(MAX_STORE_TASKS) + Math.ceil((AGENDA_MAX_ROWS * (AGENDA_ROW_SENT_BYTES + AGENDA_ROW_MARKUP_BYTES)) / 1_000_000);
/** A person's key, as in the address of their page from the agenda. */
export const PERSON_KEY = /^[0-9a-f]{32}$/;

export type AgendaRow = DueTask & { email: string | null };
export type AgendaGroup = { key: "overdue" | "today" | "upcoming" | "undated"; title: string; rows: AgendaRow[]; more: number };

/** Each wanted person's address, from the addresses given, by the same key the tasks are kept under. */
export function addressesOf(statsId: string, persons: ReadonlySet<string>, emails: Iterable<string>): Map<string, string> {
  const found = new Map<string, string>();
  if (!persons.size) return found;
  for (const email of emails) {
    const person = personKey(statsId, email);
    if (persons.has(person) && !found.has(person)) {
      found.set(person, email);
      if (found.size === persons.size) break;
    }
  }
  return found;
}

/**
 * The addresses of these people among the store's buyers, and whether that
 * reading of buyers was cut short. `count` is asked before Stripe is read
 * again (buyerLedger), so a page counts that reading only when it happens.
 */
export async function personAddresses(store: Store, persons: ReadonlySet<string>, count?: (units: number) => Promise<boolean>): Promise<{ addresses: Map<string, string>; partial: boolean }> {
  if (!store.statsId || !persons.size) return { addresses: new Map(), partial: false };
  const ledger = await buyerLedger(store, count);
  return { addresses: addressesOf(store.statsId, persons, ledger.buyers.keys()), partial: ledger.partial };
}

/** The address of one person among the store's buyers, for their page opened from the agenda. */
export async function addressForPerson(store: Store, person: string, count?: (units: number) => Promise<boolean>): Promise<string | null> {
  if (!PERSON_KEY.test(person)) return null;
  const { addresses } = await personAddresses(store, new Set([person]), count);
  return addresses.get(person) ?? null;
}

/** The agenda's groups, in the order to act on them, each cut at AGENDA_SHOWN with the rest counted; empty groups left out. */
export function agendaGroups(due: { overdue: DueTask[]; today: DueTask[]; upcoming: DueTask[]; undated: DueTask[] }, addresses: ReadonlyMap<string, string>): AgendaGroup[] {
  const titles: [AgendaGroup["key"], string][] = [
    ["overdue", "Past their date"],
    ["today", "Due today"],
    ["upcoming", "Coming up"],
    ["undated", "No date"],
  ];
  return titles
    .filter(([key]) => due[key].length > 0)
    .map(([key, title]) => ({
      key,
      title,
      rows: due[key].slice(0, AGENDA_SHOWN).map((entry) => ({ ...entry, email: addresses.get(entry.person) ?? null })),
      more: Math.max(0, due[key].length - AGENDA_SHOWN),
    }));
}

/**
 * The days the creator's own may be when the server's (UTC) is `day`: the
 * one before, itself and the one after, since every time zone is within a
 * day of UTC (UTC-12 to UTC+14).
 */
export function daysAround(day: string): string[] {
  const at = Date.parse(`${day}T00:00:00Z`);
  return [-1, 0, 1].map((n) => new Date(at + n * 86_400_000).toISOString().slice(0, 10));
}

/** One day's group, its rows given by their place in the agenda's list. */
export type AgendaDayGroup = { key: AgendaGroup["key"]; title: string; rows: number[]; more: number };

/**
 * The agenda for each of these days (daysAround), so the browser shows the
 * one for the creator's own day (components/tasks-agenda.tsx) and a task due
 * today in Fortaleza at 22:30 is due today, not past. Each task is listed
 * once; the groups point at it by place.
 */
export function agendaForDays(entries: readonly DueTask[], days: readonly string[]): { rows: DueTask[]; days: Record<string, AgendaDayGroup[]> } {
  const rows: DueTask[] = [];
  const places = new Map<string, number>();
  const placeOf = (entry: DueTask) => {
    const key = `${entry.person}:${entry.task.id}`;
    let place = places.get(key);
    if (place === undefined) {
      place = rows.push({ person: entry.person, task: entry.task }) - 1;
      places.set(key, place);
    }
    return place;
  };
  const byDay: Record<string, AgendaDayGroup[]> = {};
  for (const day of days) {
    byDay[day] = agendaGroups(tasksDue(entries, day), new Map()).map((group) => ({ key: group.key, title: group.title, rows: group.rows.map(placeOf), more: group.more }));
  }
  return { rows, days: byDay };
}
