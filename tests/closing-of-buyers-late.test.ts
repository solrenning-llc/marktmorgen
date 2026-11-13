/**
 * The closing day the studio and the plan checkout read (closingOf) is the one
 * the daily job closes on (closeOne): never sooner than BUYER_NOTICE_DAYS after
 * the last buyer is told (lib/closing-buyers-rules.ts, afterBuyersTold).
 *
 * What fails here: a store whose buyers are not all told yet, past the day
 * first given, being shown a closing day that has already come, so its
 * creator is told it is too late to start a plan again and the checkout
 * refuses one, while the job cannot close it for at least BUYER_NOTICE_DAYS
 * after its buyers are told. Starting a plan again before the last moment
 * keeps the store (the owner's decision of 30/10/2026, 18h16).
 */
import { createHash } from "node:crypto";
import { done, is, part } from "./check";
import "./redis-stub";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { closingOf, removalDay } from "@/lib/plan-closing";
import { lastPlanMoment } from "@/lib/closing-plan-guard";
import { BUYER_NOTICE_DAYS } from "@/lib/closing-buyers-rules";
import { redisPipeline } from "@/lib/redis";

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  part("A store whose buyers are not all told yet, past the day first given");
  const email = "late@example.com";
  await claimHandle(email, "late", "Late Shop", "");
  await setSubscription(email, { customerId: "cus_late0001", subscriptionId: "sub_lateold001", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const store = (await storeForEmail(email))!;
  const endedAt = Date.parse(store.planEndedAt);
  const firstDay = removalDay(endedAt);
  // Every notice to the creator went out on time; its buyers' notices started and are not done (a store with many buyers, or a read that failed).
  await redisPipeline([["SET", `nl:plan:closing:${createHash("sha256").update(storeRef(store)).digest("hex").slice(0, 40)}`, JSON.stringify({ of: endedAt, ended: endedAt, month: firstDay - 14 * DAY, week: firstDay - 7 * DAY, holdFrom: endedAt, hold: endedAt, buyersFrom: firstDay - 8 * DAY, buyersAfter: "start" })]]);
  const now = firstDay - 10 * 60_000;
  const closing = (await closingOf(store, now))!;
  is("it is not closing today", closing.today ?? false, false);
  is("its buyers are said not to be all told", closing.buyers?.done, false);
  is(`its day is at least ${BUYER_NOTICE_DAYS} days from the start of today, as the job counts it from when they are told`, closing.day >= Math.floor(now / DAY) * DAY + BUYER_NOTICE_DAYS * DAY, true);
  is("and the same all day, so a review drawn from it does not change under its creator", (await closingOf(store, now + 60_000))!.day, closing.day);
  is("so its creator may still start a plan to keep it", now < lastPlanMoment(closing.day), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
