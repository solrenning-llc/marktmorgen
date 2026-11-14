/**
 * 662 [OF1], unit 2: the page a buyer lands on after paying with Stripe
 * (app/[handle]/thanks/page.tsx), for a store switched off after a report
 * (lib/takedown.ts) after the buyer paid. What was bought is still handed over
 * (the link to it, the course); nothing more is offered: no offer after paying,
 * no next step of a funnel of pages, no "Renew", no affiliate link to share the
 * store and no review form (its review page is closed then). Switched back on,
 * the page is as before.
 *
 * The real page against a stand-in for the creator's Stripe account, with
 * synthetic checkouts: a guide with an offer after paying, the browser that
 * paid holding the offer's key; a second product reached from a funnel of
 * pages, whose next step is a third; and a membership that has since ended.
 */
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import ThanksPage from "@/app/[handle]/thanks/page";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { readFunnelInput } from "@/lib/page-funnel";
import { writePageFunnel } from "@/lib/page-funnel-store";
import { UPSELL_COOKIE, newUpsellKey } from "@/lib/upsell";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setAffiliateSetting, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_of1_thanks_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_of1_thanks_only_a_stand_in";

const OWNER = "of1-thanks@example.com";
const BUYER = "of1-buyer@example.com";
const HANDLE = "of1thanks";
const ACCOUNT = "acct_1TestOfOneThx";
const BASE = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);
const t = THANKS_WORDS.en;

const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_of1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  // Nothing else bought here by this address, and no payment made since.
  if ((path === "/checkout/sessions" || path === "/payment_intents" || path === "/charges" || path === "/refunds") && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** The page drawn to HTML as a browser gets it, for the checkout `session`, from the browser holding `cookie`. */
async function open(session: string, cookie = ""): Promise<string> {
  answering(new Request(`${BASE}/@${HANDLE}/thanks?session_id=${session}`, { headers: { "x-forwarded-for": "203.0.113.11", ...(cookie ? { cookie } : {}) } }));
  try {
    const node = await ThanksPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve({ session_id: session }) });
    const stream = await renderToReadableStream(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, node as React.ReactElement), { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    throw error;
  }
}

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_OfOneThxOwn1", subscriptionId: "sub_OfOneThxOwn1", active: true, tier: "creator", period: paidPeriod() });
  const add = async (title: string, price: string, recurring: Parameters<typeof addProduct>[4] = null) => {
    const made = await addProduct(OWNER, title, "", price, recurring);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.com/files/${made.product.id}`);
    return made.product.id;
  };
  const guide = await add("Kiln Guide", "39");
  const notes = await add("Glaze Notes", "29");
  const course = await add("Firing Course", "59");
  const club = await add("Kiln Club", "20", { interval: "month", trialDays: 0, payments: 0 });
  // The guide's offer after paying: the notes.
  const funnel = await setProductFunnel(OWNER, guide, { steps: [{ id: "nts001", productId: notes, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }] });
  if (!funnel.ok) throw new Error("no offer after paying");
  // Buyers may take their own affiliate link.
  await setAffiliateSetting(OWNER, { enabled: true, percent: 30, days: 30, rule: "last", rates: {}, payday: 0, hold: 0, buyers: true } as never);
  let store = (await storeForEmail(OWNER))!;
  // A funnel of pages: the notes, then the course.
  const pages = readFunnelInput({ name: "Launch", steps: [{ kind: "product", id: notes }, { kind: "product", id: course }] }, [], NOW);
  if (!pages.ok) throw new Error("no funnel of pages");
  const pageFunnel = await writePageFunnel(store.statsId!, { ...pages.funnel, on: true }, [], ROOM);

  const key = newUpsellKey();
  const paid = (id: string, product: string, more: Record<string, unknown> = {}, meta: Record<string, string> = {}) => {
    sessions[id] = {
      id,
      status: "complete",
      payment_status: "paid",
      mode: "payment",
      created: NOW - 60,
      customer: "cus_OfOneBuyer01",
      currency: "usd",
      amount_total: 3900,
      metadata: { store: HANDLE, product, ...meta },
      customer_details: { email: BUYER },
      payment_intent: { id: `pi_test_${id.slice(-10)}`, amount_received: 3900, latest_charge: { id: `ch_test_${id.slice(-10)}`, amount_refunded: 0, refunded: false }, payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_OfOneBuyer01" } },
      ...more,
    };
  };
  paid("cs_test_of1guide000001", guide, {}, { upsell_key: key.fingerprint });
  paid("cs_test_of1notes000001", notes, {}, { funnel: pageFunnel.id });
  paid("cs_test_of1club0000001", club, { mode: "subscription", amount_total: 2000, subscription: { id: "sub_OfOneClub001", status: "canceled" } });

  const look = async () => {
    store = (await storeForEmail(OWNER))!;
    const guidePage = await open("cs_test_of1guide000001", `${UPSELL_COOKIE}=${key.secret}`);
    const notesPage = await open("cs_test_of1notes000001");
    const clubPage = await open("cs_test_of1club0000001");
    return {
      guide: {
        delivered: guidePage.includes(`https://example.com/files/${guide}`),
        offer: guidePage.includes('action="/api/store/upsell"'),
        affiliate: guidePage.includes(`/@${HANDLE}/affiliates?order=`) || guidePage.includes(escaped(t.getMyLink)),
        review: guidePage.includes(escaped(t.howIs("Kiln Guide"))),
      },
      funnel: {
        delivered: notesPage.includes(`https://example.com/files/${notes}`),
        next: notesPage.includes(`?f=${pageFunnel.id}`),
      },
      ended: {
        said: clubPage.includes(escaped(t.endedTitle)),
        renew: clubPage.includes(`/@${HANDLE}/renew/`),
        invite: clubPage.includes(escaped(t.endedBody)),
      },
    };
  };

  part("The store on (control)");
  const on = await look();
  is("the guide: handed over, with its offer after paying, the affiliate link and the review form", on.guide, { delivered: true, offer: true, affiliate: true, review: true });
  is("from a funnel of pages: handed over, with the way on to its next step", on.funnel, { delivered: true, next: true });
  is("a membership that ended: said, with Renew and its invitation", on.ended, { said: true, renew: true, invite: true });

  part("The store switched off after a report");
  await noteTakedown(OWNER, null, true);
  const off = await look();
  is("the guide is still handed over; no offer, no affiliate link, no review form", off.guide, { delivered: true, offer: false, affiliate: false, review: false });
  is("from a funnel: still handed over; no next step", off.funnel, { delivered: true, next: false });
  is("a membership that ended: said, with no Renew and no invitation to it", off.ended, { said: true, renew: false, invite: false });

  part("Switched back on");
  await noteTakedown(OWNER, null, false);
  is("the same as before it was switched off", await look(), on);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
