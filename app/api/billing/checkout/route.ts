import {reserveContractFunding} from '@/lib/contract-funding';
import type { NextRequest } from "next/server";
import { away, creatorFrom } from "@/lib/studio-route";
import { createBillingCheckout, endLapsed, findStoreSubscriptions, isBillingConfigured } from "@/lib/billing";
import { PRO_ON_SALE, parseCycle, parseTier } from "@/lib/plan";
import { PLANS_ON_SALE } from "@/lib/opening";
import { accountStores, setSubscription } from "@/lib/store";
import { limited } from "@/lib/request-guard";
import { inClosingDay } from "@/lib/closing-holds";
import { CLOSING_CHECKOUT_SECONDS, lastPlanMoment } from "@/lib/closing-plan-guard";
import { closingOf } from "@/lib/plan-closing";
import { closesStore } from "@/lib/plan-closing-rules";

/**
 * Sends the creator to Stripe to start paying us, monthly or yearly.
 *
 * A permanent funding reservation is recorded before opening a new checkout.
 * The subscription only becomes real when
 * Stripe says it exists, on the way back, so a creator who opens the page and
 * closes it is left exactly as they were.
 *
 * Except one thing: a subscription Stripe already has for this store, in good
 * standing, that the store never heard about because the way back did not
 * arrive. That one is written down, and no second checkout is opened over it,
 * because two subscriptions for one store is two charges for one store.
 *
 * Each store of an account is its own subscription at its own plan; only
 * the owner reaches this (lib/team-roles.ts, "billing").
 */
export async function POST(request: NextRequest) {
  const creator = await creatorFrom(request, "billing");
  if (creator instanceof Response) return creator;
  const { ref, store, origin, studio } = creator;

  if (!isBillingConfigured()) return away(origin, studio("billing=unavailable"));
  if (store.subscriptionActive) return away(origin, studio("billing=already"));
  // Not open yet (lib/opening.ts): no card is taken, and Stripe is not asked.
  if (!PLANS_ON_SALE) return away(origin, studio("billing=not-open"));
  // Its closing day has begun (queue item 307 [EC1]): its members' memberships
  // have ended and it is being removed, so a plan would be paid for and not
  // given. Refused, and refused too when that cannot be read: no card is taken.
  // Only a store whose plan ended can be in its closing day.
  const closingToday = store.planEndedAt ? await inClosingDay(ref).catch(() => true) : false;
  if (closingToday) return away(origin, studio("billing=closing"));
  // In its closing period, starting a plan again keeps the store (the owner's
  // decision of 30/10/2026, 18h16), so it is offered until the last moment a
  // checkout opened now would expire before the closing day begins; the
  // checkout lasts the shortest time Stripe allows. Refused, too, when the
  // day cannot be read.
  let expiresAtSeconds: number | undefined;
  if (store.planEndedAt) {
    const closing = await closingOf(store).catch(() => "unknown" as const);
    if (closing === "unknown") return away(origin, studio("billing=error"));
    if (closing && closesStore(closing.endedAt)) {
      if (Date.now() >= lastPlanMoment(closing.day)) return away(origin, studio("billing=closing-late"));
      expiresAtSeconds = Math.floor(Date.now() / 1000) + CLOSING_CHECKOUT_SECONDS;
    }
  }

  let fields: FormData | null = null;
  try {
    fields = await (await limited(request, 8_000)).formData();
  } catch {
    fields = null;
  }
  // A form from before there was a choice sends neither: that is monthly.
  const cycle = parseCycle(fields?.get("cycle") ?? "month");
  const tier = parseTier(fields?.get("tier") ?? "creator");
  if (!cycle || !tier) return away(origin, studio("billing=error"));
  if (tier !== "creator" && !PRO_ON_SALE) return away(origin, studio("billing=pro-closed"));

  // An unreadable search cannot establish that no subscription exists.
  // Wait before reserving cash or creating another payment obligation.
  let customerId = store.stripeCustomerId;
  let lapsed: string[] = [];
  try {
    const found = await findStoreSubscriptions(store);
    if (found.live) {
      await setSubscription(ref, found.live);
      return away(origin, studio("billing=already"));
    }
    customerId = customerId ?? found.customerId;
    lapsed = found.lapsed;
  } catch (error) {
    console.error("looking for this store's subscriptions failed", error);
    return away(origin, studio("billing=error"));
  }
  // One whose card failed, or whose first payment never finished, is ended
  // first: otherwise a retry that goes through later would charge beside the
  // new one. If it cannot be ended now, no new one is started.
  if (lapsed.length) {
    try {
      await endLapsed(lapsed);
    } catch (error) {
      console.error("ending a lapsed subscription failed", error);
      return away(origin, studio("billing=error"));
    }
  }
  // Another store of the same account pays as the customer its owner already
  // is, so one person is one customer at Stripe however many stores they run.
  if (!customerId && store.extra) {
    const owned = await accountStores(store.email).catch(() => []);
    customerId = owned.find((other) => other.stripeCustomerId)?.stripeCustomerId ?? null;
  }

  const grant=await reserveContractFunding(store.statsId??'',tier,cycle,'checkout');
  if(!grant)return away(origin,studio('billing=not-open'));
  try {
    const url = await createBillingCheckout(store, origin, { tier, cycle }, customerId, grant, expiresAtSeconds);
    return new Response(null, { status: 303, headers: { Location: url } });
  } catch (error) {
    console.error("billing checkout failed", error);
    return away(origin, studio("billing=error"));
  }
}
