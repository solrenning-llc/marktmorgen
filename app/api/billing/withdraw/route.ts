import type { NextRequest } from "next/server";
import { away, creatorFrom, studioPath } from "@/lib/studio-route";
import { limited, unknownLimit, withinLimit } from "@/lib/request-guard";
import { readStatement } from "@/lib/withdrawal-rules";
import { withdrawFromPlan } from "@/lib/plan-withdrawal";

/**
 * The refund reading and, under the guarantee, the whole plan refund flow, as
 * app/api/billing/refund does: each Stripe call is bounded by its own
 * timeout, and a request cut short leaves the flow's note for the daily job.
 */
export const maxDuration = 300;

/** Withdrawal statements a store may send in a day: each one reads Stripe a bounded number of times. */
const PER_DAY = 10;
const MAX_BODY_BYTES = 4_000;

/**
 * A creator's online withdrawal statement from their own plan (Directive
 * 2011/83/EU art. 11a; lib/plan-withdrawal.ts, 588 [KB9] unit 3), sent by the
 * "Confirm withdrawal" button of the plan refund page (app/studio/refund).
 *
 * A plain HTML form, so it works with JavaScript turned off. Only the store's
 * owner, through the same check as the refund route (signed in, this site,
 * the "billing" permission, then the owner's role); the store and the
 * subscription come from the session, never from the form. The statement's
 * name and email are checked; the period is read at the moment it is
 * submitted. The answer is always a redirect back to the refund page with
 * what happened, never with the name or the email in the address.
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "billing");
  if (creator instanceof Response) return creator;
  const { store, origin, role } = creator;
  const told = (state: string) => away(origin, `${studioPath(store, `withdraw=${state}`, "refund")}#withdraw`);
  if (role !== "owner") return told("owner");

  let name = "";
  let email = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value.slice(0, 400) : "";
    };
    name = read("name");
    email = read("email");
  } catch {
    return told("form");
  }
  if (!store.subscriptionId) return told("closed");
  const statement = readStatement({ name, email, reference: store.subscriptionId });
  if (!statement) return told("form");
  // A day's count that could not be read is never "too many today" (rule 24): nothing is recorded, and the page
  // says to try again.
  const room = await withinLimit("plan-withdraw", store.sid || store.handle, PER_DAY, 86_400).catch(unknownLimit);
  if (room === "unknown") return told("error");
  if (!room) return told("later");
  try {
    return told(await withdrawFromPlan(store, statement));
  } catch (error) {
    console.error("plan-withdraw: recording a withdrawal failed", error);
    return told("error");
  }
}
