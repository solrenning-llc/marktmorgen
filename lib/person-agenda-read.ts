/**
 * What the tasks agenda on the studio's buyers page reads (639 [GL7](6),
 * unit 3), each part counted in the store's studio requests before it is
 * read or sent: none when no task is kept (one HLEN); its tasks by how many
 * people have them (agendaReadUnits); its rows by their measured size before
 * they are sent (lib/sent-bytes.ts); and the buyers by what their reading
 * weighs (lib/segments.ts, buyerLedger). At the most AGENDA_UNITS besides the
 * buyers (tests/plan-cost-registry.ts, AGENDA_READ). Server only.
 */
import { readAllTasks } from "@/lib/crm";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { AGENDA_ROW_MARKUP_BYTES, type AgendaDayGroup, agendaForDays, agendaReadUnits, daysAround, personAddresses } from "@/lib/person-agenda";
import { sentBytes, sentUnits } from "@/lib/sent-bytes";
import type { DueTask } from "@/lib/person-tasks";
import type { Store } from "@/lib/store";
import { countStudio, studioPath } from "@/lib/studio-route";

/**
 * How many people have tasks kept (one HLEN), so a page with none reads and
 * counts nothing more. The hash is lib/crm.ts's tasks hash, by the same key
 * (tests/person-agenda.test.ts holds the two together).
 */
export async function tasksKept(statsId: string | null): Promise<number> {
  if (!statsId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["HLEN", `nl:crm:tasks:${statsId}`]]);
  return Number(n) || 0;
}

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
      const counted = await countUnits(store, units);
      if (!counted.ok) said.message = counted.message;
      return counted.ok;
    },
  };
}

/** Said when studio requests could not be counted and the refusal came with no sentence of its own: nothing was read. */
export const NOT_COUNTED = "Your studio's requests could not be counted just now, so nothing was read or changed. Try again in a minute.";

/**
 * Counts `units` studio requests, or says why not: when more are asked than
 * are left, that this needs more than is left, never that they are all spent
 * (round 5, L4).
 */
export async function countUnits(store: Store, units: number): Promise<{ ok: true } | { ok: false; reason: "used" | "unknown" | "pool" | "daily"; message: string }> {
  if (units <= 0) return { ok: true };
  const counted = await countStudio(store, null, units);
  if (counted.ok) return { ok: true };
  // One sentence with how many this needs and how many were left, from the figure's own count, and when they come
  // back (round 7, M2). Without that count (or with no figure at all, as in a trial), the figure's own words.
  if (counted.reason === "used" && units > 1 && counted.left !== undefined) {
    const left = counted.left === 0 ? "none are left" : counted.left === 1 ? "only 1 is left" : `only ${counted.left.toLocaleString("en-US")} are left`;
    return { ok: false, reason: "used", message: `This needs ${units.toLocaleString("en-US")} of your studio requests, and ${left}.${counted.reset ? ` ${counted.reset}` : ""}` };
  }
  return { ok: false, reason: counted.reason, message: counted.message };
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
  if (kept === null) return { state: "failed" };
  const counted = await countUnits(store, agendaReadUnits(kept)).catch(() => null);
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
  // What is sent on, measured before it is drawn (round 5, M1).
  // Each row's own markup too (its line, date, teammate and link around the words; round 6, L3).
  const sending = await countUnits(store, sentUnits(sentBytes(JSON.stringify({ rows, days: agenda.days })) + rows.length * AGENDA_ROW_MARKUP_BYTES)).catch(() => null);
  if (!sending?.ok) return { state: "refused", message: sending && !sending.ok ? sending.message : "" };
  return { state: "ok", rows, days: agenda.days, open: all.filter((entry) => !entry.task.done).length, found: found ? { partial: found.partial } : null, ledgerMessage: ledger.said.message };
}
