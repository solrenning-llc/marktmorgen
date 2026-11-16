/**
 * Rule 24 (Claude 6 audit on #2898): a store that has sold must not be
 * told "your store has not made its first sale yet" because the read of its
 * first sale failed once (firstSaleAt reads an unknown as 0).
 */
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { redisPipeline, store as memory } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_nudges_only";
process.env.RESEND_API_KEY = "re_test_trial_nudges_only";

const DAY = 86_400;
const START = 1_791_000_000;
const emails: string[] = [];
const trials = [{ id: "sub_SoldRead0001", status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: "soldread" } }];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/subscriptions") {
    return new Response(JSON.stringify({ data: trials, has_more: false }), { status: 200 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body ?? "{}")).text ?? "");
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main() {
  part("A store that sold, whose first-sale read fails once");
  await claimHandle("soldread@example.com", "soldread", "Sold Read", "");
  await setSubscription("soldread@example.com", { subscriptionId: "sub_SoldRead0001", active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
  const shop = (await storeForEmail("soldread@example.com"))!;
  const key = `nl:firstsale:${shop.sid || `h:${shop.handle}`}`;
  await redisPipeline([["SET", key, String(START + DAY)]]);
  const real = memory.pipeline.bind(memory);
  let failOnce = true;
  memory.pipeline = (async (commands: (string | number)[][]) => {
    if (failOnce && commands.some((c) => c[0] === "GET" && c[1] === key)) {
      failOnce = false;
      throw new Error("Redis request failed with status 503");
    }
    return real(commands);
  }) as typeof memory.pipeline;
  await sendTrialNudges(START + 3 * DAY);
  is("no 'has not made its first sale' email to a store that sold", emails.length, 0);

  part("A store that sold, its first sale noted with a claim value (milliseconds, a point, a random part)");
  memory.pipeline = real;
  trials.push({ id: "sub_SoldClaim001", status: "trialing", trial_start: START, trial_end: START + 14 * DAY, cancel_at_period_end: false, metadata: { store: "soldclaim" } });
  await claimHandle("soldclaim@example.com", "soldclaim", "Sold Claim", "");
  await setSubscription("soldclaim@example.com", { subscriptionId: "sub_SoldClaim001", active: true, tier: "creator", cycle: "month", trialEnds: START + 14 * DAY, period: paidPeriod() });
  const claimed = (await storeForEmail("soldclaim@example.com"))!;
  await redisPipeline([["SET", `nl:firstsale:${claimed.sid || `h:${claimed.handle}`}`, `${(START + DAY) * 1000}.000000042`]]);
  const result = await sendTrialNudges(START + 3 * DAY + 60);
  is("read as sold: no email to it", emails.length, 0);
  is("and not counted as failed", result.failed, 0);
  done();
}

main();
