import type { NextRequest } from "next/server";
import { away, creatorFrom, studioPath } from "@/lib/studio-route";
import { limited, withinLimit } from "@/lib/request-guard";
import { refundAndEndPlan, takeReview } from "@/lib/plan-refund-flow";
import { refundUnderway } from "@/lib/plan-refund-underway";

/**
 * Up to the subscription's reading and stop, the refund's reading and write
 * under its lock and the plan's ending, each Stripe call bounded by its own
 * timeout. Since every plan payment inside the guarantee's days is refunded
 * (305 [SY1] 2c), a slow Stripe at its worst can take longer than this
 * route's 300 seconds (the write alone may run WRITE_BY_MS, lib/plan-refund-write.ts):
 * a request cut short keeps its note with every charge it was refunding
 * (lib/plan-refund-flow.ts, mergeParts), so the daily job and a later request
 * judge by all of them, and the plan is never ended on part of a refund.
 */
export const maxDuration = 300;

/** Refund requests a store may send in a day: each one reads Stripe a bounded number of times. */
const PER_DAY = 10;

/**
 * The plan refund, confirmed on its review page (app/studio/refund): 305
 * [SY1]. Only the store's owner, only with the one-time pass that page
 * issued when it showed the amount (so no refund is made without the review
 * screen), and the store and subscription come from the session, never from
 * the form. The whole of it is lib/plan-refund-flow.ts: the plan set to stop,
 * the refund made once, the plan ended, the creator emailed.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "billing");
  if (creator instanceof Response) return creator;
  const { store, origin, role } = creator;
  // Every answer is told on the review page, which says what happened and what to do next.
  const told = (done: string) => away(origin, studioPath(store, `done=${done}`, "refund"));
  if (role !== "owner") return told("owner");

  let token = "";
  try {
    const value = (await (await limited(request, 4_000)).formData()).get("review");
    token = typeof value === "string" ? value : "";
  } catch {
    token = "";
  }
  if (!(await withinLimit("plan-refund", store.sid || store.handle, PER_DAY, 86_400))) return told("later");
  // The pass is taken before anything else: a second click or an old tab has none.
  // A refund still being settled (a second press, a request that has not finished) is never told "nothing".
  const underway = () => refundUnderway(store.sid).catch(() => true);
  const shown = await takeReview(store.sid, token);
  if (shown === null) return told((await underway()) ? "busy" : "review");

  let done;
  try {
    done = await refundAndEndPlan(store, undefined, shown);
  } catch (error) {
    // The note is written before any money moves, so with none nothing was done; with one, the daily job decides.
    console.error("plan-refund: the refund request failed part way", error);
    return told((await underway()) ? "unsure" : "error");
  }
  if (done.ok) return told(done.ended ? "refunded" : "ending");
  if (done.reason === "busy") return told("busy");
  // Some of the payments were refunded and some not: never told "we do not know whether it went through".
  if (done.reason === "partial") return told("partial");
  // A note left behind means a refund may have been made: the daily job decides it and emails the creator.
  if (done.stopLeft) return told("error-stop");
  if (await underway()) return told("unsure");
  if (done.reason === "changed") return told("changed");
  if (done.reason === "failed" || done.reason === "stop_failed" || done.reason === "no_lock") return told("error");
  // Not owed or not decidable now: the review page says why, with the way to support.
  return told("none");
}
