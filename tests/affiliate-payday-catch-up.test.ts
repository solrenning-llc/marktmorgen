/**
 * A payday the daily run did not reach is still kept on the next days of the month (#4620, part 1).
 *
 * sendPaydayEmails handled a store only when its payday was today's date. The run stops at its deadline, and a page
 * of stores that does not read threw out of the loop, so a store the run did not reach on its payday got no payday
 * email and, with auto-pay, no pay, and the next day its payday was no longer today: it waited a whole month. A store
 * is now due on its payday and the PAYDAY_CATCH_UP_DAYS days after it in the same month, while the month's claim
 * (claimMonth) is not taken, so nothing is ever sent twice; and a page that does not read ends the run as not
 * complete instead of throwing.
 *
 * Synthetic store, affiliate and sale; Resend is a stand-in that keeps what was sent; MemoryRedis.
 */
import { mock } from "node:test";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import * as paydayJob from "@/lib/affiliate-payday";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = new Date(Date.UTC(2026, 10, 15, 14));
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
process.env.STRIPE_SECRET_KEY = "sk_test_payday_catch_up_only";
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

async function storeWithPayday(day: number): Promise<void> {
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
}

const { sendPaydayEmails } = paydayJob;
const { PAYDAY_CATCH_UP_DAYS } = paydayJob;
const run = () => sendPaydayEmails(Date.now() + 20_000, NOW);

async function main(): Promise<void> {
  part("A payday two days ago that no run reached");
  await storeWithPayday(13);
  const late = await run();
  is("the payday email goes today", [late.sent, sent.length], [1, 1]);
  is("and a second run sends nothing more (the month's claim)", (await run()).sent, 0);

  part("Control: a payday today still goes, and one long past waits for next month");
  await storeWithPayday(15);
  is("today's payday", (await run()).sent, 1);
  await storeWithPayday(15 - PAYDAY_CATCH_UP_DAYS - 1);
  is("a payday past the catch-up days is not sent this late", (await run()).sent, 0);
  await storeWithPayday(16);
  is("a payday later this month is not sent early", (await run()).sent, 0);

  part("A page of stores that does not read ends the run as not complete");
  await storeWithPayday(15);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SCAN")) return [["0", "not a list"]];
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const odd = await run().catch(() => "threw" as const);
  redis.pipeline = pipeline;
  is("no throw out of the run", odd === "threw", false);
  is("said not complete", odd !== "threw" && odd.complete, false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
