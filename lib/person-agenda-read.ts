/**
 * What the tasks agenda on the studio's buyers page reads (639 [GL7](6),
 * unit 3), each part counted in the store's studio requests before it is
 * read: none when no task is kept (one HLEN); AGENDA_UNITS for every task and
 * the rows sent on (tests/plan-cost-registry.ts, AGENDA_READ); and the buyers
 * by what their reading weighs (lib/segments.ts, buyerLedger). Server only.
 */
import { readAllTasks, tasksKept } from "@/lib/crm";
import { AGENDA_UNITS, type AgendaDayGroup, agendaForDays, daysAround, personAddresses } from "@/lib/person-agenda";
import type { DueTask } from "@/lib/person-tasks";
import type { Store } from "@/lib/store";
import { countStudio, studioPath } from "@/lib/studio-route";

/**
 * Counts reading the store's buyers, with the studio requests buyerLedger
 * asks for; `said` keeps the sentence of a refusal (the requests used up),
 * so the page says it instead of "could not be read".
 */
export function countLedger(store: Store): { count: (units: number) => Promise<boolean>; said: { message: string } } {
  const said = { message: "" };
  return {
    said,
    count: async (units) => {
      const counted = await countStudio(store, null, units);
      if (!counted.ok) said.message = counted.message;
      return counted.ok;
    },
  };
}

export type AgendaRowShown = DueTask & { email: string | null; href: string };

export type AgendaData =
  | { state: "empty" }
  | { state: "refused"; message: string }
  | { state: "failed" }
  | { state: "ok"; rows: AgendaRowShown[]; days: Record<string, AgendaDayGroup[]>; open: number; found: { partial: boolean } | null; ledgerMessage: string };

/** The agenda for the buyers page on the server's day `today`, read and counted as above. */
export async function agendaData(store: Store, today: string): Promise<AgendaData> {
  const kept = await tasksKept(store.statsId).catch(() => null);
  if (kept === 0) return { state: "empty" };
  const counted = await countStudio(store, null, AGENDA_UNITS).catch(() => null);
  if (!counted?.ok) return { state: "refused", message: counted && !counted.ok ? counted.message : "" };
  const all = await readAllTasks(store.statsId).catch((error) => {
    console.error("reading the tasks agenda failed", error);
    return null;
  });
  if (!all) return { state: "failed" };
  const agenda = agendaForDays(all, daysAround(today));
  // Only the people of the tasks shown, on any of those days, are looked up.
  const persons = new Set(agenda.rows.map((row) => row.person));
  const ledger = countLedger(store);
  const found = await personAddresses(store, persons, ledger.count).catch((error) => {
    console.error("reading the agenda's buyers failed", error);
    return null;
  });
  const rows = agenda.rows.map((row) => {
    const email = found?.addresses.get(row.person) ?? null;
    return { ...row, email, href: email ? studioPath(store, `who=${row.person}`, "people") : "" };
  });
  return { state: "ok", rows, days: agenda.days, open: all.filter((entry) => !entry.task.done).length, found: found ? { partial: found.partial } : null, ledgerMessage: ledger.said.message };
}
