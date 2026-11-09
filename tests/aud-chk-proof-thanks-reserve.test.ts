/**
 * AUDIT PROOF (throwaway, 09/11/2026): invented order numbers on the thanks
 * page spend the part of a store's window kept for its buyers.
 *
 * app/[handle]/thanks/page.tsx takes withinStore("thanks-view", ..., "buyer")
 * for ANY session_id in the address, before readOrder checks its format or
 * asks Stripe. Public pages rest at 95% of the window (publicVisitLimit); the
 * last 5% is kept for what buyers already have (courses, community, podcast,
 * downloads, the thanks page itself). An anonymous visitor with made-up ids
 * takes that 5% too, and then a paying student is sent to /resting until
 * the window turns. Each check states the DESIRED behaviour; a FAIL is the
 * defect in the real code. Synthetic store; no request leaves the machine.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { withinStore } from "@/lib/metered-limits";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const store = (await storeForEmail("owner@example.com"))!;
  const now = Date.now();

  part("The page counts before it knows whether the order exists");
  const page = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  const admission = page.indexOf('withinStore("thanks-view"');
  const lookup = page.indexOf("readOrder(store, sessionId)");
  is("control: the admission comes before readOrder, on the buyers' side", [admission > 0, admission < lookup, /VIEWS_PER_TEN_MINUTES, 600, store, "buyer"\)/.test(page)], [true, true, true]);
  is("DESIRED: the order number's form is checked before anything is counted", /SESSION_ID_PATTERN|cs_\(test\|live\)/.test(page.slice(0, admission)), true);

  part("Public pages have used their 95%");
  const whole = requestLimitFor(store, now / 1000);
  const pub = publicVisitLimit(whole);
  is("control: the public side takes its 95%", await takePublicRequest(store, "public", now, pub), true);
  is("control: and rests there", await takePublicRequest(store, "public", now), false);
  is("control: a paying student's course still opens (buyers' side)", await isResting(store, now, "buyer"), false);

  part("An anonymous visitor opens /@harbor/thanks?session_id=<made up> from a few addresses");
  let admitted = 0;
  for (let ip = 1; ip <= 200; ip += 1) {
    let refusedHere = 0;
    for (let n = 0; n < 60; n += 1) {
      if (await withinStore("thanks-view", `203.0.113.${ip}|${store.handle}`, 60, 600, store, "buyer")) admitted += 1;
      else refusedHere += 1;
    }
    if (refusedHere === 60) break;
  }
  console.log(`  buyers' reserve: ${whole - pub} requests of ${whole}; taken by invented ids: ${admitted}`);
  is("DESIRED: invented order numbers take nothing from the buyers' reserve", admitted, 0);
  is("DESIRED: the paying student's course still opens afterwards", await isResting(store, now, "buyer"), false);
  done();
}

void main();
