/**
 * MM-SA-52 (docs/security-audit-2026-10-28.md): a draft's existence must not
 * show in where a public form sends a visitor. A draft (product.hidden) is
 * not on sale, so the two sale doors answer it exactly as they answer an id
 * the store does not have:
 *
 *   - app/api/store/paypal/checkout/route.ts sent a draft to its product
 *     page and an unknown id to the store's page;
 *   - app/api/store/package/route.ts sent a draft call's package to the
 *     call's booking page "unavailable" and an unknown id to the store's page.
 *
 * Not app/api/store/podcast/link/route.ts: there a buyer of a podcast that
 * went back to draft still asks for their own feed's link, and its answer
 * is "sent" whoever asks, so it tells nobody who bought what.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setPayPalSeller, setProductCall, setProductHidden, setStripeAccount, setSubscription } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { POST as payPayPal } from "@/app/api/store/paypal/checkout/route";
import { POST as buyPackage } from "@/app/api/store/package/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

const weekly: CallSetup = {
  kind: "weekly",
  minutes: 60,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_draft_unknown_only";
  const OWNER = "draft-owner@example.com";
  await claimHandle(OWNER, "draftshop", "Draft Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDraftShop01", true);
  await setSubscription(OWNER, { customerId: "cus_DraftShop01", subscriptionId: "sub_DraftShop01", active: true, period: paidPeriod() });
  await setPayPalSeller(OWNER, "DRAFTSHOP0001");
  const guide = await addProduct(OWNER, "Guide", "", "20", null);
  const call = await addProduct(OWNER, "Coaching Call", "", "120", null);
  if (!guide.ok || !call.ok) throw new Error("no products");
  is("a weekly call with a package", [(await setProductCall(OWNER, call.product.id, weekly)).ok, (await setCallPackage(OWNER, call.product.id, { sessions: 5, priceCents: 50000, days: 90 })).ok], [true, true]);
  is("both back to draft", [(await setProductHidden(OWNER, guide.product.id, true)).ok, (await setProductHidden(OWNER, call.product.id, true)).ok], [true, true]);

  let ip = 20;
  const form = (url: string, fields: [string, string][]) =>
    new NextRequest(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${(ip += 1)}` }, body: new URLSearchParams(fields) });
  const where = (response: Response) => [response.status, response.headers.get("location")];

  part("PayPal's checkout: a draft is answered as an id the store does not have");
  const paypal = (id: string) => payPayPal(form("https://marktmorgen.com/api/store/paypal/checkout", [["handle", "draftshop"], ["product", id]]));
  is("the same answer for the draft and for nothing", where(await paypal(guide.product.id)), where(await paypal("zzzzzzzzzzzz")));

  part("A call's package: a draft is answered as an id the store does not have");
  const pack = (id: string) => buyPackage(form("https://marktmorgen.com/api/store/package", [["handle", "draftshop"], ["product", id]]));
  is("the same answer for the draft and for nothing", where(await pack(call.product.id)), where(await pack("zzzzzzzzzzzz")));
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
