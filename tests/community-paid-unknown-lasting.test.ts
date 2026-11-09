/**
 * A member whose purchases are more than one reading takes in (the pre-review of 9 November 2026, round 2).
 *
 *   N1  A loyal buyer: the ticket held, and eleven earlier checkouts each made with a customer of its own (Stripe
 *       makes one per checkout where tax numbers, invoices or offers after paying are on). The reading read ten
 *       customers at the most, so it was never whole: never kept, every page asked Stripe again, and the kept space
 *       said "reload the page" for good. Only a checkout that carried the offers after paying (metadata
 *       `upsell_key`, lib/store-checkout.ts and lib/cart-checkout.ts; lib/upsell.ts takes no offer without it) can
 *       have a one-click addition on its customer, so only those customers are read, and up to TICKET_CUSTOMERS
 *       of them, a short page each, a group at a time.
 *   N2  Past what is read, "not known" is for good (Holdings `lasting`): every door that says it (the kept space
 *       in the list, a space asked by its address, an event, a post's space, the RSVP and calendar routes, the
 *       search's matches) says to write to the creator, never to reload or try again in a minute, in every
 *       language, as the community's own gate already did.
 *   N3  A lasting "not known" is kept a minute, as a "no" is, so each page does not read Stripe again.
 *   N4  What a reading may read stays inside the requests a page pays for it (tests/plan-cost-registry.ts).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import CommunityPage from "@/app/[handle]/community/page";
import * as access from "@/lib/community-access";
import * as readRules from "@/lib/community-read-rules";
import { ACCESS_CHECK_READ } from "./plan-cost-registry";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import { lockedWords } from "@/lib/buyer-words/community-locked";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { mintPass, passCookieName } from "@/lib/learn";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { checkUnits } from "@/lib/community-read-rules";

const OWNER = "cpl-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);
const read = (file: string) => readFileSync(file, "utf8");

/** Checkouts by the address they were paid from, in Stripe's order (newest first). */
const sessions: Record<string, Record<string, unknown>[]> = {};
/** Payments by the customer they were made as, newest first. */
const intents: Record<string, Record<string, unknown>[]> = {};
let stripeReads = 0;
let customerReads = 0;
let paymentLimits: number[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "email_test_1" });
  stripeReads += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const page = (all: Record<string, unknown>[]) => {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  };
  if (path === "/checkout/sessions") return page(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  if (path === "/payment_intents") {
    customerReads += 1;
    paymentLimits.push(Number(url.searchParams.get("limit") ?? "10"));
    return page(intents[url.searchParams.get("customer") ?? ""] ?? []);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = { object: "charge", amount: 4900, amount_refunded: 0, refunded: false };
const paid = (n: number, product: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
  id: `cs_test_cpl${String(n).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400 - n,
  customer: null,
  metadata: { store: "paidlasting", product, ...meta },
  payment_intent: { id: `pi_cpl${n}`, object: "payment_intent", latest_charge: charge },
  ...extra,
});
const customerOf = (who: string, n: number) => `cus_${who}${String(n).padStart(6, "0")}`;
/** The addition one click after a checkout, on the checkout's customer (lib/upsell.ts). */
const addition = (n: number, product: string, parent: string) => ({
  id: `pi_cpladd${n}`,
  object: "payment_intent",
  status: "succeeded",
  metadata: { kind: "upsell", store: "paidlasting", product, parent },
  latest_charge: charge,
});

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_community_paid_lasting_only";
  process.env.RESEND_API_KEY = "re_test_community_paid_lasting_only";
  await claimHandle(OWNER, "paidlasting", "Paid Lasting", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaidLast01", true);
  await setSubscription(OWNER, { customerId: "cus_PaidLast0001", subscriptionId: "sub_PaidLast0001", active: true, period: paidPeriod() });
  const made = async (title: string, price: string) => {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
    return added.product.id;
  };
  const ticket = await made("Club pass", "49");
  const other = await made("Sticker pack", "5");
  const inner = await made("Inner notes", "19");
  await setCommunity(OWNER, true);
  let store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const kept = newItemId();
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    access: [ticket, inner],
    spaces: [
      { id: newItemId(), name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: kept, name: "Inner room", about: "For Inner notes buyers", creatorOnly: false, only: [inner], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  };
  await saveConfig(id, config);
  const fresh = async () => {
    store = (await storeForEmail(OWNER))!;
    return store;
  };
  const drawWith = async (email: string, sp: Record<string, string>) => {
    cookieValues.clear();
    cookieValues.set(passCookieName(await fresh()), await mintPass(store, email, "all"));
    try {
      const page = await CommunityPage({ params: Promise.resolve({ handle: "@paidlasting" }), searchParams: Promise.resolve(sp) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, page));
    } catch (error) {
      return `PAGE_FAILED ${String(error)}`;
    }
  };
  const html = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lw = lockedWords("en") as unknown as Record<string, string>;
  const en = COMMUNITY_WORDS.en as Record<string, any>;
  const rules = readRules as Record<string, unknown>;
  const cap = typeof rules.TICKET_CUSTOMERS === "number" ? (rules.TICKET_CUSTOMERS as number) : 0;

  part("N1 [ALTO] a loyal buyer (ticket held, eleven customers on the creator's account) is read whole and kept");
  // Eleven purchases of the sticker pack, each with a customer of its own (tax numbers on: no offers after paying),
  // and the club pass. The ticket is held; "Inner notes" is not.
  sessions["loyal@example.com"] = [paid(1, ticket), ...Array.from({ length: 11 }, (_, i) => paid(i + 2, other, { customer: customerOf("Loyal", i) }))];
  const h1 = await drawWith("loyal@example.com", {});
  const mid = stripeReads;
  const h2 = await drawWith("loyal@example.com", {});
  is("control: the page shows the Inner room line", h1.includes("Inner room"), true);
  is("a second page within the minute reads nothing from Stripe (the reading was whole, and kept)", stripeReads - mid, 0);
  is("the Inner room offers the product, never 'reload to try again' (the reading said no)", [h2.includes(html(lw.unchecked)), h2.includes(html(lockedWords("en").unlockWith("Inner notes")))], [false, true]);
  is("no customer of a checkout without offers is read (none can hold a one-click addition)", customerReads, 0);

  part("N1b a buyer with twelve checkouts that carried offers: the addition on the twelfth customer opens the space");
  // Each checkout with the offers after paying made its own customer (customer_creation "always"); the twelfth
  // took "Inner notes" in one click.
  sessions["offers@example.com"] = [
    paid(100, ticket),
    ...Array.from({ length: 12 }, (_, i) => paid(101 + i, other, { customer: customerOf("Offer", i) }, { upsell_key: `key${i}` })),
  ];
  for (let i = 0; i < 12; i += 1) intents[customerOf("Offer", i)] = i === 11 ? [addition(i, inner, `cs_test_cpl${String(101 + i).padStart(6, "0")}`)] : [];
  customerReads = 0;
  paymentLimits = [];
  const offers = await access.holdingsOf(await fresh(), config, "offers@example.com");
  is("the reading is whole and holds both products", [offers.whole, [...offers.held].sort()], [true, [ticket, inner].sort()]);
  is("each of the twelve customers was read once", customerReads, 12);
  is("a short page each (an offers customer holds its checkout and at most the funnel's additions)", paymentLimits.every((n) => n > 0 && n <= 10), true);
  // Rule 23: was cap >= 50; forty is what the sixteen requests a page pays cover with the groups of ten waited on one
  // after another (tests/plan-cost-registry.test.ts), and four times the ten before.
  is("the customers read are many more than ten", cap >= 40, true);

  part("N1c past TICKET_CUSTOMERS customers with offers: not known for good, never a 'no'");
  sessions["many@example.com"] = [
    paid(300, ticket),
    ...Array.from({ length: cap + 1 }, (_, i) => paid(301 + i, other, { customer: customerOf("Many", i) }, { upsell_key: `key${i}` })),
  ];
  const many = await access.holdingsOf(await fresh(), config, "many@example.com");
  is("control: the ticket is held", many.held.has(ticket), true);
  is("Inner notes is not known, for good", [many.whole, many.lasting, access.heldAnswer(many, [inner])], [false, true, "unknown"]);

  part("N2 [MEDIO] a lasting unknown says 'write to the creator' at every door, never 'reload' or 'a minute'");
  // The club pass on the newest checkout, then more checkouts than the pages read: in, with Inner notes not known.
  const pages = typeof rules.TICKET_SESSION_PAGES === "number" ? (rules.TICKET_SESSION_PAGES as number) : 1;
  sessions["lou@example.com"] = [paid(1000, ticket), ...Array.from({ length: pages * 100 + 5 }, (_, i) => paid(1001 + i, other))];
  const louHtml = await drawWith("lou@example.com", {});
  is("control: let in", louHtml.includes("Inner room") && !louHtml.includes("PAGE_FAILED"), true);
  is("the kept space never says to reload", louHtml.includes(html(lw.unchecked)), false);
  is("it says to write to the creator", typeof lw.uncheckedLasting === "string" && louHtml.includes(html(lw.uncheckedLasting)), true);
  const asked = await drawWith("lou@example.com", { space: kept });
  is("the space asked by its address says so for good", asked, "PAGE_FAILED Error: redirect:/@paidlasting/community?n=spaceunknownlasting");
  const checks = await access.spaceChecks(await fresh(), config, { owner: false, email: "lou@example.com" });
  is("spaceChecks carries `lasting`", [checks.unchecked.has(kept), (checks as Record<string, unknown>).lasting], [true, true]);
  const forGood = (access as Record<string, unknown>).unknownForGood as ((h: unknown) => boolean) | undefined;
  is("one rule for every door: unknownForGood", typeof forGood === "function" ? [forGood({ held: new Set(), whole: false, lasting: true }), forGood({ held: new Set(), whole: false, lasting: false }), forGood({ held: new Set(), whole: true, lasting: false })] : "missing", [true, false, false]);
  const sources: [string, RegExp][] = [
    ["app/[handle]/community/page.tsx", /spaceunknownlasting/],
    ["app/[handle]/community/post/[post]/page.tsx", /spaceunknownlasting/],
    ["app/api/store/community/route.ts", /spaceunknownlasting[\s\S]*spaceunknownlasting/],
    ["app/api/store/community/rsvp/route.ts", /eventunknownlasting/],
    ["app/api/store/community/calendar/route.ts", /eventUncheckedLasting/],
    // Rule 23: was /eventUncheckedLasting[\s\S]*eventUncheckedLasting/ (both places by name); the page picks the line once
    // and draws it in both places, so both places are held by the check below instead.
    ["app/[handle]/community/events/[event]/page.tsx", /eventUncheckedLasting/],
    ["app/[handle]/community/search/page.tsx", /uncheckedMoreLasting\(/],
    ["lib/community-found.ts", /lasting/],
    ["components/community-locked.tsx", /uncheckedLasting/],
  ];
  is("the event page draws the passing line nowhere on its own", /\{w\.eventUnchecked\}|\? w\.eventUnchecked :/.test(read("app/[handle]/community/events/[event]/page.tsx")), false);
  is("every door that says 'not known' tells a lasting one apart", sources.filter(([file, pattern]) => !pattern.test(read(file))).map(([file]) => file), []);
  const languages = Object.keys(COMMUNITY_WORDS) as (keyof typeof COMMUNITY_WORDS)[];
  const lasting = (l: string) => {
    const w = COMMUNITY_WORDS[l as keyof typeof COMMUNITY_WORDS] as Record<string, any>;
    const lk = lockedWords(l) as unknown as Record<string, string>;
    return [w.notices?.spaceunknownlasting, w.notices?.eventunknownlasting, w.eventUncheckedLasting, typeof w.uncheckedMoreLasting === "function" ? w.uncheckedMoreLasting(2) : undefined, lk.uncheckedLasting];
  };
  is("every language has the five lasting lines", languages.filter((l) => lasting(l).some((t) => typeof t !== "string" || !t)), []);
  is(
    "none of them is the line for a passing fault",
    languages.filter((l) => {
      const w = COMMUNITY_WORDS[l] as Record<string, any>;
      const lk = lockedWords(l) as unknown as Record<string, string>;
      const passing = [w.notices?.spaceunknown, w.notices?.eventunknown, w.eventUnchecked, w.uncheckedMore?.(2), lk.unchecked];
      return lasting(l).some((t, i) => t === passing[i]);
    }),
    [],
  );
  is("in English none says reload, a minute or a moment", lasting("en").filter((t) => /reload|minute|moment|try again/i.test(String(t))), []);
  is("each English one says to write to the creator", lasting("en").filter((t) => !/write to the creator/i.test(String(t))), []);
  is("German keeps 'Sie'", lasting("de").filter((t) => /\b(dein|deinen|du)\b/.test(String(t))), []);
  is("control: the English gate's lasting line is unchanged", typeof en.unknownLastingBody, "function");

  part("N3 [LEVE] a lasting unknown is kept a minute: the next page reads nothing from Stripe");
  const before = stripeReads;
  const again = await access.holdingsOf(await fresh(), config, "lou@example.com");
  is("still not known for good", [again.whole, again.lasting, again.held.has(ticket)], [false, true, true]);
  is("and Stripe was not asked again", stripeReads - before, 0);
  const [ttl] = (await redis.pipeline([["TTL", `nl:cm:${id}:h:${(await import("@/lib/learn")).emailKey("lou@example.com")}`]])) as [number];
  is("kept one minute at the most", ttl > 0 && ttl <= 60, true);

  part("N4 the reading stays inside what a page pays for it");
  is("a page's checks pay for the whole reading", checkUnits(1) * laterPageCost() >= ACCESS_CHECK_READ, true);
  done();
}

void main();
