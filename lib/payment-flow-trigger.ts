/**
 * "Paid a payment request" as a workflow trigger (635 [GL3]; added
 * 2 November 2026): what starts the workflow that starts on it (lib/flows.ts,
 * trigger "paid_request") when one of the store's payment requests is first
 * written down as paid (lib/payment-request-store.ts, markPaid), however the
 * payment was learned: the page after paying, a checkout found already paid,
 * or the five-minute job that reads the creator's checkouts.
 *
 * Only the person the request was sent to, by that address, and only while
 * they are on the store's list and agreed to hear from the creator
 * (lib/flows.ts, enroll): paying never puts anybody on the list nor counts as
 * agreeing to hear from the creator. Only a request's first time written as
 * paid checks it; one workflow a store starts on it (saveFlow refuses a
 * second), and each person starts it once, so a second request paid by the
 * same person starts nothing.
 *
 * What it costs: on a plan with workflows, checking takes the store's public
 * requests first (PAID_TRIGGER_UNITS, as a buyer's), even when no workflow
 * starts on it: a bound on the cost, at one request per payment; a run it starts counts
 * in the day's runs like every other (lib/flow-limits.ts). On a plan without
 * workflows nothing is read. It never throws, so writing the payment down
 * and sending its receipt never wait on it failing.
 */
import { activeFlowLimit } from "@/lib/flow-limits";
import { enroll } from "@/lib/flows";
import type { Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";

/** Public requests a paid request takes for checking the workflow it may start. */
export const PAID_TRIGGER_UNITS = 1;

export type PaidTrigger = "none" | "checked" | "not_checked";

/** After a payment request was first written down as paid: starts the workflow that starts on it, for the person it was sent to. Never throws. */
export async function paymentRequestPaid(store: Store, email: string): Promise<PaidTrigger> {
  if (!email || !store.listId || activeFlowLimit(store) === 0) return "none";
  try {
    if (!(await takePublicRequest(store, "buyer", Date.now(), PAID_TRIGGER_UNITS))) {
      // The store's requests are used for now: the payment stands, and the workflow does not start for it.
      console.warn("a paid payment request's workflow was not checked: no public request left");
      return "not_checked";
    }
    await enroll(store, email, { joined: false, paidRequest: true });
    return "checked";
  } catch (error) {
    console.error("checking a paid payment request's workflow failed", error);
    return "not_checked";
  }
}
