/** Plan standing and finite storage/playback admission thresholds.
 * These provisional allowance sizes are not a verified supplier-cost ceiling
 * or proof of the owner's after-all-tax margin. Paid and trial stream playback
 * both require the explicit monthly threshold; setup and ended stores have a
 * smaller threshold. Storage and retention follow their separate guards.
 */
import type { Tier } from "@/lib/plan";
import { paidVideoSeconds, TRIAL_VIDEO_SECONDS } from "@/lib/video-admission-rules";
import { type PlanDispute, planDisputed } from "@/lib/plan-dispute-rules";

const GB = 1024 * 1024 * 1024;

export type Standing = "paid" | "trial" | "none" | "ended";

/** What a store's record says about its plan (lib/store.ts). `trialEnds` in seconds; `planEndedAt` a date, or empty. */
export type PlanFields = {
  subscriptionActive: boolean;
  subscriptionId: string | null;
  trialEnds: number;
  planEndedAt: string;
  /**
   * When a renewal of a running plan was first seen unpaid, in seconds; 0 or
   * absent when the plan is paid up (lib/store.ts, queue item 232 [CA1]).
   */
  renewalUnpaidSince?: number;
  /** Disputes of payments made to us for the plan (lib/plan-dispute-rules.ts, 232 [CA1] unit 5). */
  planDisputes?: PlanDispute[];
};

/** Where a store stands with its plan right now. */
export function standingOf(store: PlanFields, nowSeconds = Date.now() / 1000): Standing {
  if (store.subscriptionActive) return store.trialEnds > nowSeconds ? "trial" : "paid";
  // A plan that was started and is not running has ended, whether or not
  // the day it ended was written down.
  return store.planEndedAt || store.subscriptionId ? "ended" : "none";
}

/**
 * Whether a running plan's renewal payment did not go through (Stripe's
 * `past_due`, lib/billing.ts stateOf). The plan has not ended: Stripe keeps
 * trying the card, the store's page stays up and nothing starts closing.
 */
export function renewalUnpaid(store: Pick<PlanFields, "subscriptionActive" | "renewalUnpaidSince">): boolean {
  return store.subscriptionActive && Number.isFinite(store.renewalUnpaidSince) && (store.renewalUnpaidSince as number) > 0;
}

/**
 * Where a store stands for what costs us money to run (232 [CA1] unit 4):
 * as `standingOf`, except that a paid plan whose renewal is unpaid gets what
 * a store whose plan ended gets (no AI drafts, no new uploads, the video of
 * a store with no plan), from the first day it is seen, without being an
 * ended plan anywhere else: no closing, no notices, nothing deleted.
 */
export function costStandingOf(store: PlanFields, nowSeconds = Date.now() / 1000): Standing {
  const standing = standingOf(store, nowSeconds);
  if (standing === "ended" || standing === "none") return standing;
  // A plan payment the creator disputed pauses a trial's costs too (unit 5).
  if (standing === "trial") return planDisputed(store, nowSeconds) ? "ended" : standing;
  return costsPaused(store, nowSeconds) ? "ended" : standing;
}

/**
 * Whether what costs us to run is paused on a running plan: its renewal is
 * unpaid (unit 4), or a payment for it is disputed (unit 5,
 * lib/plan-dispute-rules.ts). The plan itself goes on; nothing closes.
 */
export function costsPaused(store: Pick<PlanFields, "subscriptionActive" | "renewalUnpaidSince" | "planDisputes">, nowSeconds = Date.now() / 1000): boolean {
  return renewalUnpaid(store) || (store.subscriptionActive && planDisputed(store, nowSeconds));
}

/** The reason a route gives when it refuses for `costsPaused`, or null. */
export function costPauseCode(store: Pick<PlanFields, "subscriptionActive" | "renewalUnpaidSince" | "planDisputes">, nowSeconds = Date.now() / 1000): "renewal_unpaid" | "plan_disputed" | null {
  if (renewalUnpaid(store)) return "renewal_unpaid";
  return store.subscriptionActive && planDisputed(store, nowSeconds) ? "plan_disputed" : null;
}

/** Historical trial storage threshold; all-cost review remains required. */
export const TRIAL_STORAGE_BYTES = 50 * GB;
/** Historical setup/ended storage threshold; not a certified cost budget. */
export const SETUP_STORAGE_BYTES = 5 * GB;
/** The hours of lesson video a store with no plan may have watched in a month: its owner looking at their own lessons, and a preview. */
export const SETUP_VIDEO_HOURS = 0.25;
export const SETUP_VIDEO_SECONDS = SETUP_VIDEO_HOURS * 3600;

/**
 * The seconds of lesson video a store may have watched this month before
 * its video is paused. Paid plans also have a finite monthly threshold.
 */
export function videoLimitFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  const standing = costStandingOf(store, nowSeconds);
  if (standing === "paid") return paidVideoSeconds(store.tier);
  return standing === "trial" ? Math.min(paidVideoSeconds(store.tier), TRIAL_VIDEO_SECONDS) : SETUP_VIDEO_SECONDS;
}

/**
 * Where the stores whose plan has ended are kept in line, by the day it
 * ended: the store's key, scored with that day in milliseconds. Written by
 * the one place a store's plan is written down (lib/store.ts,
 * setSubscription) and read by the daily job (lib/plan-closing.ts).
 */
export const ENDED_INDEX = "nl:plan:ended";

/** The word an upload is refused with when it would not fit, by standing (lib/studio-messages.ts has the sentences). */
export function storageRefusal(standing: Standing): "storage_full" | "storage_trial" | "storage_setup" {
  return standing === "paid" ? "storage_full" : standing === "trial" ? "storage_trial" : "storage_setup";
}
