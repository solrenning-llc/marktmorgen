/**
 * Visits past what a plan covers: since 17 October 2026, nothing is billed
 * for them (lib/traffic-rules.ts says why, and where a month's visits stop
 * instead). What is left here is the one record the daily job still needs:
 * that the creator was written to, once, about a month whose pages rest
 * (app/api/cron/usage).
 *
 *   nl:visits:told:<folder>:<month>     the creator was written to about that month
 *
 * The meter owes nothing whatever it measures, so no path can put a visit on
 * an invoice; lib/usage-billing.ts is kept for lesson video's legacy line
 * (lib/watch-billing.ts), which paid playback admission never reaches.
 */
import { type Meter, firstWordOf, giveFirstWordBack, takeFirstWordOf } from "@/lib/usage-billing";
import { visitedFolders, visitsIn } from "@/lib/traffic";
import { SETUP_VISITS, VISITS_INCLUDED } from "@/lib/traffic-rules";

const VISITS: Meter = {
  name: "visits",
  measured: visitsIn,
  owed: () => 0,
  byPlan: true,
  covered: Math.min(SETUP_VISITS, ...Object.values(VISITS_INCLUDED)),
  describe: () => "",
  folders: visitedFolders,
};

/** Whether the creator still has to be written to about this month's visits: true the first time it is asked, and never again. */
export function firstWordOnVisits(folder: string, month: string): Promise<boolean> {
  return firstWordOf(VISITS, folder, month);
}

/** firstWordOnVisits, keeping the mark's value: given back with giveVisitsWordBack when the notice was certainly not sent. */
export function takeVisitsWord(folder: string, month: string): Promise<string | null> {
  return takeFirstWordOf(VISITS, folder, month);
}

/** Gives the month's mark back after a certain refusal, while it still holds this run's value (lib/usage-billing.ts). */
export function giveVisitsWordBack(folder: string, month: string, value: string): Promise<void> {
  return giveFirstWordBack(VISITS, folder, month, value);
}
