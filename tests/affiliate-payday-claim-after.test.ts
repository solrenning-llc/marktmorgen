/**
 * The month's payday claim was taken for 40 days before the store's book was read for auto-pay and before the email
 * was written (#4620, part 3): a run stopped in between (the function's 60 s, a read that failed) lost that month's
 * pay and email for good, and the creator was never told. The claim is now a 15-minute hold until the email went,
 * or may have; then it is kept for the month. A run that stopped in between leaves a hold that runs out, and a later
 * run that month does it. An email sent keeps the month's claim, so a second run still sends nothing.
 *
 * Synthetic store, affiliate and sale; Resend is a stand-in that keeps what was sent; MemoryRedis.
 */
import { mock } from "node:test";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = new Date(Date.UTC(2026, 10, 15, 14));
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
process.env.STRIPE_SECRET_KEY = "sk_test_payday_claim_after_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body ?? "{}")) as { subject?: string }).subject));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "payday-owner@example.com";
const DAY = 86_400;
const T0 = Math.floor(NOW.getTime() / 1000) - 400 * DAY;

async function storeWithPayday(day: number): Promise<string> {
  redis.clear();
  sent.length = 0;
  await claimHandle(OWNER, "paydaystore", "Payday Store", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaydayCatch01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday: day }));
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const aff = "a1a1a1a1a1a1";
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, aff, JSON.stringify({ id: aff, email: `${aff}@example.com`, code: "a1a1a", status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "" })],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff, at: T0 + 10 * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })],
  ]);
  return statsId;
}

const run = () => sendPaydayEmails(Date.now() + 20_000, NOW);

async function main(): Promise<void> {
  part("A run stopped after the claim, before the email");
  const statsId = await storeWithPayday(15);
  const pipeline = redis.pipeline.bind(redis);
  let failOnce = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The next step after the claim: whether the creator pays from their PayPal by itself.
    if (failOnce && commands.some((c) => c[0] === "GET" && c[1] === `nl:pp:${statsId}`)) {
      failOnce = false;
      throw new Error("the function stopped here (test)");
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const stopped = await run();
  redis.pipeline = pipeline;
  is("that run sends nothing", [stopped.sent, sent.length], [0, 0]);
  is("a run within the hold still sends nothing (the claim is held)", (await run()).sent, 0);
  advance(16 * 60_000);
  mock.timers.tick(16 * 60_000);
  is("once the hold runs out, a later run sends it", [(await run()).sent, sent.length], [1, 1]);

  part("An email sent keeps the claim for the month");
  advance(2 * 86_400_000);
  mock.timers.tick(2 * 86_400_000);
  is("a run two days later sends nothing more", [(await run()).sent, sent.length], [0, 1]);
  const ttl = redis.run(["TTL", `nl:aff:payday:${statsId}:2026-11`]) as number;
  is("the claim is the month's (about 40 days)", ttl > 30 * 86_400, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
