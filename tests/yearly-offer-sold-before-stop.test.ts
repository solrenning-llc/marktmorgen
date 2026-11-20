/**
 * Past the ceiling of pages, and past the sweep's deadline, whether a store
 * sold before is not known, and nothing says it is (third money pre-review of
 * claude5/affiliate-refund-list-exact2, MEDIUMS 2 and 3).
 *
 * MEDIUM 2. Past SOLD_BEFORE_PAGES, nl:firstsale used to be written with this
 * sale's day, so later passes would stop asking Stripe. But the studio prints
 * that key as "Your store made its first sale on <day>" (app/studio/page.tsx,
 * firstSaleAt): a store that may have sold for years was told its first sale
 * was today (VR 2). Now a separate mark (nl:soldbefore:) only stops the
 * search: firstSaleAt and the studio give no day, no offer is made, and the
 * trial nudges still read the store as one that sold (it did: the sale the
 * sweep saw is real). The mark goes with the store when it closes (CLOSING,
 * lib/data-families.ts).
 *
 * MEDIUM 3. soldBefore asked up to SOLD_BEFORE_PAGES pages of up to
 * STRIPE_TIMEOUT_MS each, one after another, whatever was left of the sweep
 * (lib/checkout-sweep.ts gives the whole sweep 12 s). Now the sweep's
 * deadline is passed down: no call starts with less than a second left, each
 * waits at most what is left, and running out is not known (null), so
 * nothing is noted and the next pass asks again.
 *
 * PROOFS A and B are the pre-review's (scratchpad/prerev-affiliate-refund-
 * list-exact2-yearly-proof.test.ts), with the expectation the fix gives,
 * noted where it differs from the proof's.
 */
import { readFileSync } from "node:fs";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { firstSaleAt, noteFirstSale } from "@/lib/yearly-offer";
import { sendTrialNudges } from "@/lib/trial-nudges";
import { CLOSING, ELSEWHERE_FAMILIES, closingFamilyOf } from "@/lib/data-families";
import { redisPipeline } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_sold_before_stop";
process.env.RESEND_API_KEY = "re_test_yearly_sold_before_stop";

const NOW = 1_791_700_000;
const DAY = 86_400;
/** The ceiling of pages soldBefore follows (SOLD_BEFORE_PAGES in lib/yearly-offer.ts). */
const SOLD_BEFORE_PAGES = 5;
const emails: string[] = [];
/** Every checkout-list request: [account, starting_after]. */
let asked: [string, string][] = [];
/** How long each checkout-list request takes, in milliseconds. */
let delay = 0;
/** The pages each account gives, in order; a page's `after` is the starting_after it answers. */
const pages = new Map<string, { after: string; body: unknown }[]>();
/** The trials GET /v1/subscriptions lists (the trial nudges' pass). */
const trials: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    const account = String((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] ?? "");
    if (url.pathname === "/v1/checkout/sessions") {
      const after = url.searchParams.get("starting_after") ?? "";
      asked.push([account, after]);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const page = (pages.get(account) ?? []).find((p) => p.after === after);
      if (!page) return new Response(JSON.stringify({ error: { message: "no such page" } }), { status: 400 });
      return new Response(JSON.stringify(page.body), { status: 200 });
    }
    if (url.pathname === "/v1/subscriptions") return new Response(JSON.stringify({ object: "list", data: trials, has_more: false }), { status: 200 });
    const sub = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname)?.[1];
    if (sub) {
      return new Response(JSON.stringify({
        id: sub,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 20 * 86_400, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: "no such" } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    emails.push(String(JSON.parse(String(init?.body ?? "{}")).subject));
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const sale = (handle: string) => ({ created: NOW - 60, amount_total: 1900, payment_status: "paid", metadata: { store: handle } });
/** A full page of free checkouts (no payment required), named so each page's last id is known. */
const free = (handle: string, page: number) =>
  Array.from({ length: 100 }, (_, n) => ({ id: `cs_free_${page}_${n}`, created: NOW - 600 - page * 1000 - n, amount_total: 0, payment_status: "no_payment_required", metadata: { store: handle } }));
const lastOf = (_handle: string, page: number) => `cs_free_${page}_99`;

let made = 0;
async function shop(trial = false): Promise<{ store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>>; account: string }> {
  made += 1;
  const n = String(made).padStart(2, "0");
  const email = `stop${n}@example.com`;
  const account = `acct_1TestSoldStop${n}`;
  await claimHandle(email, `stop${n}`, "A store", "");
  await setStripeAccount(email, account);
  await setSubscription(email, trial
    ? { subscriptionId: `sub_soldstop${n}`, active: true, tier: "creator", cycle: "month", trialEnds: NOW + 14 * DAY, period: paidPeriod() }
    : { subscriptionId: `sub_soldstop${n}`, active: true, tier: "creator", cycle: "month" });
  return { store: (await storeForEmail(email))!, account };
}

/** `count` full free pages, each saying there is more, the one after `after` the next. */
function freePages(handle: string, count: number, end?: unknown): { after: string; body: unknown }[] {
  const out: { after: string; body: unknown }[] = Array.from({ length: count }, (_, page) => ({ after: page === 0 ? "" : lastOf(handle, page - 1), body: { object: "list", data: free(handle, page), has_more: true } }));
  if (end !== undefined) out.push({ after: lastOf(handle, count - 1), body: end });
  return out;
}

const stopKey = (store: { sid?: string; handle: string }) => `nl:soldbefore:${store.sid || `h:${store.handle}`}`;
const exists = async (key: string) => Number((await redisPipeline([["EXISTS", key]]))[0]);

async function main() {
  part("PROOF A: past the ceiling, a store that DID sell before (on page 6) is given no first-sale day");
  {
    const { store, account } = await shop();
    const earlier = { id: "cs_paid_old", created: NOW - 900_000, amount_total: 1900, payment_status: "paid", metadata: { store: store.handle } };
    pages.set(account, freePages(store.handle, SOLD_BEFORE_PAGES, { object: "list", data: [earlier], has_more: false }));
    const sent = emails.length;
    asked = [];
    await noteFirstSale(store, [sale(store.handle)], true);
    // Changed from the proof (rule 23): the proof wanted the earlier day (NOW - 900_000), which is on a page past the
    // ceiling and is never read; the fix gives no day at all (0), so the studio prints no "first sale", false or true.
    is("first sale is not given a day (not today, and the earlier one is not read)", await firstSaleAt(store), 0);
    is("SOLD_BEFORE_PAGES pages asked, no offer", [asked.length, emails.length - sent], [SOLD_BEFORE_PAGES, 0]);
    is("the separate mark stops the search; nl:firstsale is not written", [await exists(stopKey(store)), await exists(`nl:firstsale:${store.sid || `h:${store.handle}`}`)], [1, 0]);
    asked = [];
    for (let pass = 0; pass < 288; pass += 1) await noteFirstSale(store, [sale(store.handle)], true);
    is("a day of passes after it: no Stripe call, no offer, still no day", [asked.length, emails.length - sent, await firstSaleAt(store)], [0, 0, 0]);
  }

  part("PROOF B: soldBefore keeps to the sweep's deadline (5 sequential calls, 20 s timeout each, a 12 s sweep)");
  {
    const { store, account } = await shop();
    pages.set(account, freePages(store.handle, SOLD_BEFORE_PAGES + 1));
    delay = 400;
    asked = [];
    const t = Date.now();
    // Changed from the proof (rule 23): the proof called noteFirstSale without a deadline; the fix takes the sweep's
    // (lib/checkout-sweep.ts passes it), here 1.2 s: one page of 0.4 s, then less than a second is left and it stops.
    const noted = await noteFirstSale(store, [sale(store.handle)], true, Date.now() + 1_200);
    delay = 0;
    is("noteFirstSale stays under 1 page of latency (it took ms)", Date.now() - t < 800, true);
    is("one page asked, nothing noted, no mark: not known", [noted, asked.length, await firstSaleAt(store), await exists(stopKey(store))], [false, 1, 0, 0]);
    asked = [];
    await noteFirstSale(store, [sale(store.handle)], true, Date.now() - 1);
    is("a deadline already past: Stripe is not asked at all", asked.length, 0);
    asked = [];
    await noteFirstSale(store, [sale(store.handle)], true, Date.now() + 60_000);
    is("the next pass, with time left, reads to the ceiling and stops the search", [asked.length, await exists(stopKey(store)), await firstSaleAt(store)], [SOLD_BEFORE_PAGES, 1, 0]);
  }

  part("The sweep passes its deadline down");
  {
    const sweep = readFileSync("lib/checkout-sweep.ts", "utf8");
    is("lib/checkout-sweep.ts gives noteFirstSale the sweep's deadline", sweep.includes("noteFirstSale(store, paid, PLANS_ON_SALE, deadline)"), true);
  }

  part("A trialing store past the ceiling sold: the trial nudges do not tell it it has not");
  {
    const { store, account } = await shop(true);
    pages.set(account, freePages(store.handle, SOLD_BEFORE_PAGES + 1));
    await noteFirstSale(store, [sale(store.handle)], true);
    is("the mark is there, no day", [await exists(stopKey(store)), await firstSaleAt(store)], [1, 0]);
    trials.push({ id: store.subscriptionId, status: "trialing", trial_start: NOW, trial_end: NOW + 14 * DAY, cancel_at_period_end: false, metadata: { store: store.handle } });
    const sent = emails.length;
    const result = await sendTrialNudges(NOW + 3 * DAY);
    is("no 'has not made its first sale' email, and not counted as failed", [emails.length - sent, result.failed], [0, 0]);
  }

  part("The mark is erased with the store, as the registry says");
  {
    const family = closingFamilyOf("nl:soldbefore:sidstop01");
    is("its family, erased on closing, measured elsewhere", [family, family ? CLOSING[family] : null, ELSEWHERE_FAMILIES.includes("nl:soldbefore:")], ["nl:soldbefore:", { how: "erase" }, true]);
  }

  done();
}

void main();
