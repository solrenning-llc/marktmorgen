/**
 * The pre-review of claude5/community-paid-unknown (9 November 2026), P1 to P5 and the cost of a check, read with the
 * code itself, the in-memory database and a stand-in for the creator's Stripe account:
 *
 *   P1  one search of twenty lessons or events was twenty Stripe checks of 16 requests each, 320 requests: more than
 *       a Store member's whole day share, so the member was sent to the resting page, a visible limit cut in
 *       practice. Now one reading of what the person holds (holdingsOf) answers the door, the spaces, the lessons and
 *       the events, kept per community, person and settings' version, and paid once, only when it is not kept;
 *   cost  a page of checkouts is read up to a ceiling of bytes, past which the answer is not known (never "no", never
 *       read whole into memory);
 *   P2  a member whose answer is not known, sent back with ?n=out, is never told the session ended with a form that
 *       is not there;
 *   P3  a lasting unknown (more purchases than are read) is never promised "try again in a minute", is told to write
 *       to the creator, keeps the form to use another address, and "Send me the link" is not an "error" for good;
 *   P4  an event kept for buyers says "not known" when it is, never "not for you"; a search says the matches it could
 *       not check, never that they are in something the member does not have;
 *   P5  the German line uses "Sie"; the gate's new title is a heading; its words name no payment service.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import CommunityPage from "@/app/[handle]/community/page";
import * as access from "@/lib/community-access";
import * as readRules from "@/lib/community-read-rules";
import { COMMUNITY_WORDS } from "@/lib/buyer-words/community";
import * as lockedWordsModule from "@/lib/buyer-words/community-locked";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { type CommunityConfig, freshConfig, newItemId, saveConfig } from "@/lib/community";
import { mintPass, passCookieName } from "@/lib/learn";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { checkUnits } from "@/lib/community-read-rules";
import { SEARCH_PAGE } from "@/lib/community-search";
import { clientDayShare, requestLimitFor, REQUESTS_PER_VISIT } from "@/lib/traffic-rules";
import { mayAttend } from "@/lib/community-events";

const OWNER = "cpu-owner@example.com";
const NOW = Math.floor(Date.now() / 1000);
const read = (file: string) => readFileSync(file, "utf8");

/** Checkouts by the address they were paid from, in Stripe's order (newest first). */
const sessions: Record<string, Record<string, unknown>[]> = {};
let stripeDown = false;
/** A row Stripe sends that is not a checkout as it lists them, put first on every page when set. */
const garbledRow = false;
let stripeReads = 0;
/** Characters added to the first checkout of every page, to make a page heavier than it may be read. */
let padding = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname.includes("resend")) return answer({ id: "email_test_1" });
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
    if (padding && data.length) data[0] = { ...(data[0] as Record<string, unknown>), client_reference_id: "x".repeat(padding) };
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
  await ensureStoreId(OWNER);
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
  const drawWith = async (email: string, sp: Record<string, string>) => {
    cookieValues.clear();
    cookieValues.set(passCookieName(await fresh()), await mintPass(store, email, "all"));
    const page = await CommunityPage({ params: Promise.resolve({ handle: "@paidunknown" }), searchParams: Promise.resolve(sp) });
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, page));
  };
  const en = COMMUNITY_WORDS.en as unknown as { sessionEnded: { title: string }; unknownLastingBody?: (email: string, store: string) => string };

  part("P1 [ALTO] one search of 20 events/lessons outspends a Store member's whole day, and 1/33 of the store's month");
  const whole = requestLimitFor(await fresh());
  const share = clientDayShare(whole);
  const search = checkUnits(SEARCH_PAGE);
  console.log({ tier: store.tier, whole, share, search, visitsEquivalent: search / REQUESTS_PER_VISIT, searchesPerMonth: Math.floor(whole / search) });
  is("one full events tab fits a member's daily share", search <= share, true);
  is("one full events tab costs less than 10% of the Store window's 500 extra requests", search <= 50, true);
  is("a page of twenty checks costs what one reading costs", checkUnits(SEARCH_PAGE), checkUnits(1));
  is("holdingsOf: one reading of what the person holds", typeof (access as Record<string, unknown>).holdingsOf, "function");
  sessions["nia@example.com"] = history(3, ticket, other);
  const evs = Array.from({ length: 20 }, (_, i) => ({ id: `ev${i}`, v: 1, only: [i % 2 ? ticket : inner], cancelled: false }) as never);
  stripeReads = 0;
  const firstAnswer = await mayAttend(await fresh(), config, evs[0], { owner: false, email: "nia@example.com" });
  const oneReading = stripeReads;
  stripeReads = 0;
  const rest = [];
  for (const ev of evs.slice(1)) rest.push(await mayAttend(await fresh(), config, ev, { owner: false, email: "nia@example.com" }));
  is("control: the first event's answer (nia holds no Inner notes)", [firstAnswer, oneReading > 0], [false, true]);
  is("nineteen more events ask Stripe nothing more: the one reading answers them", stripeReads, 0);
  is("and each answer is the reading's", rest.slice(0, 2), [true, false]);
  stripeReads = 0;
  is("the door asks nothing more either", (await viewerOf("nia@example.com")).state, "in");
  is("(no Stripe read)", stripeReads, 0);

  part("Cost: a page of checkouts is read up to a ceiling of bytes, past it not known");
  const ceiling = (readRules as Record<string, unknown>).TICKET_SESSION_PAGE_BYTES;
  is("the ceiling is a named figure", typeof ceiling === "number" && ceiling > 0, true);
  is("the registry prices a check's pages from it", /TICKET_SESSION_PAGE_BYTES/.test(read("tests/plan-cost-registry.ts")), true);
  sessions["oz@example.com"] = history(0, ticket, other);
  padding = (typeof ceiling === "number" ? ceiling : 2_400_000) + 1;
  const heavy = await state("oz@example.com");
  let heavyStrict: unknown = null;
  await access.holdsProductsOrThrow(await fresh(), [ticket], "oz@example.com", "nl:test:cpu:oz", "1").catch((error) => (heavyStrict = error));
  padding = 0;
  // Rule 23 (round 2 of the pre-review): a page past the ceiling is not known for good, and kept a minute, as a "no" is;
  // the control below asks once that minute is over.
  redis.advance(61_000);
  is("a page past the ceiling is not known, never read", heavy, "unknown");
  is("a strict door is told asking again will not tell", [heavyStrict !== null, access.askingAgainWontTell(heavyStrict)], [true, true]);
  is("control: the same page within the ceiling opens", await state("oz@example.com"), true);

  part("P2 [MEDIO] an unknown member sent back with ?n=out reads 'session ended, ask for a new link below' with no form below");
  sessions["kim@example.com"] = history(0, ticket, other);
  stripeDown = true;
  const outHtml = await drawWith("kim@example.com", { n: "out" });
  stripeDown = false;
  const saysEnded = outHtml.includes(String(en.sessionEnded.title));
  const hasForm = outHtml.includes('action="/api/store/community/link"');
  is("never says the session ended to a signed-in member", saysEnded, false);
  is("(or, if it does, the form it points to is there)", saysEnded && !hasForm, false);

  part("P3 [MEDIO] a lasting unknown (more than the pages read) is told 'try again in a minute', for good");
  sessions["lou@example.com"] = history(pages * 100 + 5, ticket, other);
  const first = (await viewerOf("lou@example.com")).state;
  const second = (await viewerOf("lou@example.com")).state;
  const louHtml = await drawWith("lou@example.com", {});
  is("still unknown on every try (control)", [first, second], ["unknown", "unknown"]);
  is("the page never promises a minute will fix it", louHtml.includes("Try again in a minute"), false);
  // The test world sends no email (no meter for it), so what is checked is that the ask got past the access question to
  // the link it emails, as a holder's does: a link kept (nl:cm:link:*), and the same answer as a holder's.
  const links = async () => {
    const [reply] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:cm:link:*", "COUNT", "100000"]])) as [[string, string[]]];
    return reply[1].length;
  };
  sessions["holder@example.com"] = history(0, ticket, other);
  const before = await links();
  const holderAsk = await access.requestCommunityLink({ store: await fresh(), email: "holder@example.com", ip: "203.0.113.78", origin: "https://marktmorgen.com" });
  const afterHolder = await links();
  const linkAsk = await access.requestCommunityLink({ store: await fresh(), email: "lou@example.com", ip: "203.0.113.77", origin: "https://marktmorgen.com" });
  const afterLou = await links();
  is("control: a holder's ask keeps a link to email", afterHolder - before, 1);
  is("'Send me the link' for a lasting unknown goes on to the link, as a holder's does (never an 'error' for good before it)", [afterLou - afterHolder, linkAsk], [1, holderAsk]);
  is("it says to write to the creator", typeof en.unknownLastingBody === "function" && louHtml.includes(String(en.unknownLastingBody("lou@example.com", "Paid Unknown")).replace(/'/g, "&#x27;")), true);
  is("and keeps the form to use another address", louHtml.includes('action="/api/store/community/link"'), true);

  part("P4 [MEDIO] an event kept for buyers still reads 'not for you' when Stripe is not known");
  const ev = { id: "ev1", v: 1, only: [ticket], cancelled: false } as never;
  sessions["max@example.com"] = history(0, ticket, other);
  stripeDown = true;
  const attend = await mayAttend(await fresh(), config, ev, { owner: false, email: "max@example.com" }).catch((e) => `threw ${e}`);
  stripeDown = false;
  is("mayAttend says not known, never false (the rsvp route then says 'eventlocked')", attend === false, false);
  is("and says it as not known", attend, "unknown");
  const languages = Object.keys(COMMUNITY_WORDS) as (keyof typeof COMMUNITY_WORDS)[];
  is(
    "every language says an event and a search match not checked",
    languages.filter((l) => {
      const w = COMMUNITY_WORDS[l] as unknown as Record<string, unknown> & { notices?: Record<string, unknown> };
      return !(typeof w.notices?.eventunknown === "string" && typeof w.eventUnchecked === "string" && typeof w.uncheckedMore === "function" && typeof w.unknownLastingBody === "function");
    }),
    [],
  );
  const searchSource = read("app/[handle]/community/search/page.tsx");
  is("the search tells the matches it could not check apart from those held back", /uncheckedMore\(/.test(searchSource), true);
  is("the rsvp route says an unknown as such", /eventunknown/.test(read("app/api/store/community/rsvp/route.ts")), true);

  part("P5 [LEVE] German: the new space line uses 'du' while the community words use 'Sie'");
  const de = (lockedWordsModule.lockedWords("de") as unknown as Record<string, string>).unchecked;
  is("same register", /\b(dein|deinen|du)\b/.test(de), false);
  sessions["pia@example.com"] = history(0, ticket, other);
  stripeDown = true;
  const piaHtml = await drawWith("pia@example.com", {});
  stripeDown = false;
  is("the gate's unknown title is a heading", /<h2[^>]*>[^<]*could not check your access just now/.test(piaHtml), true);
  is("its words name no payment service (Redis may be what failed)", Object.keys(COMMUNITY_WORDS).filter((l) => /payment service|servicio de pagos|service de paiement|Zahlungsdienst|servizio di pagamento|betaaldienst|serviço de pagamento/i.test(String((COMMUNITY_WORDS[l as keyof typeof COMMUNITY_WORDS] as unknown as { unknownBody: (e: string, s: string) => string }).unknownBody("a@b.c", "S")))), []);

  done();
}

void main();
