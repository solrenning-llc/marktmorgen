/**
 * The welcome offer's and the come-back offer's checkouts close by the
 * offer's own end (coupon audit of 9 November 2026, finding C).
 *
 * A checkout Stripe makes without `expires_at` stays open for a day. The
 * welcome offer promises "when it ends, it has ended" (lib/welcome-offer.ts),
 * and the come-back email names the day its offer ends, so a checkout opened
 * a minute before either end must not take the discounted payment a day
 * later. Checked, with the clock played by the test:
 *
 *   - while the offer lasts, the checkout carries a closing time, never later
 *     than the person's own end and never sooner than Stripe's thirty minutes;
 *   - with less time left than Stripe keeps a checkout open, no discounted
 *     checkout opens: the page's own "this offer has ended";
 *   - when making the checkout took so long that it would close after the
 *     end, its link is never handed over;
 *   - the same for the come-back link;
 *   - the store's one welcome coupon, shared by everybody offered it, is not
 *     given a `redeem_by`: the end is each person's own, so it is kept by
 *     the checkout's closing time instead.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { openWelcome } from "@/lib/welcome-offer-send";
import { openWinBack } from "@/lib/winback-send";
import { makeSaveCoupon } from "@/lib/save-offer-coupon";
import { readClaimFull, requestCopy } from "@/lib/free";
import { readListing } from "@/lib/catalog";
import { OFFER_DAYS } from "@/lib/winback";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWelcomeOffer, setWinBack, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_welcome_deadline_only_a_stand_in";

const HOUR = 3600;
const STRIPE_SHORTEST = 30 * 60;

// The test's clock: Date.now and the Redis stand-in's expiry both read it.
let clock = Date.now();
Date.now = () => clock;
/** Seconds the clock moves while Stripe makes a checkout, for a slow request. */
let slowBy = 0;

const mails: string[] = [];
const checkouts: URLSearchParams[] = [];
const coupons: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { text: string };
    mails.push(body.text);
    return json({ id: "email_1" });
  }
  if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    checkouts.push(new URLSearchParams(String(init.body)));
    clock += slowBy * 1000;
    return json({ id: `cs_test_${"d".repeat(22)}${String(checkouts.length).padStart(2, "0")}`, url: "https://checkout.stripe.com/c/pay/deadline" });
  }
  if (url.pathname === "/v1/coupons" && init?.method === "POST") {
    coupons.push(new URLSearchParams(String(init.body)));
    return json({ id: `co_Deadline${coupons.length}` });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "owner@example.com";
const at = (seconds: number) => {
  clock = seconds * 1000;
  return seconds;
};
const closing = (body: URLSearchParams | undefined) => (body?.has("expires_at") ? Number(body.get("expires_at")) : null);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDeadline01", true);
  await setSubscription(OWNER, { customerId: "cus_Deadline0001", subscriptionId: "sub_Deadline0001", active: true, period: paidPeriod() });
  const free = await addProduct(OWNER, "Pantry Guide", "", "0", null);
  const paid = await addProduct(OWNER, "Knife Skills", "", "49", null);
  const club = await addProduct(OWNER, "Supper Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!free.ok || !paid.ok || !club.ok) throw new Error("no products");
  for (const p of [free, paid, club]) await setProductLink(OWNER, p.product.id, "https://example.com/file");
  await setWelcomeOffer(OWNER, { product: paid.product.id, percent: 25, hours: 24, coupon: "c_welcome25", remind: false, address: "1 Main St, Springfield, IL 62701" });
  await setWinBack(OWNER, { percent: 25, months: 1, days: 7, coupon: "co_Back0001", address: "1 Main St, Springfield, IL 62701" });
  let store = (await storeForEmail(OWNER))!;

  const product = (await readListing(store, free.product.id))!;
  const result = await requestCopy({ store, product, email: "lead@example.com", consent: true, ip: "10.0.0.1", origin: "https://marktmorgen.com" });
  if (result !== "sent") throw new Error(`not sent: ${result}`);
  const token = /token=([0-9a-f]{64})/.exec(mails[0] ?? "")?.[1] ?? "";
  const claim = (await readClaimFull(token))!;
  const asked = Math.floor(Date.parse(claim.at) / 1000);
  const until = asked + 24 * HOUR;
  const welcome = async (now: number) => {
    checkouts.length = 0;
    const opened = await openWelcome(store, token, "https://marktmorgen.com", at(now), TEST_CONSENT);
    return { opened: opened.ok ? "opened" : opened.reason, body: checkouts[0], tries: checkouts.length };
  };

  part("Welcome offer: an hour in, the checkout closes by the person's own end");
  let seen = await welcome(asked + HOUR);
  is("control: the checkout opens with the welcome coupon", [seen.opened, seen.body?.get("discounts[0][coupon]"), seen.body?.get("metadata[welcome]")], ["opened", "c_welcome25", "yes"]);
  let closes = closing(seen.body);
  is("it carries a closing time (expires_at)", closes !== null, true);
  is("never after the person's own end", closes !== null && closes <= until, true);
  is("never sooner than Stripe's thirty minutes", closes !== null && closes >= asked + HOUR + STRIPE_SHORTEST, true);

  part("Welcome offer: 32 minutes left, still opens, and closes by the end");
  seen = await welcome(until - 32 * 60);
  closes = closing(seen.body);
  is("opens", seen.opened, "opened");
  is("closes by the end, not a day later", closes !== null && closes <= until, true);

  part("Welcome offer: less time left than Stripe keeps a checkout open");
  for (const left of [20 * 60, 60]) {
    seen = await welcome(until - left);
    is(`${left / 60} minute(s) left: the page's "this offer has ended", no discounted checkout`, [seen.opened, seen.tries], ["expired", 0]);
  }

  part("Welcome offer: Stripe slow enough that the checkout would close after the end");
  slowBy = 5 * 60;
  seen = await welcome(until - 32 * 60);
  slowBy = 0;
  is("control: Stripe was asked once", seen.tries, 1);
  is("its link is never handed over", seen.opened, "expired");

  part("Welcome offer: after the end, as before");
  seen = await welcome(until);
  is("control: no checkout at the end", [seen.opened, seen.tries], ["expired", 0]);

  part("The store's one welcome coupon is shared, so it gets no redeem_by");
  coupons.length = 0;
  await makeSaveCoupon(store, 25, 1, "welcome");
  is("control: one coupon per store, once", [coupons.length, coupons[0]?.get("duration"), coupons[0]?.get("metadata[purpose]")], [1, "once", "welcome"]);
  is("no redeem_by: one person's end would end everybody's offer", coupons[0]?.has("redeem_by"), false);

  part("Come-back link: the checkout closes by the day the email named");
  store = (await storeForEmail(OWNER))!;
  const now = asked + 2 * HOUR;
  const grant = async (seconds: number) => {
    at(now);
    const back = Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
    await redis.pipeline([["SET", `nl:wb:link:${back}`, JSON.stringify({ s: store.statsId, e: "member@example.com", p: club.product.id, o: "", c: "co_Back0001", pc: 25, m: 1 }), "EX", seconds]]);
    return back;
  };
  const comeBack = async (back: string) => {
    checkouts.length = 0;
    const opened = await openWinBack(store, club.product.id, back, "https://marktmorgen.com", TEST_CONSENT);
    return { opened: opened.ok ? "opened" : opened.reason, body: checkouts[0], tries: checkouts.length };
  };
  let back = await grant(OFFER_DAYS * 86_400);
  seen = await comeBack(back);
  closes = closing(seen.body);
  is("control: opens with the come-back coupon and no trial", [seen.opened, seen.body?.get("discounts[0][coupon]")], ["opened", "co_Back0001"]);
  is("it carries a closing time (expires_at)", closes !== null, true);
  is("never after the offer's end", closes !== null && closes <= now + OFFER_DAYS * 86_400, true);
  is("never sooner than Stripe's thirty minutes", closes !== null && closes >= now + STRIPE_SHORTEST, true);

  back = await grant(32 * 60);
  seen = await comeBack(back);
  closes = closing(seen.body);
  is("32 minutes left: opens and closes by the end", [seen.opened, closes !== null && closes <= now + 32 * 60], ["opened", true]);

  back = await grant(20 * 60);
  seen = await comeBack(back);
  is("20 minutes left: the page's \"this offer has ended\", no discounted checkout", [seen.opened, seen.tries], ["expired", 0]);

  back = await grant(32 * 60);
  slowBy = 5 * 60;
  seen = await comeBack(back);
  slowBy = 0;
  is("Stripe slow past the end: Stripe was asked once, and the link is never handed over", [seen.tries, seen.opened], [1, "expired"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
