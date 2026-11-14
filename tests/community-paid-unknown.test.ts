/**
 * A paying member at a community's door when Stripe's answer is not known
 * (CX-123 rule 24; the paid-access audit, A3, 9 November 2026).
 *
 * Before: `ticketFor` turned a failed Stripe read into "no", and `paidForAny`
 * read one page of a hundred checkouts, so a ticket past it was "no" on every
 * request, for good; `communityViewer` then drew "<address> has nothing from
 * <store> that opens this community" to somebody who paid. Checked here, with
 * the code itself, the in-memory database and a stand-in for the creator's
 * Stripe account that pages its lists as Stripe does:
 *
 *   - the checkouts are read page after page (starting_after), up to
 *     TICKET_SESSION_PAGES, each page read in its exact shape
 *     (lib/stripe-list.ts); a ticket on a later page opens the door, and
 *     only a list read to its end says "no";
 *   - past the pages read, a row that does not read, or Stripe down: not
 *     known, never "no": the member sees that it could not be checked just
 *     now (words in every language, none saying they have nothing), with a
 *     way to check again, and is neither let in nor told to buy; the answer
 *     is not kept, so the next page asks again;
 *   - "Send me the link" for such an address says to try again, never a
 *     quiet "sent" with nothing sent;
 *   - a kept space a member's answer was not known for says so, never
 *     "Unlock with <product>" to somebody who may hold it;
 *   - the strict doors (Discord, letters, community emails) still throw, and
 *     past the pages read they are told asking again will not tell;
 *   - a check's worst Stripe reads are counted in the registry and its units.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import CommunityPage from "@/app/[handle]/community/page";
import * as access from "@/lib/community-access";
import * as readRules from "@/lib/community-read-rules";
import * as registry from "./plan-cost-registry";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import * as lockedWordsModule from "@/lib/buyer-words/community-locked";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { mintPass, passCookieName } from "@/lib/learn";
import { laterPageCost } from "./traffic-cost";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "cpu-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);
const read = (file: string) => readFileSync(file, "utf8");

/** Checkouts by the address they were paid from, in Stripe's order (newest first). */
const sessions: Record<string, Record<string, unknown>[]> = {};
let stripeDown = false;
/** A row Stripe sends that is not a checkout as it lists them, put first on every page when set. */
let garbledRow = false;
let stripeReads = 0;
let resendCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) {
    resendCalls += 1;
    return answer({ id: "email_test_1" });
  }
  stripeReads += 1;
  if (stripeDown) return answer({ error: { message: "synthetic outage" } }, 500);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const all = sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [];
    const limit = Number(url.searchParams.get("limit") ?? "10");
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((row) => row.id === after) + 1 : 0;
    const data: unknown[] = all.slice(from, from + limit);
    if (garbledRow) data.unshift({ object: "checkout.session", status: "complete" });
    return answer({ object: "list", data, has_more: from + limit < all.length });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const paid = (n: number, product: string) => ({
  id: `cs_test_cpu${String(n).padStart(6, "0")}`,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400 - n,
  customer: null,
  metadata: { store: "paidunknown", product },
  payment_intent: { id: `pi_cpu${n}`, object: "payment_intent", latest_charge: { object: "charge", amount: 4900, amount_refunded: 0, refunded: false } },
});
/** `before` purchases of another product, then the one that opens the door (or not). */
const history = (before: number, ticket: string | null, other: string) => [
  ...Array.from({ length: before }, (_, i) => paid(i + 1, other)),
  ...(ticket ? [paid(before + 1, ticket)] : []),
];

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_community_paid_unknown_only";
  process.env.RESEND_API_KEY = "re_test_community_paid_unknown_only";
  await claimHandle(OWNER, "paidunknown", "Paid Unknown", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPaidUnkn01", true);
  await setSubscription(OWNER, { customerId: "cus_PaidUnkn0001", subscriptionId: "sub_PaidUnkn0001", active: true, period: paidPeriod() });
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

  const pages = typeof (readRules as Record<string, unknown>).TICKET_SESSION_PAGES === "number" ? ((readRules as Record<string, unknown>).TICKET_SESSION_PAGES as number) : 1;
  const ticketState = (access as Record<string, unknown>).ticketState as
    | ((store: unknown, config: CommunityConfig, email: string) => Promise<boolean | "unknown">)
    | undefined;
  const state = async (email: string) => (ticketState ? ticketState(await fresh(), config, email) : "no ticketState");
  const viewerOf = async (email: string) => {
    cookieValues.clear();
    const jar = { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
    const token = await mintPass(await fresh(), email, "all");
    return access.communityViewer(store, jar);
  };
  const draw = async (email: string) => {
    cookieValues.clear();
    cookieValues.set(passCookieName(await fresh()), await mintPass(store, email, "all"));
    try {
      const page = await CommunityPage({ params: Promise.resolve({ handle: "@paidunknown" }), searchParams: Promise.resolve({}) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, page));
    } catch (error) {
      return `PAGE_FAILED ${String(error)}`;
    }
  };

  part("The checkouts are read page after page, each in its exact shape");
  sessions["ana@example.com"] = history(0, ticket, other);
  is("control: the ticket on the first page opens the door", (await viewerOf("ana@example.com")).state, "in");
  sessions["ben@example.com"] = history(150, ticket, other);
  is("the ticket on the second page opens the door", (await viewerOf("ben@example.com")).state, "in");
  is("and the podcast's door (holdsProducts) too", await access.holdsProducts(await fresh(), [ticket], "ben@example.com", "nl:test:cpu:ben", "1"), true);
  sessions["cy@example.com"] = history(Math.max(0, pages * 100 - 1), ticket, other);
  is(`the ticket at the end of the last page read (${pages}) still opens`, (await viewerOf("cy@example.com")).state, "in");
  sessions["dee@example.com"] = history(Math.min(250, pages * 100 - 50), null, other);
  stripeReads = 0;
  is("nothing that opens it, the list read to its end: closed", (await viewerOf("dee@example.com")).state, "closed");
  is("read in more than one page, at most the pages allowed", stripeReads >= 2 && stripeReads <= pages, true);

  part("Past the pages read: not known, never 'has nothing'");
  sessions["eve@example.com"] = history(pages * 100 + 5, ticket, other);
  stripeReads = 0;
  const eve = await viewerOf("eve@example.com");
  is("the viewer is 'unknown', not 'closed' and not let in", eve.state, "unknown");
  is("no more than the pages allowed were read", stripeReads <= pages, true);
  is("the ticket state says so too", await state("eve@example.com"), "unknown");
  let strictError: unknown = null;
  await access.holdsProductsOrThrow(await fresh(), [ticket], "eve@example.com", "nl:test:cpu:eve", "1").catch((error) => (strictError = error));
  is("a strict door throws, and is told asking again will not tell", [strictError !== null, access.askingAgainWontTell(strictError)], [true, true]);

  part("A row that does not read keeps a 'no' from being said");
  sessions["fay@example.com"] = history(3, null, other);
  garbledRow = true;
  is("nothing found, one row unreadable: unknown", await state("fay@example.com"), "unknown");
  garbledRow = false;
  // Rule 23 (the pre-review of 9 November 2026, round 2): a "not known" that asking again will not change is kept a
  // minute, as a "no" is, so the list read whole is asked once that minute is over.
  redis.advance(61_000);
  is("the same list read whole: no", await state("fay@example.com"), false);

  part("Stripe down: not known, and not kept");
  sessions["gus@example.com"] = history(0, ticket, other);
  stripeDown = true;
  const gus = await viewerOf("gus@example.com");
  is("the viewer is 'unknown', not 'closed'", gus.state, "unknown");
  const html = await draw("gus@example.com");
  const en = COMMUNITY_WORDS.en as Record<string, unknown>;
  is("the page is drawn", html.startsWith("PAGE_FAILED"), false);
  is("it never says the address has nothing from the store", [html.includes("has nothing from"), html.includes(String(en.closedTitle))], [false, false]);
  is("it says it could not be checked just now", typeof en.unknownTitle === "string" && html.includes(String(en.unknownTitle).replace(/'/g, "&#x27;")), true);
  is("with a way to check again, a 44 px target leading back to the community", /<a[^>]*href="\/@paidunknown\/community"[^>]*min-h-11[^>]*>/.test(html) || /<a[^>]*min-h-11[^>]*href="\/@paidunknown\/community"[^>]*>/.test(html), true);
  is("and no product to buy shown as the way in", html.includes("Club pass"), false);
  stripeDown = false;
  is("Stripe back: let in at once (the unknown was not kept)", (await viewerOf("gus@example.com")).state, "in");

  part("Send me the link, for an address whose answer is not known");
  stripeDown = true;
  resendCalls = 0;
  const asked = await access.requestCommunityLink({ store: await fresh(), email: "hal@example.com", ip: "203.0.113.9", origin: "https://marktmorgen.com" });
  is("says to try again, never a quiet 'sent'", asked, "error");
  is("and sends nothing", resendCalls, 0);
  stripeDown = false;
  sessions["ivy@example.com"] = history(2, null, other);
  is("an address that bought nothing that opens it: 'sent', as before", await access.requestCommunityLink({ store: await fresh(), email: "ivy@example.com", ip: "203.0.113.10", origin: "https://marktmorgen.com" }), "sent");

  part("A kept space whose answer is not known");
  // Rule 23 (the pre-review of 9 November 2026, P1): the door and the spaces are now answered from one reading of what
  // jo holds, so a space can no longer be "not known" while the door was read whole a moment before (with Stripe down
  // the door itself is not known, checked above). The space not known is a reading that found the ticket and could
  // not read to the end: jo's ticket on the first page, more purchases than are read behind it.
  sessions["jo@example.com"] = [paid(1, ticket), ...history(pages * 100 + 5, null, other).map((row, i) => ({ ...row, id: `cs_test_cpujo${String(i).padStart(6, "0")}` }))];
  is("jo is let in (control)", (await viewerOf("jo@example.com")).state, "in");
  const roomHtml = await draw("jo@example.com");
  const locked = roomHtml.match(/<section[^>]*id="cm-locked"[\s\S]*?<\/section>/)?.[0] ?? "";
  is("the page is drawn", roomHtml.startsWith("PAGE_FAILED"), false);
  is("the space is listed, without 'Unlock with' a product jo may hold", [locked.includes("Inner room"), locked.includes("Unlock with")], [true, false]);
  // Rule 23 (round 2 of that pre-review): was `unchecked` ("Reload the page"); jo's purchases are more than are read,
  // so reloading will not tell, and the space says to write to the creator.
  const lw = (lockedWordsModule.lockedWords("en") as Record<string, unknown>).uncheckedLasting;
  is("it says the access could not be checked", typeof lw === "string" && locked.includes(lw.replace(/'/g, "&#x27;")), true);

  part("Words, in every language");
  const languages = Object.keys(COMMUNITY_WORDS) as (keyof typeof COMMUNITY_WORDS)[];
  is(
    "every language has the unknown words and the space's notice",
    languages.filter((l) => {
      const w = COMMUNITY_WORDS[l] as Record<string, unknown>;
      const n = (w.notices ?? {}) as Record<string, unknown>;
      const lw = lockedWordsModule.lockedWords(l) as Record<string, unknown>;
      return !(typeof w.unknownTitle === "string" && typeof w.unknownBody === "function" && typeof w.unknownAgain === "string" && typeof n.spaceunknown === "string" && typeof lw.unchecked === "string");
    }),
    [],
  );

  part("A check's worst Stripe reads are counted");
  const waits = (readRules as Record<string, unknown>).TICKET_STRIPE_WAITS;
  is("the most a check waits on Stripe is a named figure", typeof waits === "number" && waits >= 2 * pages, true);
  const source = read("tests/plan-cost-registry.ts");
  is("the registry prices a check from it", /ACCESS_CHECK_READ\s*=.*TICKET_STRIPE_WAITS/.test(source), true);
  is("and a check's units still cover it", readRules.checkUnits(1) * laterPageCost() >= registry.ACCESS_CHECK_READ, true);

  done();
}

void main();
