/**
 * Doing the deletions a month's rights budget could not pay for
 * (lib/rights-budget.ts, scheduleRights), every hour (app/api/cron/rights),
 * each within the month the law gives (lib/rights-budget-rules.ts):
 *
 *   1. from the next UTC month, from that month's budget, as when it was asked
 *      (the plan's for a paying store, the company's for any other), or the
 *      company's when it is larger than the store's whole month;
 *   2. from RIGHTS_DEADLINE_MARGIN_MS before its deadline, from the company's
 *      budget when that one has no room;
 *   3. and when the company's is used up too, still done before the deadline,
 *      counted past the company's cap and said in the log (a legal duty,
 *      owner's decision 9), at most RIGHTS_FORCED_TRIES times a deletion.
 *
 * Done is only what the erasure answers ok: anything else stays waiting and
 * is looked at again within the hour; a store that cannot be read is unknown,
 * never done. When the person asked for it themselves, the store's owner is
 * told, as for any deletion they ask for (lib/erasure-request.ts).
 */
import { storeForId } from "@/lib/store";
import { type ErasureCharge, type ErasureResult, eraseCharged } from "@/lib/person-erasure";
import { tellOwnerErased } from "@/lib/erasure-request";
import { type RightsItem, dropRightsPlace, dueRights, finishRights, postponeRights, readRightsItem, rightsCap, takeCompanyPastCap, takeCompanyRights, takeRights } from "@/lib/rights-budget";
import { RIGHTS_DEADLINE_MARGIN_MS, RIGHTS_FORCED_TRIES, RIGHTS_RUN_ITEMS, nextRightsMonth } from "@/lib/rights-budget-rules";
import type { Role } from "@/lib/team-roles";

const HOUR = 3_600_000;
export type RightsRun = { done: number; waiting: number; unknown: number };

/** Runs what is due by `now`, until `until` (ms) at the latest. */
export async function runRightsQueue(now = Date.now(), until = Number.POSITIVE_INFINITY): Promise<RightsRun> {
  const out: RightsRun = { done: 0, waiting: 0, unknown: 0 };
  const ids = await dueRights(now, RIGHTS_RUN_ITEMS);
  if (!ids) {
    out.unknown += 1;
    return out;
  }
  for (const id of ids) {
    if (Date.now() > until) break;
    const item = await readRightsItem(id);
    if (item === "gone") {
      await dropRightsPlace(id).catch(() => {});
      continue;
    }
    if (!item) {
      // Unknown: left where it is, looked at again within the hour.
      out.unknown += 1;
      continue;
    }
    const result = await runOne(item, now).catch(() => null);
    if (result === "done") {
      await finishRights(id);
      out.done += 1;
      continue;
    }
    out.waiting += 1;
    // Waiting for room: when the next month opens, or the company's margin before the deadline, whichever is
    // first and still ahead; anything else (unknown, incomplete) in an hour.
    const near = item.d - RIGHTS_DEADLINE_MARGIN_MS;
    const at = result === "full" ? Math.max(now + HOUR, Math.min(nextRightsMonth(now), near > now ? near : now + HOUR)) : now + HOUR;
    const forced = result === "forced-failed" ? item.f + 1 : item.f;
    await postponeRights(id, { ...item, f: forced }, at, now).catch(() => {});
  }
  return out;
}

/** One waiting deletion: "done", "full" (no budget yet), "forced-failed" (paid past the cap and still not done) or "failed". */
async function runOne(item: RightsItem, now: number): Promise<"done" | "full" | "forced-failed" | "failed"> {
  const store = await storeForId(item.s).catch(() => null);
  // A store that cannot be read is unknown: it waits, never done.
  if (!store) return "failed";
  const near = now >= item.d - RIGHTS_DEADLINE_MARGIN_MS;
  let pastCap = false;
  let fromStore = 0;
  const charge: ErasureCharge = async (units) => {
    const taken = await takeRights(store, item.e, units, now, false);
    if (taken.ok) {
      fromStore += units;
      return "ok";
    }
    // Near the deadline, or larger than the store's whole month (it could never be paid from it): the company's.
    if (taken.reason === "unknown" || (!near && fromStore + units <= rightsCap(store, now))) return taken.reason;
    const company = await takeCompanyRights(units, now);
    if (company.ok) return "ok";
    if (company.reason === "unknown" || !near || item.f >= RIGHTS_FORCED_TRIES) return company.reason;
    // Every budget is used up and the deadline is near: the law comes first. Counted, and said.
    if (!(await takeCompanyPastCap(units, now))) return "unknown";
    pastCap = true;
    console.error(`a person's deletion was paid past the company's rights cap (${units} units), ${Math.round((item.d - now) / HOUR)} hours before its deadline`);
    return "ok";
  };
  const by = item.b.kind === "team" ? { kind: "team" as const, who: item.b.who, role: item.b.role as Role } : { kind: "person" as const };
  const result: ErasureResult | "full" = await eraseCharged(store, item.e, by, charge);
  if (result === "full") return "full";
  if (result.ok) {
    if (item.b.kind === "person") await tellOwnerErased(store, item.e).catch((error: unknown) => console.error("telling a store's owner about a scheduled deletion failed", error));
    return "done";
  }
  return pastCap ? "forced-failed" : "failed";
}
