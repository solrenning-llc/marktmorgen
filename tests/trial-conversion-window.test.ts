/**
 * The day a creator's free trial turns into their first paid month (synthetic).
 *
 * While trialing a store keeps no billing period (lib/billing.ts periodOf is
 * null while trialing), so its snapshot after the trial ends says: plan
 * running, trial over, period unknown. lib/allowance-window.ts answers no
 * window for that ("unknown is closed"). Before this, only the studio or the
 * once-a-day job (lib/billing-sync.ts, /api/cron/plans at 09:00 UTC) read the
 * period from Stripe, so from the moment the trial ended until the next daily
 * run (up to a day) or until the creator happened to open the studio, every
 * buyer's checkout (admitOrders, "unavailable") and every buyer's
 * transactional email (takeAllowance) was refused for the store that had just
 * started paying.
 *
 * Now the buyer's path reads the period from Stripe itself
 * (refreshPeriodOnce), at most once per store per PERIOD_READ_CLAIM_SECONDS
 * whatever the number of buyers. Nothing is assumed: a failed or unreadable
 * reply leaves the window unknown and the checkout refused as before.
 *
 * Real code: setSubscription and the in-memory Redis stand-in,
 * allowanceWindow, admitOrders, takeAllowance, refreshPeriodOnce; Stripe is a
 * stand-in fetch. No network, no write to Stripe.
 */
import { allowanceWindow } from "@/lib/allowance-window";
import { PERIOD_READ_CLAIM_SECONDS } from "@/lib/billing-sync";
import { admitOrders } from "@/lib/order-admission";
import { takeAllowance } from "@/lib/store-allowance";
import { PLAN_PRICES, TRIAL_DAYS } from "@/lib/plan";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, storeForHandle, storeRef } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_trial_conversion_window_only";

const HOUR = 3_600_000;
const trialEndMs = Date.UTC(2026, 11, 15, 14, 0, 0);
const trialEnds = trialEndMs / 1000;
const paidEnd = Date.UTC(2027, 0, 15, 14, 0, 0) / 1000;

/** What Stripe answers for each subscription. */
const replies = new Map<string, () => Promise<Response>>();
const calls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "api.stripe.com" || (init?.method ?? "GET") !== "GET") throw new Error(`unexpected external operation: ${init?.method} ${url}`);
  calls.push(url.pathname);
  const reply = replies.get(url.pathname.replace(/^\/v1\/subscriptions\//, ""));
  if (!reply) throw new Error(`unexpected Stripe path: ${url.pathname}`);
  return reply();
}) as typeof fetch;

/** The subscription as Stripe has it the moment the trial turned into the first paid month. */
function firstPaidMonth(id: string, handle: string) {
  return {
    id,
    object: "subscription",
    status: "active",
    customer: `cus_${id.slice(4)}`,
    metadata: { store: handle },
    trial_end: trialEnds,
    cancel_at: null,
    cancel_at_period_end: false,
    pending_update: null,
    items: {
      object: "list",
      has_more: false,
      data: [{
        id: `si_${id.slice(4)}`,
        quantity: 1,
        current_period_start: trialEnds,
        current_period_end: paidEnd,
        price: { id: "price_TrialConv001", currency: "usd", unit_amount: PLAN_PRICES.creator.month, lookup_key: "nimbus_creator_month", recurring: { interval: "month", interval_count: 1 } },
      }],
    },
  };
}

/** A store whose trial ended, recorded exactly as the way back and the daily job write a trialing subscription. */
async function converted(owner: string, handle: string, id: string) {
  await claimHandle(owner, handle, `Shop ${handle}`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${id.slice(4)}`, subscriptionId: id, active: true, tier: "creator", cycle: "month", trialEnds, period: null });
  return (await storeForEmail(owner))!;
}

const claimKey = async (owner: string) => `nl:billing:period-read:${storeRef((await storeForEmail(owner))!)}`;

async function main() {
  redis.clear();
  const realError = console.error;
  console.error = () => {};
  const at = trialEndMs + HOUR;

  part("Success: the first paid month is read from Stripe once, then buyers are served");
  {
    const owner = "trial-converted@example.com";
    const id = "sub_TrialConv001";
    const s = await converted(owner, "trialconverted", id);
    replies.set(id, async () => Response.json(firstPaidMonth(id, "trialconverted")));
    is("during the trial, the trial is its window", allowanceWindow(s, trialEndMs - HOUR)?.start, trialEndMs - TRIAL_DAYS * 86_400_000);
    is("the record alone gives no window after the trial (unknown is closed, nothing assumed)", allowanceWindow(s, at), null);
    calls.length = 0;
    is("a buyer's checkout is admitted", (await admitOrders(s, 1, at)).ok, true);
    is("one call to Stripe, for this subscription", calls, [`/v1/subscriptions/${id}`]);
    is("the first paid month is written down as Stripe gave it", (await storeForEmail(owner))?.period, { start: trialEnds, end: paidEnd, renews: true });
    is("its window starts where the trial ended", allowanceWindow((await storeForEmail(owner))!, at)?.start, trialEndMs);
    calls.length = 0;
    is("a buyer's transactional email is counted (store read fresh)", (await takeAllowance((await storeForHandle("trialconverted"))!, "transactional", 1, at)).ok, true);
    is("a buyer's transactional email is counted (an object read before the refresh)", (await takeAllowance(s, "transactional", 1, at)).ok, true);
    is("another checkout on the stale object is admitted too", (await admitOrders(s, 1, at)).ok, true);
    is("no further call to Stripe once the period is known", calls, []);
  }

  part("Stripe failure: still unknown, still refused, never an assumed window");
  {
    const owner = "trial-failed@example.com";
    const id = "sub_TrialFail001";
    const s = await converted(owner, "trialfailed", id);
    replies.set(id, async () => Response.json({ error: { type: "api_error", message: "synthetic outage" } }, { status: 500 }));
    calls.length = 0;
    is("a buyer's checkout is refused", await admitOrders(s, 1, at), { ok: false, reason: "unavailable" });
    is("one call to Stripe was made", calls.length, 1);
    is("nothing written: the period is still unknown", (await storeForEmail(owner))?.period ?? null, null);
    is("a buyer's transactional email is refused", (await takeAllowance(s, "transactional", 1, at)).ok, false);
    is("no second call inside the claim", calls.length, 1);

    // An unreadable success (the reply does not say which subscription it is) is no better than a failure.
    await redis.pipeline([["DEL", await claimKey(owner)]]);
    replies.set(id, async () => Response.json({ id: "sub_SomethingElse01", status: "active" }));
    is("an unreadable reply: still refused", (await admitOrders(s, 1, at)).ok, false);
    is("one more call for it", calls.length, 2);
    is("still nothing written", (await storeForEmail(owner))?.period ?? null, null);

    // Once the claim lapses, Stripe is asked again, and an answer opens the window.
    advance((PERIOD_READ_CLAIM_SECONDS + 1) * 1000);
    replies.set(id, async () => Response.json(firstPaidMonth(id, "trialfailed")));
    is("after the claim lapses and Stripe answers, the checkout is admitted", (await admitOrders(s, 1, at)).ok, true);
    is("one more call", calls.length, 3);
  }

  part("The ceiling: a burst of buyers makes one call to Stripe, not one each");
  {
    const owner = "trial-burst@example.com";
    const id = "sub_TrialBurst001";
    const s = await converted(owner, "trialburst", id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    replies.set(id, async () => { await gate; return Response.json({ error: { type: "api_error" } }, { status: 500 }); });
    calls.length = 0;
    const burst = Promise.all([
      ...Array.from({ length: 8 }, () => admitOrders(s, 1, at)),
      ...Array.from({ length: 8 }, () => takeAllowance(s, "transactional", 1, at)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const answers = await burst;
    is("sixteen buyers, one call to Stripe", calls.length, 1);
    is("every one of them refused while the period is unknown", answers.every((a) => !a.ok), true);
    const [ttl] = (await redis.pipeline([["TTL", await claimKey(owner)]])) as unknown[];
    is("the claim lasts PERIOD_READ_CLAIM_SECONDS at the most", Number(ttl) > 0 && Number(ttl) <= PERIOD_READ_CLAIM_SECONDS, true);
    is("(the claim is a minute)", PERIOD_READ_CLAIM_SECONDS, 60);
    await Promise.all(Array.from({ length: 20 }, () => admitOrders(s, 1, at)));
    is("twenty more buyers inside the claim: still one call", calls.length, 1);
  }

  part("No Stripe configured: nothing is asked, nothing assumed");
  {
    const key = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const s = await converted("trial-nokey@example.com", "trialnokey", "sub_TrialNoKey001");
    calls.length = 0;
    is("refused", (await admitOrders(s, 1, at)).ok, false);
    is("no call", calls.length, 0);
    process.env.STRIPE_SECRET_KEY = key;
  }
  console.error = realError;
  done();
}

void main();
