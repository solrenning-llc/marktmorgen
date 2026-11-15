/**
 * The yearly plan offered at a store's first sale (added 11 October 2026,
 * lib/yearly-offer.ts). What is checked:
 *
 *   - the first paid sale is noted once, with its own date, and a store on a
 *     monthly plan gets one email that says the saving at the published
 *     prices and nothing that ends;
 *   - a tip or a checkout that charged nothing is not a sale;
 *   - a store that sold before this was built is not told it made its first
 *     sale: its earlier sale is noted, and nothing is sent;
 *   - no email to a yearly plan, a plan set to stop, or a store with no plan,
 *     and never twice for the same subscription;
 *   - when Stripe cannot be asked about earlier sales, nothing is noted, so
 *     the next pass asks again.
 */
import { claimHandle, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { firstSaleAt, isSale, noteFirstSale, offerYearly, yearlyOfferEmail } from "@/lib/yearly-offer";
import { NextRequest } from "next/server";
import { GET as stopOffersPage, POST as stopOffersRoute } from "@/app/api/store/offers/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_offer_only";
process.env.RESEND_API_KEY = "re_test_yearly_offer_only";
// The company's postal address, which a commercial email carries (lib/company-postal.ts); synthetic.
const POSTAL = "100 Example Street, Example City, NY 10001, United States";
process.env.COMPANY_POSTAL_ADDRESS = POSTAL;

const NOW = 1_791_700_000;
const emails: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
let earlier: Record<string, unknown>[] = [];
let stripeDown = false;
const subs: Record<string, Record<string, unknown>> = {};

function subscription(id: string, interval: "month" | "year", over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          current_period_end: NOW + 20 * 86_400,
          price: {
            lookup_key: `nimbus_labs_creator_${interval}`,
            unit_amount: interval === "month" ? 2900 : 30000,
            recurring: { interval },
          },
        },
      ],
    },
    ...over,
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/checkout/sessions") {
      if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
      return new Response(JSON.stringify({ data: earlier, has_more: false }), { status: 200 });
    }
    const m = url.pathname.match(/^\/v1\/subscriptions\/(sub_[A-Za-z0-9]+)$/);
    if (m && subs[m[1]]) return new Response(JSON.stringify(subs[m[1]]), { status: 200 });
    return new Response(JSON.stringify({ error: { message: "no such" } }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, text: body.text, headers: body.headers });
    return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;


/** The reply to the first pipeline that writes a key starting with `prefix`, without the write landing (CX-123 rule 24, L9). */
async function withOddWrite<T>(prefix: string, reply: unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands[0]?.[0] === "SET" && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      return reply;
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function seller(email: string, handle: string, sub: string | null) {
  await claimHandle(email, handle, "A store", "");
  await setStripeAccount(email, "acct_1TestYearly0001");
  // A store id: the offers' stop is kept by it (lib/offer-stop.ts).
  await ensureStoreId(email);
  if (sub) await setSubscription(email, { subscriptionId: sub, active: true, tier: "creator", cycle: "month" });
  return (await storeForEmail(email))!;
}

const sale = (created: number, over: Record<string, unknown> = {}) => ({ created, amount_total: 1900, payment_status: "paid", metadata: { store: "" }, ...over });

async function main() {
  part("What counts as a sale");
  is("a paid product is", isSale({ amount_total: 1900, metadata: {} }), true);
  is("a tip is not", isSale({ amount_total: 500, metadata: { kind: "tip" } }), false);
  is("nothing charged is not", isSale({ amount_total: 0, metadata: {} }), false);

  part("What the email says");
  {
    const mail = yearlyOfferEmail({ tier: "creator", trialing: false });
    is("the subject", mail.subject, "Your store just made its first sale");
    is("it says the saving at the published prices", mail.text.includes("paying yearly costs $690 instead of twelve payments of $69: $138 less over the year"), true);
    is("it says it is the only time", mail.text.includes("This is the only time we will write to you about it."), true);
    is("it names nothing that ends", /expires|ends soon|today only|limited/i.test(mail.text), false);
    const trial = yearlyOfferEmail({ tier: "creator", trialing: true });
    is("in the trial, nothing is charged now", trial.text.includes("nothing is charged now"), true);
  }

  part("A store on a monthly plan, at its first sale");
  {
    subs.sub_monthly0001 = subscription("sub_monthly0001", "month");
    const store = await seller("monthly@example.com", "monthlystore", "sub_monthly0001");
    earlier = [];
    const first = await noteFirstSale(store, [sale(NOW - 60, { metadata: { store: store.handle } })], true);
    is("it is noted as the first sale", first, true);
    is("with its own date", await firstSaleAt(store), NOW - 60);
    is("one email, to the creator", emails.map((e) => e.to), ["monthly@example.com"]);

    const again = await noteFirstSale(store, [sale(NOW, { metadata: { store: store.handle } })], true);
    is("a later sale is not a first sale", again, false);
    is("still one email", emails.length, 1);
    is("the date stays the first one", await firstSaleAt(store), NOW - 60);
  }

  part("While no plan is on sale, no switch is offered");
  {
    subs.sub_closed0001 = subscription("sub_closed0001", "month");
    const closed = await seller("closed@example.com", "closedstore", "sub_closed0001");
    const before = emails.length;
    const noted = await noteFirstSale(closed, [sale(NOW, { metadata: { store: closed.handle } })], false);
    is("the first sale is noted, and no email offers a yearly switch the studio would refuse", [noted, await firstSaleAt(closed), emails.length - before], [true, NOW, 0]);
  }

  part("A store that sold before this was built");
  {
    subs.sub_oldseller01 = subscription("sub_oldseller01", "month");
    const store = await seller("old@example.com", "oldseller", "sub_oldseller01");
    earlier = [sale(NOW - 90 * 86_400, { metadata: { store: store.handle } })];
    const first = await noteFirstSale(store, [sale(NOW, { metadata: { store: store.handle } })], true);
    is("is not told it made its first sale", first, false);
    is("its earlier sale is noted instead", await firstSaleAt(store), NOW - 90 * 86_400);
    is("and nothing is sent", emails.length, 1);
    earlier = [];
  }

  part("Only a monthly plan that is staying, once");
  {
    subs.sub_yearly00001 = subscription("sub_yearly00001", "year");
    const yearly = await seller("yearly@example.com", "yearlystore", "sub_yearly00001");
    await noteFirstSale(yearly, [sale(NOW, { metadata: { store: yearly.handle } })], true);
    is("a yearly plan is not written to", emails.length, 1);
    is("but its first sale is noted", (await firstSaleAt(yearly)) > 0, true);

    subs.sub_stopping001 = subscription("sub_stopping001", "month", { cancel_at_period_end: true });
    const stopping = await seller("stopping@example.com", "stoppingstore", "sub_stopping001");
    await noteFirstSale(stopping, [sale(NOW, { metadata: { store: stopping.handle } })], true);
    is("a plan set to stop is not written to", emails.length, 1);

    const none = await seller("none@example.com", "noplanstore", null);
    await noteFirstSale(none, [sale(NOW, { metadata: { store: none.handle } })], true);
    is("a store with no plan is not written to", emails.length, 1);
  }

  part("When Stripe cannot be asked");
  {
    subs.sub_outage00001 = subscription("sub_outage00001", "month");
    const store = await seller("outage@example.com", "outagestore", "sub_outage00001");
    stripeDown = true;
    const down = await noteFirstSale(store, [sale(NOW, { metadata: { store: store.handle } })], true);
    is("nothing is noted", [down, await firstSaleAt(store)], [false, 0]);
    stripeDown = false;
    const up = await noteFirstSale(store, [sale(NOW, { metadata: { store: store.handle } })], true);
    is("the next pass notes it and writes", [up, emails.length], [true, 2]);
  }

  part("The once-per-subscription offer, read exactly (CX-123 rule 24, L9)");
  {
    subs.sub_oddanswer01 = subscription("sub_oddanswer01", "month");
    const store = await seller("odd-answer@example.com", "oddanswer", "sub_oddanswer01");
    const before = emails.length;
    is("a mark answered oddly that did not land sends nothing", await withOddWrite("nl:yearly-offer:", [undefined], () => offerYearly(store, true)), false);
    is("no email on it", emails.length - before, 0);
    is("the next whole answer sends it, once", [await offerYearly(store, true), await offerYearly(store, true), emails.length - before], [true, false, 1]);
  }

  part("A commercial email: a way to stop it and the company's postal address (CAN-SPAM, 15 U.S.C. 7704(a)(3), (a)(5))");
  {
    subs.sub_canspam0001 = subscription("sub_canspam0001", "month");
    const store = await seller("canspam@example.com", "canspamstore", "sub_canspam0001");
    const before = emails.length;
    is("sent", await offerYearly(store, true), true);
    const mail = emails[before];
    const stop = mail?.text.match(/https:\/\/\S+\/api\/store\/offers\?s=[0-9a-f]{32}&t=[A-Za-z0-9_-]+/)?.[0] ?? "";
    is("it carries a link that stops the offers", stop !== "", true);
    is("and the company's postal address", mail?.text.includes(POSTAL), true);
    is("it says plainly it is an advertisement (15 U.S.C. 7704(a)(5)(A)(i))", /This email is an advertisement/.test(mail?.text ?? ""), true);
    is("a mail app can stop it in one click (RFC 8058)", [mail?.headers?.["List-Unsubscribe"], mail?.headers?.["List-Unsubscribe-Post"]], [`<${stop}>`, "List-Unsubscribe=One-Click"]);

    part("Stopped in one click, no offer is sent again");
    const pressed = await stopOffersRoute(new NextRequest(stop, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
    is("the one-click POST stops it", pressed.status, 200);
    subs.sub_canspam0002 = subscription("sub_canspam0002", "month");
    await setSubscription("canspam@example.com", { subscriptionId: "sub_canspam0002", active: true, tier: "creator", cycle: "month" });
    const again = (await storeForEmail("canspam@example.com"))!;
    const after = emails.length;
    is("a new subscription of a stopped store is offered nothing", [await offerYearly(again, true), emails.length - after], [false, 0]);
  }

  part("The stop: only stops, needs its signed token, read by CPU first, no limit per connection (RFC 8058)");
  {
    const offersUrl = (s: string, t: string) => `https://marktmorgen.com/api/store/offers?s=${s}&t=${t}`;
    const post = (url: string, ip: string, body = "List-Unsubscribe=One-Click", headers: Record<string, string> = {}) =>
      stopOffersRoute(new NextRequest(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "x-forwarded-for": ip, ...headers } }));
    const store = await seller("stop-only@example.com", "stoponly", null);
    const realPipeline = redis.pipeline.bind(redis);
    let reads = 0;
    redis.pipeline = ((commands: (string | number)[][]) => {
      reads += 1;
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    const wrongReal = await post(offersUrl(store.sid, "x".repeat(32)), "198.51.100.20");
    const wrongNone = await post(offersUrl("f".repeat(32), "x".repeat(32)), "198.51.100.20");
    const wrongPage = await stopOffersPage(new NextRequest(offersUrl(store.sid, "y".repeat(32))));
    redis.pipeline = realPipeline;
    is("a wrong token: refused, and the same answer for a store that exists or not", [wrongReal.status, await wrongReal.text()], [wrongNone.status, await wrongNone.text()]);
    is("refused as 400", wrongReal.status, 400);
    is("a wrong token reads nothing stored (no Redis call), pressed or opened", reads, 0);
    is("its page offers the studio's way, not a reply handled by hand", [wrongPage.status, /via=studio/.test(await wrongPage.text())], [400, true]);
    is("nothing stopped by it", (await redis.pipeline([["SISMEMBER", "nl:offers:off", store.sid]]))[0], 0);
    const stop = (await import("@/lib/offer-stop")).offersStopUrl(store.sid)!;
    is("a press asking to start again only stops", (await post(stop, "198.51.100.21", "do=on")).status, 200);
    is("stopped, never started", (await redis.pipeline([["SISMEMBER", "nl:offers:off", store.sid]]))[0], 1);
    const presses: number[] = [];
    for (let i = 0; i < 60; i += 1) presses.push((await post(stop, "203.0.113.60")).status);
    is("one mail provider's address pressing 60 times in an hour is never told to wait", presses.every((status) => status === 200), true);
  }

  part("The studio's way: signed in, the creator stops their own store's offers; never from another site");
  {
    const store = await seller("stop-studio@example.com", "stopstudio", null);
    const studio = "https://marktmorgen.com/api/store/offers?via=studio";
    const cookie = `${SESSION_COOKIE}=${await openSession("stop-studio@example.com")}`;
    const signedOut = await stopOffersPage(new NextRequest(studio, { headers: { "x-forwarded-for": "198.51.100.40" } }));
    is("signed out: asked to sign in", [signedOut.status, /\/signin/.test(await signedOut.text())], [200, true]);
    const shown = await stopOffersPage(new NextRequest(studio, { headers: { cookie, "x-forwarded-for": "198.51.100.41" } }));
    is("signed in: the button", [shown.status, /Stop these offers/.test(await shown.text())], [200, true]);
    const crossSite = await stopOffersRoute(new NextRequest(studio, { method: "POST", headers: { cookie, origin: "https://elsewhere.example", host: "marktmorgen.com", "x-forwarded-for": "198.51.100.42" } }));
    is("from another site: refused, nothing stopped", [crossSite.status, (await redis.pipeline([["SISMEMBER", "nl:offers:off", store.sid]]))[0]], [403, 0]);
    const pressed = await stopOffersRoute(new NextRequest(studio, { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com", "x-forwarded-for": "198.51.100.43" } }));
    is("pressed in the studio: stopped", [pressed.status, (await redis.pipeline([["SISMEMBER", "nl:offers:off", store.sid]]))[0]], [200, 1]);
  }

  part("Without the company's postal address, nothing commercial is sent");
  {
    delete process.env.COMPANY_POSTAL_ADDRESS;
    subs.sub_nopostal001 = subscription("sub_nopostal001", "month");
    const store = await seller("nopostal@example.com", "nopostalstore", "sub_nopostal001");
    const before = emails.length;
    is("no address, no offer", [await offerYearly(store, true), emails.length - before], [false, 0]);
    process.env.COMPANY_POSTAL_ADDRESS = POSTAL;
    is("once there is one, the offer goes, once", [await offerYearly(store, true), emails.length - before], [true, 1]);
  }

  done();
}

main();
