/**
 * "Signed a proposal or an agreement" as a workflow trigger (635 [GL3];
 * added 2 November 2026): what starts the workflows that start on it
 * (lib/flows.ts, trigger "signed") when someone signs one of the store's
 * proposals or agreements (app/api/store/agreement-sign).
 *
 * Only the person who signed, by the address it was sent to and signed
 * with, and only while they are on the store's list and agreed to hear from
 * the creator (lib/flows.ts, enroll): signing never puts anybody on the list
 * nor counts as agreeing to hear from the creator. One workflow a store
 * starts on signing (saveFlow refuses a second); each person starts it once
 * (enroll's claim), so signing again starts nothing new.
 *
 * What it costs: on a plan with workflows and agreements, checking takes one
 * more of the store's public requests (takePublicRequest, as a buyer's, like the request that signed), taken before it
 * is made; a run it starts counts in the
 * day's runs like every other (lib/flow-limits.ts). On a plan without them
 * nothing is read.
 */
import { agreementsAllowed } from "@/lib/agreement-rules";
import { activeFlowLimit } from "@/lib/flow-limits";
import { enroll } from "@/lib/flows";
import type { Store } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";

/** Public requests a signature takes for checking the workflow it may start (one a store: lib/flows.ts, signed_taken). */
export const SIGNED_TRIGGER_UNITS = 1;

export type SignedTrigger = "none" | "checked" | "not_checked";

/** After a signature was recorded: starts the workflows that start on signing, for the signer. Never throws. */
export async function agreementSigned(store: Store, email: string): Promise<SignedTrigger> {
  if (!email || activeFlowLimit(store) === 0 || !agreementsAllowed(store)) return "none";
  try {
    if (!(await takePublicRequest(store, "buyer", Date.now(), SIGNED_TRIGGER_UNITS))) {
      // The store's requests are used for now: the signature stands, and the workflow does not start for it.
      console.warn("a signed agreement's workflow was not checked: no public request left");
      return "not_checked";
    }
    await enroll(store, email, { joined: false, signed: true });
    return "checked";
  } catch (error) {
    console.error("checking a signed agreement's workflow failed", error);
    return "not_checked";
  }
}
