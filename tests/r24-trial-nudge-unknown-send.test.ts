/**
 * Rule 24 (Claude 6 audit on #2898): a trial nudge whose send comes back
 * unknown (the provider took it, then the connection dropped) must never be
 * sent a second time on a later run.
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_nudges_only";
process.env.RESEND_API_KEY = "re_test_trial_nudges_only";

const DAY = 86_400;
const START = 1_791_000_000;
let delivered = 0;
let dropAfterAccept = true;
const trials = [{ id: "sub_Unknown00001", status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: "unknownstore" } }];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") {
    return new Response(JSON.stringify({ data: trials, has_more: false }), { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    delivered += 1; // the provider took it and it reaches the inbox
    if (dropAfterAccept) throw new TypeError("socket hang up"); // and the reply is lost
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("A nudge whose send came back unknown is not sent again");
  await claimHandle("unknown@example.com", "unknownstore", "Unknown", "");
  await setSubscription("unknown@example.com", { subscriptionId: "sub_Unknown00001", active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
  await sendTrialNudges(START + 3 * DAY);
  const first = delivered;
  is("the first run reached the provider", first >= 1, true);
  dropAfterAccept = false;
  await sendTrialNudges(START + 4 * DAY);
  is("the next day's run sends nothing more", delivered, first);
  done();
}

main();
