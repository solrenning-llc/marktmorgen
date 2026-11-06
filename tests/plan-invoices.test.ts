/**
 * 601 [KB22] unit U5: the invoices of the creator's own Marktmorgen plan, read
 * from our platform Stripe account and shown in the studio (app/studio/invoices).
 *
 *   - only the store's own customer and its own plan subscription are asked
 *     for, and a row of any other customer or subscription is never shown;
 *   - a store with no plan subscription asks Stripe nothing and takes nothing
 *     from its studio figure: it says, in plain text, that there are none;
 *   - the page costs the studio's figure only what every page costs; one of
 *     the store's billing requests of the day (the counter countStudio keeps
 *     for "billing") is taken before Stripe is asked, and a refusal, or a
 *     count that could not be read, asks nothing;
 *   - Stripe's pages are linked only at Stripe's own https hosts;
 *   - an answer Stripe could not give, or gave in another shape, is said as
 *     "could not be read", never as "no invoices";
 *   - drafts are not invoices yet and are not shown.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { answering } from "./security/next-headers";
import { openSession, SESSION_COOKIE } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { STRIPE_LIST_VERSION } from "@/lib/stripe-list";
import {
  PLAN_INVOICES_SHOWN,
  PLAN_INVOICES_USED,
  planInvoicesOf,
  readPlanInvoicePage,
  type PlanInvoices,
} from "@/lib/plan-invoices";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import StudioInvoicesPage from "@/app/studio/invoices/page";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { countStudio } from "@/lib/studio-route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_plan_invoices_only";

const CUS = "cus_PlanInvoices01";
const SUB = "sub_PlanInvoices01";
const OWNER = { customer: CUS, subscription: SUB };

function invoice(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "in_PlanInvoice0001",
    object: "invoice",
    customer: CUS,
    parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: {} } },
    status: "paid",
    number: "ABCD1234-0001",
    created: 1_790_000_000,
    total: 6900,
    currency: "usd",
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_platform/test_one",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_platform/test_one/pdf",
    ...over,
  };
}

type Reply = { status: number; body: unknown };
let reply: Reply = { status: 200, body: { object: "list", data: [], has_more: false } };
const asked: { path: string; version: string | null }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") {
    const headers = new Headers(init?.headers);
    asked.push({ path: `${init?.method ?? "GET"} ${url.pathname}${url.search}`, version: headers.get("Stripe-Version") });
    if (url.pathname === "/v1/invoices") return new Response(JSON.stringify(reply.body), { status: reply.status });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const html = (read: PlanInvoices) => renderToStaticMarkup(createElement(PlanInvoicesList, { read }));

async function main() {
  part("The page Stripe gives is read in its exact shape, and only this store's rows count");
  {
    const read = readPlanInvoicePage(
      {
        object: "list",
        has_more: false,
        data: [
          invoice(),
          invoice({ id: "in_OtherCustomer01", customer: "cus_SomebodyElse1" }),
          invoice({ id: "in_OtherSubscr01", parent: { type: "subscription_details", subscription_details: { subscription: "sub_SomebodyElse1" } } }),
          invoice({ id: "in_NoParent00001", parent: null }),
          invoice({ id: "in_DraftOnly0001", status: "draft", number: null, hosted_invoice_url: null, invoice_pdf: null }),
          invoice({ id: "in_PlainHttp0001", hosted_invoice_url: "http://invoice.stripe.com/i/x", invoice_pdf: "https://evil.example/invoice.pdf" }),
          invoice({ id: "in_BadTotal00001", total: "6900" }),
          invoice({ id: "in_BadStatus0001", status: "settled" }),
          "not a row",
        ],
      },
      OWNER,
    );
    is("the store's own invoices are listed, drafts left out", read.invoices.map((i) => i.id), ["in_PlanInvoice0001", "in_PlainHttp0001"]);
    is("another customer's, another subscription's and garbled rows are counted as unreadable", read.unreadable, 6);
    is("a complete page", read.more, false);
    is("an invoice read in full", read.invoices[0], {
      id: "in_PlanInvoice0001",
      number: "ABCD1234-0001",
      created: 1_790_000_000,
      status: "paid",
      totalCents: 6900,
      currency: "usd",
      page: "https://invoice.stripe.com/i/acct_platform/test_one",
      pdf: "https://pay.stripe.com/invoice/acct_platform/test_one/pdf",
    });
    is("a page or file that is not at Stripe's own https host is not linked", [read.invoices[1].page, read.invoices[1].pdf], [null, null]);
    let threw = false;
    try {
      readPlanInvoicePage({ data: {}, has_more: false }, OWNER);
    } catch {
      threw = true;
    }
    is("a page in another shape throws, never reads as none", threw, true);
  }

  part("A store with no plan subscription asks nothing and takes nothing");
  {
    const taken: number[] = [];
    asked.length = 0;
    // Changed (rule 23): the take counts one billing request of the day, no longer studio units; still none taken.
    const read = await planInvoicesOf({ stripeCustomerId: null, subscriptionId: null, sid: "", handle: "x" }, async () => (taken.push(1), "within" as const));
    is("none", read, { state: "none" });
    is("Stripe is not asked and no request is taken", [asked.length, taken.length], [0, 0]);
    const text = html(read);
    is("it says so in plain text", text.includes("You have no invoices from Marktmorgen"), true);
    is("and nothing to click", text.includes("<a "), false);
  }

  part("The store's own plan, asked once, after its billing request of the day is taken");
  {
    const order: string[] = [];
    asked.length = 0;
    reply = { status: 200, body: { object: "list", data: [invoice()], has_more: false } };
    const read = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, async () => {
      order.push(`take with ${asked.length} asked`);
      return "within";
    });
    // Changed (rule 23): one billing request, not PLAN_INVOICES_UNITS studio requests; still taken before Stripe is asked.
    is("the request is taken before Stripe is asked", order, ["take with 0 asked"]);
    is("one request, for this customer and this subscription only", asked.map((a) => a.path), [
      `GET /v1/invoices?${new URLSearchParams({ customer: CUS, subscription: SUB, limit: String(PLAN_INVOICES_SHOWN) })}`,
    ]);
    is("at the pinned list version", asked[0]?.version, STRIPE_LIST_VERSION);
    is("listed", read.state === "listed" && read.invoices.length, 1);
    const text = html(read);
    is("the amount and the number are shown", [text.includes("$69"), text.includes("ABCD1234-0001")], [true, true]);
    is("Stripe's page is linked with its purpose in the link", text.includes('href="https://invoice.stripe.com/i/acct_platform/test_one"') && text.includes("View invoice ABCD1234-0001 on Stripe"), true);
    is("its PDF too", text.includes('href="https://pay.stripe.com/invoice/acct_platform/test_one/pdf"') && text.includes("Download invoice ABCD1234-0001 as a PDF"), true);
    is("the date is said in UTC", text.includes("UTC"), true);
  }

  part("A refused request asks nothing");
  {
    asked.length = 0;
    // Changed (rule 23): the refusal is the day's billing requests used, said in PLAN_INVOICES_USED; still nothing asked.
    const read = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, async () => "exceeded");
    is("said as used", read, { state: "used", message: PLAN_INVOICES_USED });
    is("Stripe is not asked", asked.length, 0);
    is("the message is shown, never 'no invoices'", [html(read).includes(`its ${ESSENTIAL_PER_DAY} billing requests for today`), html(read).includes("no invoices")], [true, false]);
    const unknown = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, async () => "unknown");
    is("a count that could not be read asks nothing and is never said as too many", [unknown, asked.length, html(unknown).includes("today")], [{ state: "unknown" }, 0, false]);
    const thrown = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, async () => { throw new Error("redis down"); });
    is("a count that threw asks nothing", [thrown, asked.length], [{ state: "unknown" }, 0]);
  }

  part("What Stripe could not answer is never said as no invoices");
  {
    const take = async () => "within" as const;
    for (const [label, r] of [
      ["Stripe failed", { status: 500, body: { error: { message: "down" } } }],
      ["a page in another shape", { status: 200, body: { data: "nothing", has_more: false } }],
      ["a page without has_more", { status: 200, body: { data: [] } }],
    ] as [string, Reply][]) {
      reply = r;
      const read = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
      is(`${label}: unknown`, read, { state: "unknown" });
      const text = html(read);
      is(`${label}: says it could not be read`, [text.includes("could not be read"), text.includes("no invoices")], [true, false]);
    }
    reply = { status: 200, body: { data: [invoice({ customer: "cus_SomebodyElse1" })], has_more: false } };
    const foreign = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
    is("only another customer's row: nothing shown and not said as none", [foreign.state === "listed" && foreign.invoices.length, html(foreign).includes("no invoices"), html(foreign).includes("could not be read")], [0, false, true]);
    reply = { status: 200, body: { data: [], has_more: false } };
    const empty = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
    is("a complete, empty page: none yet, in plain text", [html(empty).includes("no invoices"), html(empty).includes("<a ")], [true, false]);
    reply = { status: 200, body: { data: Array.from({ length: PLAN_INVOICES_SHOWN }, (_, n) => invoice({ id: `in_Many${String(n).padStart(8, "0")}` })), has_more: true } };
    const many = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
    is("more than a page: says only the latest are shown", html(many).includes(`your ${PLAN_INVOICES_SHOWN} most recent invoices`), true);
    is("a malformed id is never sent to Stripe", [await planInvoicesOf({ stripeCustomerId: "cus_x/../charges", subscriptionId: SUB, sid: "", handle: "x" }, take), asked.some((a) => a.path.includes("charges"))], [{ state: "none" }, false]);
  }

  part("The studio page, for the store whose studio is open");
  {
    redis.clear();
    const email = "plan-invoices@example.test";
    await claimHandle(email, "planinvoices", "Synthetic shop", "");
    await ensureStatsId(email);
    await ensureStoreId(email);
    let store = (await storeForEmail(email))!;
    const cookie = `${SESSION_COOKIE}=${await openSession(email)}`;
    answering(new NextRequest("https://marktmorgen.com/studio/invoices", { headers: { cookie } }));
    asked.length = 0;
    const none = renderToStaticMarkup((await StudioInvoicesPage({ searchParams: Promise.resolve({ store: store.sid }) })) as React.ReactElement);
    is("no plan: plain text, Stripe not asked", [none.includes("You have no invoices from Marktmorgen"), asked.length], [true, 0]);
    is("one heading for the page", (none.match(/<h1/g) ?? []).length, 1);

    await setSubscription(email, { customerId: CUS, subscriptionId: SUB, active: true, tier: "creator", period: paidPeriod() });
    store = (await storeForEmail(email))!;
    reply = { status: 200, body: { data: [invoice()], has_more: false } };
    asked.length = 0;
    const shown = renderToStaticMarkup((await StudioInvoicesPage({ searchParams: Promise.resolve({ store: store.sid }) })) as React.ReactElement);
    is("its plan's invoice is shown", shown.includes("ABCD1234-0001"), true);
    is("asked for its own customer and subscription", asked.filter((a) => a.path.startsWith("GET /v1/invoices")).map((a) => a.path), [
      `GET /v1/invoices?${new URLSearchParams({ customer: CUS, subscription: SUB, limit: String(PLAN_INVOICES_SHOWN) })}`,
    ]);
    // Changed (rule 23): the page says the read takes one of the day's billing requests, not studio units.
    is("the page says what reading them counts", shown.includes(`one of the ${ESSENTIAL_PER_DAY} billing requests your store has each day`), true);

    // The same counter as cancelling or changing the plan: past it, the page asks Stripe nothing and says why.
    for (let n = 1; n < ESSENTIAL_PER_DAY; n += 1) await countStudio(store, "billing");
    asked.length = 0;
    const used = renderToStaticMarkup((await StudioInvoicesPage({ searchParams: Promise.resolve({ store: store.sid }) })) as React.ReactElement);
    is("past the day's billing requests: said, and Stripe not asked for invoices", [used.includes("billing requests for today"), asked.filter((a) => a.path.startsWith("GET /v1/invoices")).length], [true, 0]);
    is("and cancelling the plan is refused the same day, by the same counter", (await countStudio(store, "billing")).ok, false);
  }

  part("The studio links the page only for a store with a plan subscription");
  {
    const studio = readFileSync("app/studio/page.tsx", "utf8");
    is("one link from the plan card", studio.split('studioPath(store, "", "invoices")').length - 1, 1);
    is("shown only with a plan subscription", /store\.subscriptionId && store\.stripeCustomerId \? \(\s*<p[^>]*>\s*<Link href=\{studioPath\(store, "", "invoices"\)\}/.test(studio), true);
  }

  done();
}

void main();
