/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only): a paid download while the store's request count in
 * Redis times out. The download is refused, as a count that cannot be made never becomes room, but the buyer is told
 * it could not be checked just now, with a short wait (503, Retry-After 30), never that the link "has been opened very
 * many times" with ten minutes to wait. Once Redis answers, the request goes on to the order check; a link really
 * opened too often is still told so.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { GET } from "@/app/api/store/download/route";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "moss@example.com";
let failTraffic = false;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failTraffic && commands.some((c) => c.some((a) => String(a).startsWith("nl:traffic")))) throw new Error("Redis request timed out");
  return pipeline(commands);
}) as typeof redis.pipeline;
let stripeAsked = 0;
globalThis.fetch = (async () => {
  stripeAsked += 1;
  return new Response(JSON.stringify({ error: { type: "api_error", message: "synthetic" } }), { status: 500 });
}) as typeof fetch;

const open = (session: string) => GET(new NextRequest(`https://marktmorgen.com/api/store/download?handle=moss&session_id=${session}`));

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_outage_drill_only";
  await claimHandle(OWNER, "moss", "Moss", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMoss000001", true);
  await setSubscription(OWNER, { customerId: "cus_m", subscriptionId: "sub_m", active: true, tier: "creator", period: paidPeriod() });

  part("The store's request count times out");
  failTraffic = true;
  const res = await open("cs_test_outage001");
  const text = await res.text();
  is("refused, and said as not checked just now", [res.status, res.headers.get("retry-after"), text], [503, "30", "We could not check this purchase right now. Please try again."]);
  is("never told as opened very many times", /opened very many times/.test(text), false);
  is("nothing is asked of Stripe", stripeAsked, 0);

  part("Redis answers again");
  failTraffic = false;
  const back = await open("cs_test_outage001");
  is("the request goes on to the order check, neither refused as unchecked nor as too often", [back.status !== 503 && back.status !== 429, /could not check|opened very many/.test(await back.text())], [true, false]);

  part("A link really opened too often is still told so");
  let last: Response | null = null;
  // The link's own window is 240 opens an hour (app/api/store/download/route.ts, OPENS_PER_HOUR).
  for (let i = 0; i < 260 && last?.status !== 429; i++) last = await open("cs_test_often0001");
  is("too many opens: 429 with its own words", [last?.status, /opened very many times/.test((await last?.text()) ?? "")], [429, true]);
  done();
}
main();
