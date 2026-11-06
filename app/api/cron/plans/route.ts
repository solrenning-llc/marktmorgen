import type { NextRequest } from "next/server";
import { cronAllowed } from "@/lib/request-guard";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { settlePlans } from "@/lib/plans";
import { isBillingConfigured } from "@/lib/billing";
import { syncSubscriptions } from "@/lib/billing-sync";
import { syncPlanDisputes } from "@/lib/plan-disputes";
import { moveAllStores } from "@/lib/store";
import { pruneResearch } from "@/lib/creator-research-store";
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { sendMemberNudges } from "@/lib/member-nudge";
import { sendYearlyAsks } from "@/lib/yearly-ask";
import { sendVerified } from "@/lib/verified-numbers";
import { refreshRanges } from "@/lib/benchmarks";
import { settleInvites } from "@/lib/creator-invite-credit";
import { sendWinBacks } from "@/lib/winback-send";
import { ensureDemoStore } from "@/lib/demo-seed";

export const maxDuration = 60;

/**
 * Run on a schedule by Vercel, once a day, for the jobs that keep money
 * where it was agreed to be:
 *
 *   - gives every paid payment plan its end, so no buyer is ever charged
 *     more payments than they agreed to;
 *   - brings every store's "paid up" snapshot in line with its subscription
 *     at Stripe (lib/billing-sync.ts), so a store that stopped paying us
 *     stops selling, and one that paid while its way back got lost is
 *     written down;
 *   - writes down a payment for a plan that its creator disputed with their
 *     bank (lib/plan-disputes.ts), which pauses what costs us to run;
 *   - tells each member whose renewal failed, once, with a link that pays it
 *     (lib/payment-recovery.ts), so a member whose card expired is not
 *     quietly cut off without ever being asked for a new one;
 *   - sends a former member who agreed to hear from the creator one
 *     come-back offer, days after their membership ended (lib/winback-send.ts);
 *   - adds the credit creators earned by inviting other creators
 *     (lib/creator-invite-credit.ts), once each payment's refund window has
 *     closed.
 *
 * And, with the time left, one piece of upkeep: every store written before
 * products had records of their own is moved to them (lib/catalog.ts). A
 * store is also moved the first time it is written, so this reaches the
 * ones nobody touches; a store already moved is passed over, and a walk the
 * clock cuts short carries on the next day.
 *
 * Last, the demo store is checked against the code that makes it
 * (lib/demo-seed.ts): one read on a day when nothing is missing, so it is put
 * right even on a day nobody opens it.
 *
 * Safe to run more than once: each job only writes what is still wrong, and
 * one run at a time.
 */
export async function GET(request: NextRequest) {
  // Every request to Redis, Stripe and the rest is given up by 57 s
  // (lib/fetch-timeout.ts), inside the sixty Vercel gives the job.
  return withCutoff(Date.now() + 57_000, () => run(request));
}

async function run(request: NextRequest): Promise<Response> {
  // Vercel sends the secret with every scheduled run, compared here in
  // constant time. Without one set, only a local development server runs the
  // job on request; in production that is a closed door, not an open one.
  if (!(await cronAllowed(request))) {
    return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  if (!isRedisConfigured()) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  const [got] = await redisPipeline([["SET", "nl:plans:lock", "1", "NX", "EX", 120]]);
  if (got === null) return Response.json({ ok: true, busy: true });
  // Leaves time to answer inside maxDuration, whatever the jobs find.
  const deadline = Date.now() + 45_000;
  try {
    let plans = null;
    try {
      plans = await settlePlans();
    } catch (error) {
      console.error("settling payment plans failed", error);
    }
    // A creator who disputed a payment for their plan has what costs us to
    // run paused, as for an unpaid renewal (232 [CA1] unit 5). At most eight
    // seconds of its own, before the subscriptions take the rest.
    let disputes = null;
    if (isBillingConfigured()) {
      try {
        disputes = await syncPlanDisputes(Math.min(deadline, Date.now() + 8_000));
      } catch (error) {
        console.error("reading plan disputes failed", error);
      }
    }
    let billing = null;
    if (isBillingConfigured()) {
      try {
        billing = await syncSubscriptions(deadline);
      } catch (error) {
        console.error("settling store subscriptions failed", error);
      }
    }
    // Members whose renewal failed are told, once, with a link that pays it
    // and makes the working card the one used next time (lib/payment-recovery.ts).
    // Before the upkeep below, because it is money agreed to, and upkeep can
    // wait a day while a member's access cannot.
    let recovered = null;
    try {
      recovered = await recoverFailedPayments(deadline);
    } catch (error) {
      console.error("writing about failed renewals failed", error);
    }
    // Former members who agreed to hear from the creator: one come-back
    // offer, the chosen number of days after their membership ended.
    let comeBack = null;
    try {
      comeBack = await sendWinBacks(deadline);
    } catch (error) {
      console.error("sending come-back offers failed", error);
    }
    // Running members who stopped coming, where the creator turned it on:
    // one email back in, once per period (lib/member-nudge.ts).
    let nudged = null;
    try {
      nudged = await sendMemberNudges(deadline);
    } catch (error) {
      console.error("sending emails to members who stopped coming failed", error);
    }
    // Monthly members whose membership has a yearly price, where the creator
    // turned it on: one email offering it, once per membership (lib/yearly-ask.ts).
    let yearly = null;
    try {
      yearly = await sendYearlyAsks(deadline);
    } catch (error) {
      console.error("sending the yearly offer failed", error);
    }
    // The numbers stores show others, counted once a day (lib/verified-numbers.ts).
    let verified = null;
    try {
      verified = await sendVerified(deadline);
    } catch (error) {
      console.error("reading the shared numbers failed", error);
    }
    // The ranges stores are set beside, from the last two weeks' samples (lib/benchmarks.ts): one read and one write.
    const benchmarks = await refreshRanges().then((r) => (r ? r.stores : null)).catch((error: unknown) => {
      console.error("working out the ranges of stores failed", error);
      return null;
    });
    // Invited creators' payments, past their refund window, become credit on
    // the plan of whoever invited them (lib/creator-invite-credit.ts).
    let invites = null;
    try {
      invites = await settleInvites(deadline);
    } catch (error) {
      console.error("adding invite credit failed", error);
    }
    let catalogs = null;
    try {
      catalogs = await moveAllStores(deadline);
    } catch (error) {
      console.error("moving stores to product records failed", error);
    }
    // Creator research answers are kept 24 months, as the privacy policy says.
    await pruneResearch().catch((error: unknown) => console.error("pruning old research answers failed", error));
    // The demo store, as the code says it should be. What is still missing
    // is named in the answer and in the log, and never fails the run: the
    // jobs above are about money, and this one is not.
    const demo = await ensureDemoStore().catch((error: unknown) => {
      console.error("checking the demo store failed", error);
      return null;
    });
    if (demo && demo.pending.length) console.error("the demo store is missing something", demo.pending);
    const ok = plans !== null && ((billing !== null && disputes !== null) || !isBillingConfigured());
    return Response.json({ ok, ...(plans ?? {}), billing, disputes, recovered, comeBack, nudged, yearly, verified, benchmarks, invites, catalogs, demo }, { status: ok ? 200 : 500, headers: { "Cache-Control": "no-store" } });
  } finally {
    await redisPipeline([["DEL", "nl:plans:lock"]]).catch(() => {});
  }
}
