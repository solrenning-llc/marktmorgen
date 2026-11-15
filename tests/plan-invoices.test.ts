/**
 * 601 [KB22] unit U5: the invoices of the creator's own Marktmorgen plan, read
 * from our platform Stripe account and shown in the studio (app/studio/invoices).
 *
 *   - only the store's own customer and its own plan subscription are asked
 *     for, and a row of any other customer or subscription is never shown;
 *   - a store with no plan subscription asks Stripe nothing and takes nothing
 *     from its studio figure: it says, in plain text, that there are none;
 *   - the page costs the studio's figure only what every page costs; one of
 *     the store's essential requests of the day (the counter countStudio
 *     keeps for leaving and paying) is taken before Stripe is asked, only
 *     while fewer than PLAN_INVOICES_PER_DAY were taken, in one script on
 *     the same key, so the rest always stays whatever came first; a refusal,
 *     or a count that could not be read, asks nothing;
 *   - a store named twice or in another shape, or one the person can no
 *     longer open, never shows another store's invoices;
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
  PLAN_INVOICES_PER_DAY,
  PLAN_INVOICES_SHOWN,
  PLAN_INVOICES_USED,
  takeInvoicesRead,
  planInvoicesOf,
  readPlanInvoicePage,
  type PlanInvoices,
} from "@/lib/plan-invoices";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import StudioInvoicesPage from "@/app/studio/invoices/page";
import { ESSENTIAL_PER_DAY } from "@/lib/studio-allowance-rules";
import { countStudio, takeEssential } from "@/lib/studio-route";
import { essentialTakeBelow } from "@/lib/request-guard";
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
    // Changed (rule 23, #2990 Claude 2's MEDIUM 1): what was paid and is owed are read with the total, as Stripe gives them.
    amount_due: 6900,
    amount_paid: 6900,
    amount_remaining: 0,
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
      paidCents: 6900,
      remainingCents: 0,
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
    // Changed (rule 23, review 2): without asking Stripe it never says "no invoices", only that there is no plan subscription now.
    is("it says so in plain text, never as no invoices", [text.includes("This store has no plan subscription now"), text.includes("no invoices")], [true, false]);
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
    // Changed (rule 23): the refusal names both counters and their 24 hours (review 1), no longer "until tomorrow (UTC)".
    // Changed (rule 23, review 2): one counter now, said with what it is for.
    is("the message is shown, never 'no invoices'", [html(read).includes(`only while fewer than ${PLAN_INVOICES_PER_DAY} of the ${ESSENTIAL_PER_DAY} requests`), html(read).includes("team changes"), html(read).includes("no invoices"), html(read).includes("UTC")], [true, true, false, false]);
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
    reply = { status: 200, body: { data: [], has_more: true } };
    is("an empty page that says more follow is unknown, in the library itself (review 2)", await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take), { state: "unknown" });
    reply = { status: 200, body: { data: [], has_more: false } };
    const empty = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
    is("a complete, empty page: none yet, in plain text", [html(empty).includes("no invoices"), html(empty).includes("<a ")], [true, false]);
    reply = { status: 200, body: { data: Array.from({ length: PLAN_INVOICES_SHOWN }, (_, n) => invoice({ id: `in_Many${String(n).padStart(8, "0")}` })), has_more: true } };
    const many = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
    // Changed (rule 23): drafts may be among the 24, so the page no longer says it shows exactly 24 (review 1).
    is("more than a page: says only the latest are shown", html(many).includes(`from the last ${PLAN_INVOICES_SHOWN} Stripe made`), true);
    reply = { status: 200, body: { data: [invoice({ status: "draft", number: null, hosted_invoice_url: null, invoice_pdf: null })], has_more: true } };
    const drafts = await planInvoicesOf({ stripeCustomerId: CUS, subscriptionId: SUB, sid: "", handle: "x" }, take);
    is("a page of drafts with more after it: said as drafts, never as unreadable or as none", [drafts.state === "listed" && drafts.drafts, html(drafts).includes("still drafts"), html(drafts).includes("could not be read"), html(drafts).includes("no invoices")], [1, true, false, false]);
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
    // Changed (rule 23, review 2): the words for no plan subscription.
    is("no plan: plain text, Stripe not asked", [none.includes("This store has no plan subscription now"), asked.length], [true, 0]);
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
    // Changed (rule 23): the page says how many reads a day and that canceling keeps the rest (review 1).
    // Changed (rule 23, review 2): one counter, read only below its reserve.
    is("the page says what reading them counts", shown.includes(`only while fewer than ${PLAN_INVOICES_PER_DAY} of them have been used`) && shown.includes("canceling your plan always keeps the rest"), true);

    // Changed (rule 23, review 1): invoices may use at most PLAN_INVOICES_PER_DAY of the essential requests, never all of them,
    // so canceling the plan is never shut out by reading invoices.
    is("the invoices' reads are at most half of the essential figure", PLAN_INVOICES_PER_DAY * 2 <= ESSENTIAL_PER_DAY, true);
    for (let n = 1; n < PLAN_INVOICES_PER_DAY; n += 1) await StudioInvoicesPage({ searchParams: Promise.resolve({ store: store.sid }) });
    asked.length = 0;
    const used = renderToStaticMarkup((await StudioInvoicesPage({ searchParams: Promise.resolve({ store: store.sid }) })) as React.ReactElement);
    // Changed (rule 23, review 2): the refusal's words.
    is("past its reads: said, and Stripe not asked for invoices", [used.includes(`only while fewer than ${PLAN_INVOICES_PER_DAY}`), asked.filter((a) => a.path.startsWith("GET /v1/invoices")).length], [true, 0]);
    let left = 0;
    while ((await countStudio(store, "billing")).ok) left += 1;
    is("canceling or changing the plan still has the rest of the day's figure", left, ESSENTIAL_PER_DAY - PLAN_INVOICES_PER_DAY);

    // The essential figure used by leaving or paying first: no read is taken from it, and Stripe is not asked.
    const other = { sid: "s_PlanInvoicesOther", handle: "planinvoicesother" };
    for (let n = 0; n < ESSENTIAL_PER_DAY; n += 1) await takeEssential(other);
    is("an essential figure already used refuses the read", await takeInvoicesRead(other), "exceeded");

    // Review 2: the reserve holds whatever came first, on the one key. Team changes or plan steps first, then reads:
    const mixed = { sid: "s_PlanInvoicesMixed", handle: "planinvoicesmixed" };
    for (let n = 0; n < 3; n += 1) is(`essential request ${n + 1} first`, await takeEssential(mixed), "within");
    is("a read while fewer than the reserve's line were taken", [await takeInvoicesRead(mixed), await takeInvoicesRead(mixed)], ["within", "within"]);
    is("then refused, and the refusal takes nothing", [await takeInvoicesRead(mixed), await takeInvoicesRead(mixed)], ["exceeded", "exceeded"]);
    let kept = 0;
    while ((await takeEssential(mixed)) === "within") kept += 1;
    is("leaving or paying keeps exactly the rest", kept, ESSENTIAL_PER_DAY - PLAN_INVOICES_PER_DAY);
    is("a ceiling that is not a positive whole number is unknown, and nothing is taken", [await essentialTakeBelow("studio-essential", "x", 0, 86_400), await essentialTakeBelow("studio-essential", "x", 1.5, 86_400), await essentialTakeBelow("studio-essential", "x", 3, 0)], ["unknown", "unknown", "unknown"]);

    // Review 1: a store named twice or in another shape, or one no longer open, never falls back to another store.
    const redirected = async (store: unknown) => {
      try {
        await StudioInvoicesPage({ searchParams: Promise.resolve({ store } as { store: string }) });
        return "drawn";
      } catch (error) {
        return String((error as { digest?: unknown }).digest ?? error);
      }
    };
    asked.length = 0;
    is("a store named twice is sent to the studio", (await redirected([store.sid, store.sid])).includes(";/studio;"), true);
    is("a store in another shape is sent to the studio", (await redirected("s_../../x")).includes(";/studio;"), true);
    const gone = await redirected("0123456789abcdef0123456789abcdef");
    is("a store that cannot be opened draws no other store's invoices: sent to the studio of the one that opened", [gone.startsWith("NEXT_REDIRECT"), gone.includes(`/studio?store=${store.sid};`)], [true, true]);
    is("and Stripe is not asked for any of them", asked.filter((a) => a.path.startsWith("GET /v1/invoices")).length, 0);
  }

  part("The studio links the page only for a store with a plan subscription");
  {
    const studio = readFileSync("app/studio/page.tsx", "utf8");
    is("one link from the plan card", studio.split('studioPath(store, "", "invoices")').length - 1, 1);
    // Changed (rule 23, review 1): the link is never prefetched, so drawing the plan card reads nothing.
    is("shown only with a plan subscription, never prefetched", /store\.subscriptionId && store\.stripeCustomerId \? \(\s*<p[^>]*>\s*<Link href=\{studioPath\(store, "", "invoices"\)\} prefetch=\{false\}/.test(studio), true);
  }

  done();
}

void main();
