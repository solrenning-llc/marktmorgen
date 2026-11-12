/**
 * A share for one affiliate, and the PayPal address they choose.
 *
 * Measured before it was built (30 September 2026): Stan lets a creator edit
 * one affiliate's commission (help.stan.store, article 378), and its
 * affiliates connect their own Stripe or PayPal to be paid (article 402).
 * What is checked:
 *
 *   - a share set for one affiliate replaces the program's and each
 *     product's, except on a product taken out at 0%, and reaches the sale,
 *     the add-on and the approval email; cleared, the program's shares return;
 *   - out-of-range shares are refused;
 *   - an affiliate's own PayPal address is where PayPal pays them, in the API
 *     batch and in the uploaded file; the address they joined with hears of
 *     every change; a bad address changes nothing.
 */
import { commissionRate } from "@/lib/affiliate-setting";
import { createHash } from "node:crypto";
import { attributionFor, funnelRate, payAddress, readAffiliate, setAffiliateRate, setPayAddress } from "@/lib/affiliates";
import { paypalCsv } from "@/lib/affiliate-payouts";
import { batchBody } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Rule 23: a statistics id of the shape a real store has (lib/store.ts LIST_ID_PATTERN), so the store kept below reads back as itself.
const STATS = "5a7151d1".repeat(4);
const AFF = "0123456789ab";
const emails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "e" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidharbor01",
    handle: "harbor",
    name: "Harbor Kitchen",
    email: "owner@example.com",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    currency: "usd",
    affiliates: { enabled: true, percent: 20, days: 30, rates: { front: 0, course: 40 }, payday: 0, hold: 0 },
  } as unknown as Store;
}

async function main(): Promise<void> {
  process.env.RESEND_API_KEY = "re_test_only";
  redis.clear();
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ["HSET", `nl:aff:${STATS}:codes`, "sara", AFF],
    // Rule 23 (#2995 follow-up): a share that may raise the commission is now checked against the 90% cap with the
    // store read again under the partner lock, and an unreadable store refuses it. So the store is kept where the
    // site keeps it (lib/store.ts ownerKey), as it would be for a real creator, instead of living only in this test.
    ["SET", `nl:store:owner:${createHash("sha256").update("nimbus-store:owner@example.com").digest("hex").slice(0, 40)}`, JSON.stringify(shop())],
  ]);
  const store = shop();
  const cookie = { via: `sara.${Math.floor(Date.now() / 1000)}`, session: undefined };

  part("A share for one affiliate");
  is("an affiliate written before this existed has none", (await readAffiliate(store, AFF))?.rate, null);
  is("the program's shares until one is set", [(await attributionFor(store, "guide", cookie))?.rate, (await attributionFor(store, "course", cookie))?.rate], [20, 40]);
  is("out of range is refused", [await setAffiliateRate(store, AFF, 0), await setAffiliateRate(store, AFF, 91), await setAffiliateRate(store, AFF, 12.5)], [null, null, null]);
  await setAffiliateRate(store, AFF, 50);
  is("set: it replaces the store's and each product's", [(await attributionFor(store, "guide", cookie))?.rate, (await attributionFor(store, "course", cookie))?.rate], [50, 50]);
  is("except a product taken out at 0%", (await attributionFor(store, "front", cookie))?.rate, 0);
  is("and it rides to the add-on and the offers after paying", [(await attributionFor(store, "guide", cookie))?.own, await funnelRate(store, AFF, "course")], [50, 50]);
  is("the rule itself", [commissionRate(store.affiliates, "x", 30), commissionRate(store.affiliates, "front", 30), commissionRate(store.affiliates, "course", null)], [30, 0, 40]);
  await setAffiliateRate(store, AFF, null);
  is("cleared: the program's shares again", (await attributionFor(store, "guide", cookie))?.rate, 20);

  part("Where PayPal pays them");
  let sara = (await readAffiliate(store, AFF))!;
  is("the address they joined with, until they choose", payAddress(sara), "sara@example.com");
  is("a bad address changes nothing", [await setPayAddress(store, sara, "not an address"), (await readAffiliate(store, AFF))?.paypal], [{ ok: false, reason: "email" }, ""]);
  await setPayAddress(store, sara, "  Sara.Pay@Example.com ");
  sara = (await readAffiliate(store, AFF))!;
  is("chosen", payAddress(sara), "sara.pay@example.com");
  is("the address they joined with is told", [emails.length, String(emails[0]?.to), emails[0]?.text.includes("sara.pay@example.com")], [1, "sara@example.com", true]);
  const line = [{ affiliate: sara, cents: 3000 }];
  const body = JSON.parse(batchBody(store, line, "nl-x")) as { items: { receiver: string }[] };
  is("PayPal is sent there", body.items[0].receiver, "sara.pay@example.com");
  is("and the file for PayPal says the same", paypalCsv(line, "usd", "note").split(",")[0], '"sara.pay@example.com"');
  await setPayAddress(store, sara, "");
  is("emptied: back to the address they joined with", payAddress((await readAffiliate(store, AFF))!), "sara@example.com");
  is("told again", emails.length, 2);

  done();
}

void main();
