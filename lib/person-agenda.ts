import { personKey } from "@/lib/person-key";
import { type DueTask, tasksDue } from "@/lib/person-tasks";
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

/** The addresses of these people among the store's buyers, and whether that reading of buyers was cut short. */
export async function personAddresses(store: Store, persons: ReadonlySet<string>): Promise<{ addresses: Map<string, string>; partial: boolean }> {
  if (!store.statsId || !persons.size) return { addresses: new Map(), partial: false };
  const ledger = await buyerLedger(store);
  return { addresses: addressesOf(store.statsId, persons, ledger.buyers.keys()), partial: ledger.partial };
}

/** The address of one person among the store's buyers, for their page opened from the agenda. */
export async function addressForPerson(store: Store, person: string): Promise<string | null> {
  if (!PERSON_KEY.test(person)) return null;
  const { addresses } = await personAddresses(store, new Set([person]));
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
