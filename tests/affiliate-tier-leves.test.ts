/**
 * The LOWs on the waiting second tier that Codex X6 held open at b93fdc265f (Claude 7 6894655652), synthetic only:
 *
 *   1. approving a line never promises the next payment batch, which a hold on the store or on the affiliate can
 *      still keep it out of;
 *   2. the panel does not say every waiting line lacks the buyer's email: a line also waits when an affiliate's
 *      record could not be read;
 *   5. the focus after approving: on success, to the panel's heading (the line is gone); on failure, to the message;
 *   6. sales whose record reads in another shape are moved like a failed read, so a batch of them never holds the
 *      place of the sales behind them (fixed earlier in lib/affiliates.ts; this is its regression).
 */
import { readFileSync } from "node:fs";
import * as affiliates from "@/lib/affiliates";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteSession } from "@/lib/affiliates";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_leves";
process.env.RESEND_API_KEY = "re_test_tier_leves";

const OWNER = "leves@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";
type Settle = (store: unknown, now?: number, deadline?: number) => Promise<{ decided: number; waiting: number; failed: number }>;
const settle = (affiliates as unknown as { settleUnconfirmed: Settle }).settleUnconfirmed;
const BATCH = (affiliates as unknown as { UNCONFIRMED_BATCH: number }).UNCONFIRMED_BATCH;

let sessions: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const one = url.pathname.match(/^\/v1\/(checkout\/sessions|payment_intents)\/([A-Za-z0-9_]+)$/);
  if (one) {
    const found = sessions[one[2]];
    return found ? answer(found) : answer({ error: { message: "no such" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 300 * DAY) * 1000, decidedAt: (NOW - 300 * DAY) * 1000, note: "", ...over });
const order = (id: string, at: number) => ({
  id, mode: "payment", status: "complete", payment_status: "paid", created: at, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd",
  total_details: { amount_tax: 0 }, payment_intent: `pi_${id}`,
  metadata: { store: "lighthouse", product: "prod01", title: "Bread course", via: BEA, via_rate: "30" },
  customer_details: { email: null },
});

async function main(): Promise<void> {
  const panel = readFileSync("components/affiliate-unconfirmed.tsx", "utf8");

  part("1. Approving never promises the next payment batch");
  is("the toast does not say it is in the next batch", /It is in your next payment batch/.test(panel), false);
  is("the confirmation does not say it goes into the next batch", /It goes into your next payment batch/.test(panel), false);
  is("both say a hold still applies", (panel.match(/hold on your store or on this affiliate/g) ?? []).length >= 2, true);

  part("2. The panel names both reasons a line waits");
  is("not only a missing email", /did not give us the buyer's email, so we cannot tell/.test(panel), false);
  is("a record that could not be read is named too", /or we could not read an affiliate's record/.test(panel), true);

  part("5. The focus after approving");
  is("the heading can take the focus", /id="unconfirmed-title"[^>]*tabIndex=\{-1\}|tabIndex=\{-1\}[^>]*id="unconfirmed-title"/.test(panel), true);
  is("on success, the heading takes it (the line is gone)", /toast\([^)]*\);\s*heading\.current\?\.focus\(\)/.test(panel), true);
  is("on failure, the message takes it", /role="alert"[^>]*tabIndex=\{-1\}/.test(panel) && /message\.current\?\.focus\(\)/.test(panel), true);

  part("5b. The focus is never dropped while approving or after the last line (Claude 4's LOWs on #3485 @eff4ed6779)");
  is("the panel stays, with its heading, after its last line is approved", /if \(!lines\.length && !cleared\) return null;/.test(panel), true);
  is("and says nothing is waiting now", /No commissions are waiting for a buyer check now\./.test(panel), true);
  is("the confirm button is never natively disabled while the request runs", /ref=\{confirmButton\}[^>]*\sdisabled=/.test(panel), false);
  is("it says so with aria-disabled, and its handler refuses a second press", /ref=\{confirmButton\}[^>]*aria-disabled=\{busy !== null\}/.test(panel) && /if \(busy !== null\) return;/.test(panel), true);

  part("6. A batch of sales that read in another shape never holds the place of the sales behind them");
  redis.clear();
  sessions = {};
  await claimHandle(OWNER, "lighthouse", "Lighthouse", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierLeves1", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 10 }));
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
  ]);
  const bad = Array.from({ length: BATCH }, (_, n) => `cs_bad${n}`);
  for (const [n, ref] of bad.entries()) await noteSession(store, order(ref, NOW - 900 + n));
  await noteSession(store, order("cs_behind", NOW - 600));
  sessions.cs_behind = { id: "cs_behind", customer_details: { email: "kai@example.com" } };
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original(commands);
    return commands.map((command, at) => (command[0] === "HGET" && bad.includes(String(command[2])) ? {} : replies[at]));
  }) as typeof redis.pipeline;
  let first: Awaited<ReturnType<Settle>>;
  let second: Awaited<ReturnType<Settle>>;
  try {
    first = await settle(store, NOW + 60);
    second = await settle(store, NOW + 120);
  } finally {
    redis.pipeline = original;
  }
  is("the first run counts the batch that read in another shape as failed", first.failed, BATCH);
  is("and the next run reaches the sale behind them and decides it", second.decided, 1);

  done();
}

void main();
