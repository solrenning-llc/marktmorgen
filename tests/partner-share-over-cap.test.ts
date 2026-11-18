/**
 * A partner's share names more products than one share may hold (MAX_SHARED_PRODUCTS, lib/partner-share.ts).
 *
 * Before this, parsePartnerShare kept the first 200 and dropped the rest without a word, and the route answered
 * "ok": the agreement on record differed from the one the creator chose, and the partner was promised products
 * that were never written down. Now a share over the cap is refused with its own message and nothing is saved,
 * the way app/api/store/affiliates/route.ts already refuses an out-of-range commission. Synthetic store, in-memory
 * Redis double, through the real route; no email or payment leaves.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { listAffiliates } from "@/lib/affiliates";
import { waitingFor } from "@/lib/partner-invites";
import { MAX_SHARED_PRODUCTS, SHARE_PROBLEMS, parsePartnerShare } from "@/lib/partner-share";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { skipWaits } from "./skip-waits";

skipWaits(["takeLock", "paced"]);
process.env.RESEND_API_KEY = "re_test_partner_over_cap";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function shop(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} store`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, `acct_1${handle.padEnd(15, "x").slice(0, 15)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  return async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; accepted?: boolean; waiting?: boolean } };
  };
}

/** `count` distinct product ids in the shape a share accepts. */
const ids = (count: number) => Array.from({ length: count }, (_, i) => `prod${String(i).padStart(6, "0")}`);

async function main(): Promise<void> {
  redis.clear();

  part("1. The parser never keeps part of a list");
  is("the cap is still 200 products", MAX_SHARED_PRODUCTS, 200);
  is("200 products are kept whole", parsePartnerShare({ percent: 10, products: ids(200) })?.products.length, 200);
  is("201 products are refused, never cut to the first 200", parsePartnerShare({ percent: 10, products: ids(201) }), null);
  is("the same id twice is one product, so 201 entries with one repeat still fit", parsePartnerShare({ percent: 10, products: [...ids(200), ids(1)[0]] })?.products.length, 200);
  is("the refusal has its own words, naming the cap", SHARE_PROBLEMS.many.includes(String(MAX_SHARED_PRODUCTS)), true);

  const owner = "maker@example.com";
  const post = await shop(owner, "makershop");
  const made = await addProduct(owner, "Bread Basics", "", "40");
  const product = made.ok ? made.product.id : "";
  const terms = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 5, days: 60, rates: {} as Record<string, number> };
  is("(the program is on, 5% to affiliates)", (await post(terms)).body.ok, true);
  const partner = await shop("partner@example.com", "partnershop");

  part("2. An invitation naming 201 products is refused and nothing is sent");
  const over = await post({ action: "invite", email: "partner@example.com", percent: 10, products: ids(201) });
  is("refused with the cap's own error", [over.status, over.body.ok, over.body.error], [400, false, "share_many"]);
  is("no invitation waits in the partner's studio", (await waitingFor("partner@example.com")).length, 0);

  part("3. A partner's share changed to 201 products is refused and the old share stays");
  const fits = await post({ action: "invite", email: "partner@example.com", percent: 10, products: [product] });
  is("(an invitation for one product waits)", [fits.status, fits.body.waiting], [200, true]);
  const offer = (await waitingFor("partner@example.com"))[0];
  const yes = await partner({ action: "answer", invite: offer.id, accept: true });
  is("(and is accepted)", [yes.status, yes.body.accepted], [200, true]);
  const store = async () => (await storeForEmail(owner))!;
  const held = (await listAffiliates(await store())).find((p) => p.email === "partner@example.com");
  is("(the partner holds 10% of one product)", [held?.share?.percent, held?.share?.products], [10, [product]]);
  const change = await post({ action: "share", id: held?.id, percent: 10, products: ids(201) });
  is("refused with the cap's own error, never ok", [change.status, change.body.ok, change.body.error], [400, false, "share_many"]);
  const after = (await listAffiliates(await store())).find((p) => p.email === "partner@example.com");
  is("the share on record is the one that was there, not 200 of the 201", after?.share?.products, [product]);
  done();
}
main();
