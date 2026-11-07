/**
 * 426 [BX2] unit 3: the studio page "Earnings by month" (app/studio/earnings/page.tsx;
 * docs/bx2-earnings-design.md, "Units", 4).
 *
 * The real page is drawn with the real year reading (lib/earnings-read.ts),
 * the real kept copy and the real count of the day's readings, against a
 * stand-in Stripe (fetch) and the in-memory Redis. Only who is signed in and
 * the Next request context are stand-ins (tests/bx2-u3-page-world.tsx).
 *
 * What fails here:
 *   - a month or a source that could not be read shown as an amount or as $0
 *     instead of "Could not be read";
 *   - amounts in two currencies added together;
 *   - a best month, growth, projection, rank or status by revenue (561 [NE1]),
 *     or the page without the sentence that Marktmorgen promises no earnings;
 *   - "Entered by you" shown before it exists (VR: nothing that does not work);
 *   - a month shown without saying, from the reading itself, what it leaves out
 *     (Stripe disputes and money given back, PayPal disputes) or reads only in
 *     part (PayPal refunds of part of a sale), or saying disputes are counted
 *     where they are not read (the rule's contract of #2941);
 *   - money given back (reinstatedCents) left out of money in;
 *   - a page view taking more than one of the day's two heavy readings, or one
 *     at all when the kept copy is fresh or the store sells through neither;
 *   - the day's readings used and the page pretending to have numbers, or not
 *     showing the kept copy with the time it was read;
 *   - a table without a caption, column headers and row headers;
 *   - the page not asking for the "stats" permission, or no way to it from the studio.
 */
process.env.STRIPE_SECRET_KEY = "sk_test_earnings_page_stand_in";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import EarningsPage from "../app/studio/earnings/page";
import { READING_FRESH_SECONDS, readingsLeft, takeStoreReading } from "@/lib/store-readings";
import { earningsByMonth, readingSince } from "@/lib/earnings-by-month";
import type { Store } from "@/lib/store";
import { who } from "./bx2-u3-page-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.UTC(2031, 5, 15, 12, 0); // 15 June 2031, 12:00 UTC
let clock = NOW;
Date.now = () => clock;
const sec = (ms: number) => Math.floor(ms / 1000);

type Row = Record<string, unknown> & { id: string; created: number };
type ListPath = "/checkout/sessions" | "/payment_intents" | "/invoices" | "/refunds" | "/disputes";
let stripe: Record<ListPath, Row[]>;
let failing = false;
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "") as ListPath;
  stripeCalls += 1;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (failing) return json({ error: { type: "api_error", message: "stand-in failure" } }, 500);
  const gte = Number(url.searchParams.get("created[gte]") ?? 0);
  const after = url.searchParams.get("starting_after");
  const limit = Number(url.searchParams.get("limit") ?? 10);
  const rows = (stripe[path] ?? []).filter((r) => r.created >= gte).sort((a, b) => b.created - a.created);
  const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
  return json({ object: "list", data: rows.slice(start, start + limit), has_more: start + limit < rows.length });
}) as typeof fetch;

const checkout = (id: string, at: number, cents: number, currency = "usd"): Row => ({
  id: `cs_${id}`, object: "checkout.session", created: sec(at), status: "complete", payment_status: "paid", amount_total: cents, currency, metadata: { store: "shop", product: "p1" },
});
const refund = (id: string, at: number, cents: number): Row => ({
  id: `re_${id}`, object: "refund", created: sec(at), status: "succeeded", amount: cents, currency: "usd", payment_intent: "pi_x",
});

let count = 0;
function makeStore(stripeAccount: boolean, paypal: boolean): Store {
  count += 1;
  return {
    sid: `pg${count}`,
    statsId: String(count).padStart(32, "e"),
    handle: "shop",
    previousHandles: [],
    releasedHandles: [],
    stripeAccountId: stripeAccount ? "acct_1EarningsPageStandIn" : null,
    paypalSeller: paypal ? "SELLERSTANDIN02" : null,
    currency: "usd",
  } as unknown as Store;
}
async function paypalSale(shop: Store, order: string, at: number, cents: number): Promise<void> {
  const paid = { store: shop.statsId, order, capture: `CAP${order}`.slice(0, 30), email: "buyer@example.com", product: "p1", cents, currency: "usd", at: sec(at) };
  await redis.pipeline([["SET", `nl:ppsell:paid:${order}`, JSON.stringify(paid)], ["ZADD", `nl:ppsell:sales:${shop.statsId}`, String(sec(at)), order]]);
}

function reset(): void {
  redis.clear();
  stripe = { "/checkout/sessions": [], "/payment_intents": [], "/invoices": [], "/refunds": [], "/disputes": [] };
  failing = false;
  stripeCalls = 0;
  clock = NOW;
  who.allowed = true;
  who.needs = [];
}

async function draw(shop: Store): Promise<string> {
  who.store = shop;
  return renderToStaticMarkup(await EarningsPage({ searchParams: Promise.resolve({ store: shop.sid }) }));
}
/** The words a person reads: tags removed, entities decoded. */
const words = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const times = (text: string, part: string) => text.split(part).length - 1;
/** An amount as lib/money.ts writes it ("$65", round amounts without ".00"), and no longer amount that starts the same. */
const shows = (text: string, money: string) => new RegExp(money.replace(/[$.]/g, "\\$&") + "(?![\\d,]|\\.\\d)").test(text);
const ZERO = /[$€]0(?![\d,]|\.\d)|[$€]0\.00/;

/** The html of one month's section, from its heading to the next month's. */
const section = (html: string, month: string) => {
  const start = html.indexOf(`aria-labelledby="month-${month}"`);
  const end = html.indexOf("aria-labelledby=\"month-", start + 1);
  return start < 0 ? "" : html.slice(start, end < 0 ? undefined : end);
};

/** What NE1 forbids: ranking, rating or projecting the creator by revenue. */
const NE1_FORBIDDEN = /best month|worst month|growth|\bgrew\b|growing|projection|projected|forecast|on track|record month|\brank|badge|\blevel\b|top seller|\bincrease|\bdecrease|[+-]\d+(\.\d+)?%|\bstatus\b/i;
const NE1_SENTENCE = "Marktmorgen is software for selling your own work. We make no promise that using it will bring you sales, income or any result. What you earn depends on your products, your audience and your work.";

async function main(): Promise<void> {
  part("A store with Stripe and PayPal: twelve months, by source and by currency");
  reset();
  {
    const shop = makeStore(true, true);
    stripe["/checkout/sessions"] = [checkout("a0001", Date.UTC(2031, 5, 3), 7000), checkout("b0001", Date.UTC(2031, 5, 4), 3000, "eur"), checkout("c0001", Date.UTC(2031, 3, 9), 1200)];
    stripe["/refunds"] = [refund("a0001", Date.UTC(2031, 5, 5), 500)];
    await paypalSale(shop, "PAYPALORDERPG01", Date.UTC(2031, 5, 7), 4000);
    const before = await readingsLeft(shop, NOW);
    const html = await draw(shop);
    const text = words(html);
    const after = await readingsLeft(shop, NOW);
    is("the page asks for the permission to see the numbers", who.needs, ["stats"]);
    is("one page view takes exactly one of the day's heavy readings", [before.heavyLeft, after.heavyLeft], [2, 1]);
    is("titled Earnings by month", /<h1[^>]*>Earnings by month<\/h1>/.test(html), true);
    is("twelve months, the current one marked so far, the oldest July 2030", [text.includes("June 2031, so far"), text.includes("July 2030"), text.includes("June 2030")], [true, true, false]);
    is("Stripe in dollars in June: sales $70, refunds $5, left $65", [shows(text, "$70"), shows(text, "$5"), shows(text, "$65")], [true, true, true]);
    is("euros on their own line, never added to dollars ($70 + €30 is never shown as 100)", [shows(text, "€30"), /[$€]100(?![\d,]|\.\d)/.test(text)], [true, false]);
    is("each currency named on its own row header", /<th scope="row"[^>]*>[^<]*Stripe[^<]*US dollars/.test(html) && /<th scope="row"[^>]*>[^<]*Stripe[^<]*euros/i.test(html), true);
    is("PayPal in June: $40.00 on its own row", /<th scope="row"[^>]*>[^<]*PayPal[^<]*US dollars/.test(html) && shows(text, "$40"), true);
    is("June's dollars from every source together, within one currency only: $105", shows(text, "$105"), true);
    // Rule 23: was text.includes("PayPal disputes are not read"), one sentence typed for PayPal only. Under the rule's
    // contract of #2941 each month says, from its own leftOut and partly, what its amounts do not hold.
    const june = words(section(html, "2031-06"));
    is("June says, in the rule's own words (netWords), that Stripe and PayPal disputes are not taken off", june.includes("After refunds, before disputes: Stripe and PayPal disputes are not read, so they are not taken off."), true);
    is("that Stripe's money given back is not added", june.includes("Money given back by Stripe is not read, so it is not added."), true);
    is("and that partial PayPal refunds are not taken off (PayPal records only full refunds)", june.includes("Partial PayPal refunds are not recorded, so they are not taken off."), true);
    is("every month's table is described by its own note of what its difference is after", (html.match(/<table[^>]*aria-describedby="(month-[\d-]+-notes)"/g) ?? []).length === 12 && [...html.matchAll(/aria-describedby="(month-[\d-]+-notes)"/g)].every((m) => html.includes(`id="${m[1]}"`)), true);
    is("the page never says disputes are counted when no dispute is read, in a sentence or in a column's name", [/A dispute counts when/.test(text), /Left after refunds and disputes/.test(text)], [false, false]);
    is("the columns are named in plain words and explained once: money in, money out, left", [/<th scope="col"[^>]*>Money in<\/th>/.test(html), /<th scope="col"[^>]*>Money out<\/th>/.test(html), /<th scope="col"[^>]*>Left<\/th>/.test(html), /Money in:/.test(text), /Money out:/.test(text)], [true, true, true, true, true]);
    is("a month read in full with nothing in it says so", text.includes("Nothing recorded"), true);
    // Rule 23: was text.includes("Could not be read") (the oldest month's Stripe renewals taken as not proved, a sentence
    // the page's own explanation also matched). Every paid invoice is now read from the account's first (Claude 3 on
    // #3022, MEDIUM 2): the oldest month is read, and the page no longer says it cannot be.
    is("the oldest month, July 2030, is read for Stripe: Nothing recorded, never Could not be read", [words(section(html, "2030-07")).includes("Stripe Nothing recorded"), words(section(html, "2030-07")).includes("Could not be read")], [true, false]);
    is("the page no longer says the oldest month can be unknown for Stripe because of renewals", /oldest month can say it/.test(text), false);
    is("it says why a Stripe month can be unknown: more paid invoices than one reading covers", /more paid invoices than one reading covers/.test(text), true);
    is("no amount of zero anywhere: an empty month is words, an unknown one is words", ZERO.test(text), false);
    is("nothing typed by the creator is shown: Entered by you does not exist yet", /entered by you/i.test(text), false);
    is("before fees and taxes, and not profit", [/before .*fees/i.test(text), /not profit/i.test(text)], [true, true]);
    is("currencies are never added together, said in words", /never added together/i.test(text), true);
    is("months are counted in UTC, said in words", /Coordinated Universal Time/.test(text), true);
    is("the NE1 sentence, word for word", text.includes(NE1_SENTENCE), true);
    is("no best month, growth, projection, rank or status (561 [NE1])", NE1_FORBIDDEN.exec(text)?.[0] ?? null, null);
    is("the page says opening it uses one of today's two sales readings", /uses one of today's two sales readings/.test(text), true);
    is("every month's table has a caption", times(html, "<caption") >= 12, true);
    is("column headers and row headers", [times(html, '<th scope="col"') >= 12 * 3, times(html, '<th scope="row"') >= 12], [true, true]);
    is("the table can scroll on its own at 320 px rather than the page", html.includes("overflow-x-auto"), true);

    part("Looking again within ten minutes reads nothing and takes no reading");
    const calls = stripeCalls;
    clock = NOW + (READING_FRESH_SECONDS - 60) * 1000;
    const again = words(await draw(shop));
    is("no Stripe page read, still one heavy reading left", [stripeCalls - calls, (await readingsLeft(shop, NOW)).heavyLeft], [0, 1]);
    is("the same months shown", shows(again, "$65"), true);

    part("The day's readings used: the kept copy, with the time it was read");
    clock = NOW + 2 * 3600_000;
    await takeStoreReading(shop, clock, true);
    const used = words(await draw(shop));
    is("no Stripe page read", stripeCalls - calls, 0);
    is("the kept months, said as read at 12:00 UTC", [shows(used, "$65"), used.includes("12:00 UTC")], [true, true]);
    is("and when the readings come back", /used/i.test(used) && used.includes("00:00 UTC"), true);
  }

  part("Money given back is money in, and a month that leaves nothing out says nothing is left out");
  reset();
  {
    const shop = makeStore(true, false);
    const since = readingSince(NOW, "UTC");
    const list = (kind: "sale" | "renewal" | "refund" | "dispute" | "reinstated", cents: number[]) => ({ kind, since, complete: true, reachedBack: null, events: cents.map((c, i) => ({ id: `stripe:${kind}${i}`, at: Date.UTC(2031, 5, 3 + i), cents: c, currency: "usd" })) });
    // A copy of the months kept a minute ago, as a reading that read Stripe's disputes and money given back would keep it.
    const value = earningsByMonth({ at: NOW, timeZone: "UTC", manual: [], providers: [{ source: "stripe", notRead: [], lists: [list("sale", [5000]), list("renewal", []), list("refund", [300]), list("dispute", [1000]), list("reinstated", [700])] }] });
    redis.run(["SET", `nl:reading:earnings:${shop.statsId}`, JSON.stringify({ at: NOW - 60_000, value }), "EX", 86_400]);
    const html = await draw(shop);
    const june = words(section(html, "2031-06"));
    is("no Stripe page read: the kept copy is fresh", stripeCalls, 0);
    is("money in: the $50 sale and the $7 given back, $57; money out: the $3 refund and the $10 dispute, $13; left $44", [shows(june, "$57"), shows(june, "$13"), shows(june, "$44")], [true, true, true]);
    is("nothing left out that month: its difference is after refunds and disputes, and nothing is said not read", [june.includes("After refunds and disputes."), /not read|not recorded/.test(june)], [true, false]);
  }

  part("The day's readings used and nothing kept: said, never as $0 or empty months");
  reset();
  {
    const shop = makeStore(true, false);
    await takeStoreReading(shop, NOW, true);
    await takeStoreReading(shop, NOW, true);
    const text = words(await draw(shop));
    is("no Stripe page read", stripeCalls, 0);
    is("says the readings are used and when they come back", [/today's two sales readings are used/i.test(text), text.includes("00:00 UTC")], [true, true]);
    is("no month, no amount", [text.includes("Nothing recorded"), /[$€]\d/.test(text), text.includes("<caption")], [false, false, false]);
  }

  part("Stripe could not be read: every Stripe month says so, with no amount");
  reset();
  {
    const shop = makeStore(true, true);
    failing = true;
    await paypalSale(shop, "PAYPALORDERPG02", Date.UTC(2031, 5, 7), 4000);
    const text = words(await draw(shop));
    is("twelve Stripe months say Could not be read", times(text, "Could not be read") >= 12, true);
    is("PayPal still shown on its own line", shows(text, "$40"), true);
    is("no total for a month with a source not read: $40 is never called the month's whole", /All sources[^$€]*\$40(?![\d,]|\.\d)/.test(text), false);
    is("no $0", ZERO.test(text), false);
  }

  part("A store selling through neither: nothing is read and no reading is taken");
  reset();
  {
    const shop = makeStore(false, false);
    const text = words(await draw(shop));
    is("no reading taken, no Stripe page read", [(await readingsLeft(shop, NOW)).heavyLeft, stripeCalls], [2, 0]);
    is("says there is nothing to read yet, with no months", [/Stripe or PayPal/.test(text), text.includes("Nothing recorded"), /[$€]\d/.test(text)], [true, false, false]);
  }

  part("A role that may not see the numbers is sent away");
  reset();
  {
    const shop = makeStore(true, false);
    who.allowed = false;
    let where = "";
    try {
      await draw(shop);
    } catch (error) {
      where = String((error as Error).message);
    }
    is("redirected with team=forbidden, nothing read", [where.startsWith("redirect:") && where.includes("team=forbidden"), stripeCalls], [true, 0]);
  }

  part("A way to the page from the studio's numbers");
  const home = readFileSync(join(process.cwd(), "app/studio/page.tsx"), "utf8");
  is("the studio home lists Earnings by month for whoever may see the numbers, when the store sells", /may\("stats"\) && readsSales\(store\)\s*\?\s*\[\{ href: studioPath\(store, "", "earnings"\), title: "Earnings by month"/.test(home), true);
  done();
}

void main();
