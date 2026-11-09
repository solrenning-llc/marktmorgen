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
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { firstSaleAt, isSale, noteFirstSale, offerYearly, yearlyOfferEmail } from "@/lib/yearly-offer";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_offer_only";
process.env.RESEND_API_KEY = "re_test_yearly_offer_only";

const NOW = 1_791_700_000;
const emails: { to: string; subject: string; text: string }[] = [];
let earlier: Record<string, unknown>[] = [];
let stripeDown = false;
const subs: Record<string, Record<string, unknown>> = {};

function subscription(id: string, interval: "month" | "year", over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "active",
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
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, text: body.text });
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

  done();
}

main();
