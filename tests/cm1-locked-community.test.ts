/**
 * 542 [CM1]: a space kept for the buyers of some products, shown "Visible
 * and locked" (6 November 2026). The real community feed page, drawn as a
 * member on a synthetic store, with the stand-in Redis and a stubbed Stripe:
 *
 *   - a member without the product sees the space's name, its one line, the
 *     word "Locked" and "Unlock with <product>", which leads to that product's
 *     page; never a post, a comment, a member's name, the space's address or
 *     a number from inside it;
 *   - a space left "Hidden" (the default) shows no sign of itself;
 *   - the link names only a product published and on sale now; with none,
 *     the space says access isn't available yet;
 *   - a member who holds one of the products sees the space as before
 *     (holdsAnyOf), with nothing to unlock;
 *   - an access answer that is unknown (Stripe down, or the kept answer not
 *     read) never shows the content and never offers to sell the product
 *     again: the space is said as not checked just now (review of #3007, M1);
 *     asked for directly, it is never answered as kept for other buyers;
 *   - a product whose stock or keys cannot be read is unknown, never "not
 *     available" (L1), and a space's view whose save was not confirmed is
 *     never answered as saved (L2).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { NextRequest } from "next/server";
import CommunityPage from "@/app/[handle]/community/page";
import { POST as spaceView } from "@/app/api/store/community/space-view/route";
import { SESSION_COOKIE, normaliseEmail, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setCommunity, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { CREATOR, type CommunityConfig, addComment, createPost, freshConfig, memberKey, newItemId, readMember, saveConfig, touchMember } from "@/lib/community";
import { leadsKey } from "@/lib/contacts";
import { mintPass, passCookieName } from "@/lib/learn";
import { productSegment } from "@/lib/product-slug";
import { MAX_UNLOCK_PRODUCTS, lockedOf, unlockCandidates, unlocksOf } from "@/lib/community-locked";
import { collectionUnits } from "@/lib/page-read-rules";
import { readListings } from "@/lib/catalog";
import { productsBuyableNow } from "@/lib/mail-product-sellable";
import type { Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { cookieValues } from "./meeting-withdrawal-page-world";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let stripe: "empty" | "down" = "empty";
globalThis.fetch = (async () =>
  stripe === "down"
    ? new Response(JSON.stringify({ error: { message: "synthetic outage" } }), { status: 500 })
    : new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const OWNER = "cm1-owner@example.com";
const OUTSIDER = "cm1-outsider@example.com";
const INSIDER = "cm1-insider@example.com";
const STRANGER = "cm1-stranger@example.com";

async function made(title: string, price: string): Promise<string> {
  const added = await addProduct(OWNER, title, "", price, null);
  if (!added.ok) throw new Error(`no product ${title}`);
  await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
  return added.product.id;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_cm1_locked_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_cm1_locked_only_a_stand_in";
  await claimHandle(OWNER, "lockedclub", "Locked Club", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLocked0001", true);
  await setSubscription(OWNER, { customerId: "cus_Locked00001", subscriptionId: "sub_Locked00001", active: true, period: paidPeriod() });
  const starter = await made("Starter notes", "0");
  const guide = await made("Guide", "19");
  const draft = await made("Draft plan", "9");
  await setProductHidden(OWNER, draft, true);
  const bonus = await made("Bonus", "0");
  await setCommunity(OWNER, true);
  let store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;

  const general = newItemId(), inner = newItemId(), secret = newItemId(), later = newItemId();
  const config: CommunityConfig = {
    ...freshConfig(store.name),
    access: [starter, guide, draft, bonus],
    spaces: [
      { id: general, name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: inner, name: "Inner circle", about: "Weekly calls for Guide buyers", creatorOnly: false, only: [guide, bonus], level: 0, shown: true },
      { id: secret, name: "Secret room", about: "A line nobody outside should read", creatorOnly: false, only: [guide], level: 0 },
      { id: later, name: "Draft room", about: "Opens with the plan", creatorOnly: false, only: [draft], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  };
  await saveConfig(id, config);

  // Who got which free product, on the creator's list (lib/community-access.ts, gotFree).
  const lead = (ids: string[]) => JSON.stringify({ agreed: false, agreedAt: "", firstAt: "", lastAt: "", titles: [], ids, source: "free", unsub: false, unsubAt: "" });
  await redis.pipeline([
    ["HSET", leadsKey(store.listId!), normaliseEmail(OUTSIDER), lead([starter])],
    ["HSET", leadsKey(store.listId!), normaliseEmail(STRANGER), lead([starter])],
    ["HSET", leadsKey(store.listId!), normaliseEmail(INSIDER), lead([starter, bonus])],
  ]);
  const insider = (await touchMember(id, INSIDER, null, store))!;
  // The name the insider chose, written as setProfile keeps it (its script is not in the stand-in Redis).
  await redis.pipeline([["HSET", `nl:cm:${id}:m`, insider.k, JSON.stringify({ ...insider, n: "Ivy Insider" })]]);
  const hidden = await createPost(id, { space: inner, author: memberKey(INSIDER), title: "Secret strategy", text: "PRIVATE-INNER-TEXT", img: null, kind: "post", poll: null }, store);
  if (!hidden.ok) throw new Error("no post");
  await addComment(id, hidden.post.id, { parent: "", author: memberKey(INSIDER), text: "PRIVATE-COMMENT" }, store);
  await createPost(id, { space: secret, author: CREATOR, title: "Hidden news", text: "PRIVATE-SECRET-TEXT", img: null, kind: "post", poll: null }, store);
  await createPost(id, { space: general, author: CREATOR, title: "Hello everyone", text: "OPEN-GENERAL-TEXT", img: null, kind: "post", poll: null }, store);
  if ((await readMember(id, memberKey(INSIDER)))?.n !== "Ivy Insider") throw new Error("no insider");

  async function draw(as: string, query: Record<string, string> = {}): Promise<string> {
    cookieValues.clear();
    store = (await storeForEmail(OWNER))!;
    cookieValues.set(passCookieName(store), await mintPass(store, as, "all"));
    try {
      const page = await CommunityPage({ params: Promise.resolve({ handle: "@lockedclub" }), searchParams: Promise.resolve(query) });
      return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {}, replace() {}, prefetch() {} } as never }, page));
    } catch (error) {
      return `PAGE_FAILED ${String(error)}`;
    }
  }
  const lockedPart = (html: string) => html.match(/<section[^>]*id="cm-locked"[\s\S]*?<\/section>/)?.[0] ?? "";
  const nothingInside = (html: string) => ["PRIVATE-INNER-TEXT", "Secret strategy", "PRIVATE-COMMENT", "Ivy Insider", "PRIVATE-SECRET-TEXT", "Hidden news"].filter((t) => html.includes(t));
  const guideHref = `/@lockedclub/p/${productSegment({ id: guide, title: "Guide" })}`;

  part("A member without the product: the locked space, its way in, nothing from inside");
  let html = await draw(OUTSIDER);
  is("the page is drawn", html.startsWith("PAGE_FAILED"), false);
  is("the open space's post is there (control)", html.includes("OPEN-GENERAL-TEXT"), true);
  const locked = lockedPart(html);
  is("the locked space's name and one line, with the word Locked", [locked.includes("Inner circle"), locked.includes("Weekly calls for Guide buyers"), />Locked</.test(locked)], [true, true, true]);
  is("Unlock with the product, leading to its page", [locked.includes("Unlock with Guide"), locked.includes(`href="${guideHref}"`)], [true, true]);
  is("nothing of the space's posts, comments or members reaches the page", nothingInside(html), []);
  is("the locked space's address is nowhere on the page", [html.includes(inner), html.includes(`space=${inner}`)], [false, false]);
  // The text a person reads or hears, and no data attribute: no count of posts or members anywhere in the list.
  is("no number in the locked list (no count of posts or members)", [/\d/.test(locked.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'")), /\sdata-/.test(locked)], [false, false]);
  is("a space left Hidden shows no sign of itself", [html.includes("Secret room"), html.includes("A line nobody outside should read"), html.includes(secret)], [false, false, false]);
  is("a space whose product is a draft says access isn't available yet, with no link", [locked.includes("Draft room"), locked.includes("Access isn&#x27;t available yet."), html.includes(productSegment({ id: draft, title: "Draft plan" }))], [true, true, false]);

  part("A member who holds one of the products sees the space, as before");
  html = await draw(INSIDER);
  is("the inner post and its author are there", [html.includes("PRIVATE-INNER-TEXT"), html.includes("Ivy Insider")], [true, true]);
  is("and nothing to unlock for it", lockedPart(html).includes("Inner circle"), false);

  part("An unknown access answer: never the content, never an offer to buy, said as not checked (review of #3007, M1)");
  const uncheckedPart = (html: string) => html.match(/<section[^>]*id="cm-unchecked"[\s\S]*?<\/section>/)?.[0] ?? "";
  const NOT_CHECKED = "We couldn&#x27;t check your access to these spaces just now. Reload the page to try again.";
  stripe = "down";
  html = await draw(STRANGER);
  is("Stripe down: the page is drawn, with nothing from inside", [html.startsWith("PAGE_FAILED"), nothingInside(html)], [false, []]);
  is("Stripe down: no offer to buy the product, and the space is not called locked", [html.includes("Unlock with"), lockedPart(html).includes("Inner circle")], [false, false]);
  is("Stripe down: the space is said as not checked just now", [uncheckedPart(html).includes("Inner circle"), uncheckedPart(html).includes(NOT_CHECKED)], [true, true]);
  is("Stripe down: a Hidden space still shows no sign of itself", [html.includes("Secret room"), html.includes(secret)], [false, false]);
  stripe = "empty";
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && String(c[1]).includes(":sp:ok:"))) throw new Error("synthetic lost reply");
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    html = await draw(OUTSIDER);
    is("the kept answer not read: drawn, nothing from inside, no offer to buy", [html.startsWith("PAGE_FAILED"), nothingInside(html), html.includes("Unlock with")], [false, [], false]);
    is("and the space is said as not checked", uncheckedPart(html).includes("Inner circle"), true);
    html = await draw(INSIDER);
    is("a member who holds the product: never the content", [html.startsWith("PAGE_FAILED"), html.includes("PRIVATE-INNER-TEXT")], [false, false]);
    is("and never asked to buy it again, nor told it is locked", [html.includes("Unlock with Guide"), html.includes(guideHref), lockedPart(html).includes("Inner circle")], [false, false, false]);
    is("but told their access could not be checked just now", [uncheckedPart(html).includes("Inner circle"), uncheckedPart(html).includes(NOT_CHECKED)], [true, true]);
    html = await draw(INSIDER, { space: inner });
    is("asked for directly: never answered as kept for other buyers, never the content", [html.includes("spacelocked"), html.includes("PRIVATE-INNER-TEXT")], [false, false]);
  } finally {
    redis.pipeline = original;
  }
  html = await draw(INSIDER);
  is("control: read again, the member who holds it sees it", [html.includes("PRIVATE-INNER-TEXT"), uncheckedPart(html)], [true, ""]);

  part("A product whose stock cannot be read is unknown, never 'not available' (review of #3007, L1)");
  store = (await storeForEmail(OWNER))!;
  const [guideListing] = await readListings(store, [guide]);
  const limited: Listing = { ...guideListing, stock: 5 };
  const already = { soon: new Set<string>(), listings: new Map<string, Listing>() };
  is("control: its stock read, it is on sale", (await productsBuyableNow(store, [limited], Date.now(), already)).has(guide), true);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:stock:"))) throw new Error("synthetic lost reply");
    return original(commands);
  }) as typeof redis.pipeline;
  const stockUnread = await productsBuyableNow(store, [limited], Date.now(), already).then((ids) => (ids.has(guide) ? "on sale" : "left out"), () => "unknown");
  redis.pipeline = original;
  is("its stock not read: unknown (the locked space then says so), never left out as not on sale", stockUnread, "unknown");

  part("Only a product on sale now is named");
  await setStripeAccount(OWNER, "acct_1TestLocked0001", false);
  html = await draw(OUTSIDER);
  const shut = lockedPart(html);
  is("a store that cannot take money: no Unlock link to the paid product", [shut.includes("Unlock with Guide"), shut.includes(guideHref)], [false, false]);
  is("the free product it is also kept for is named instead, when the store can give it", shut.includes("Unlock with Bonus"), true);
  await setStripeAccount(OWNER, "acct_1TestLocked0001", true);

  part("The creator's choice, saved by its own route");
  const ownerCookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const choose = async (body: Record<string, unknown>, cookie = ownerCookie) => {
    const response = await spaceView(new NextRequest("https://marktmorgen.com/api/store/community/space-view", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": store.sid, cookie }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json()) as { ok: boolean }).ok];
  };
  is("Secret room made Visible and locked", await choose({ id: secret, view: "locked" }), [200, true]);
  is("Draft room made Hidden", await choose({ id: later, view: "hidden" }), [200, true]);
  is("an unknown space, or a view that is neither, is refused", [await choose({ id: newItemId(), view: "locked" }), await choose({ id: secret, view: "open" })], [[404, false], [400, false]]);
  is("nobody signed in is refused", await choose({ id: secret, view: "hidden" }, ""), [401, false]);
  // Review of #3007, L2: the save's own answer is read; one not confirmed is never answered as saved.
  const keep = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await keep(commands);
    return reply.map((r, i) => (commands[i][0] === "SET" && String(commands[i][1]).endsWith(":cfg") ? null : r));
  }) as typeof redis.pipeline;
  const unconfirmed = await choose({ id: secret, view: "locked" });
  redis.pipeline = keep;
  is("a save whose answer is not OK: an error, never saved", unconfirmed, [500, false]);
  html = await draw(OUTSIDER);
  is("the page follows: Secret room locked with nothing from inside, Draft room gone", [lockedPart(html).includes("Secret room"), lockedPart(html).includes("Draft room"), nothingInside(html)], [true, false, []]);

  part("The creator chooses it in the studio");
  const studio = readFileSync("components/community-studio.tsx", "utf8");
  is("the space's form offers Hidden and Visible and locked", [studio.includes("Visible and locked"), studio.includes("Hidden")], [true, true]);

  part("Products past the read cap: a space whose products were not read never says access isn't available");
  // Review of #3007 (6 November 2026): the candidates were every space's products joined and cut at the first 24,
  // so a space after one with 24 products got "none" while its product was on sale.
  const fillers: string[] = [];
  for (let n = 0; n < MAX_UNLOCK_PRODUCTS; n++) fillers.push(await made(`Item ${n}`, "5"));
  const big = newItemId(), small = newItemId();
  const capped = (bigNeeds: string[]): CommunityConfig => ({
    ...freshConfig(store.name),
    access: [starter, guide, ...fillers],
    spaces: [
      { id: general, name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: big, name: "Big room", about: "", creatorOnly: false, only: bigNeeds, level: 0, shown: true },
      { id: small, name: "Small room", about: "", creatorOnly: false, only: [guide], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  });
  const yes = async () => true;
  store = (await storeForEmail(OWNER))!;
  const guideLink = { title: "Guide", href: guideHref };
  is("control: with 23 products in the space before it, the small space names its product", (await unlocksOf(store, capped(fillers.slice(0, MAX_UNLOCK_PRODUCTS - 1)), yes))?.[small], guideLink);
  is("with 24 products in the space before it, the small space still names its product", (await unlocksOf(store, capped(fillers), yes))?.[small], guideLink);
  await saveConfig(id, capped(fillers));
  html = await draw(OUTSIDER);
  is("the member's page: Unlock with Guide for the small space, never not available", [lockedPart(html).includes("Unlock with Guide"), lockedPart(html).includes(`href="${guideHref}"`)], [true, true]);
  is("never more than the cap is read", unlockCandidates(lockedOf(capped(fillers), new Set())).length <= MAX_UNLOCK_PRODUCTS, true);
  // One space per product, more spaces than the cap: the one left unread is "unknown", never "none".
  const many: CommunityConfig = {
    ...freshConfig(store.name),
    access: [starter, guide, ...fillers],
    spaces: [...fillers, guide].map((product, n) => ({ id: newItemId(), name: `Room ${n}`, about: "", creatorOnly: false, only: [product], level: 0, shown: true })) as CommunityConfig["spaces"],
  };
  const ways = (await unlocksOf(store, many, yes))!;
  const last = many.spaces[many.spaces.length - 1].id;
  is("a space none of whose products was read is capped (ask the creator), not none", ways[last], "capped");
  is("no space says none while its product is on sale", Object.values(ways).filter((way) => way === "none").length, 0);

  part("The read cap runs out before a product on sale: the space says so truthfully, never 'reload'");
  // Review of #3007 (7 November 2026): 24 hidden products before the one on sale left the space "unknown" for good,
  // and the page said "Reload the page to try again", which never helps (a space takes up to 50 products).
  const shelved: string[] = [];
  for (let n = 0; n < MAX_UNLOCK_PRODUCTS; n++) {
    const product = await made(`Shelved ${n}`, "5");
    await setProductHidden(OWNER, product, true);
    shelved.push(product);
  }
  const deep = newItemId();
  const deepConfig: CommunityConfig = {
    ...freshConfig(store.name),
    access: [starter, guide, ...shelved],
    spaces: [
      { id: general, name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: deep, name: "Deep room", about: "", creatorOnly: false, only: [...shelved, guide], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  };
  store = (await storeForEmail(OWNER))!;
  let units = 0;
  const counted = async (n: number) => {
    units += n;
    return true;
  };
  is("24 hidden products, then Guide on sale: the space is capped, not unknown", (await unlocksOf(store, deepConfig, counted))?.[deep], "capped");
  is("and no more than the cap was paid for", units <= collectionUnits(MAX_UNLOCK_PRODUCTS), true);
  await saveConfig(id, deepConfig);
  html = await draw(OUTSIDER);
  is("the member's page asks them to ask the creator, and never says reload", [lockedPart(html).includes("Ask the creator how to get in."), lockedPart(html).includes("Reload the page")], [true, false]);

  part("A space settled by its first product leaves the rest of the cap to the next one");
  const quick = newItemId(), slow = newItemId();
  const twoConfig: CommunityConfig = {
    ...freshConfig(store.name),
    access: [guide, ...fillers, ...shelved],
    spaces: [
      { id: general, name: "General", about: "", creatorOnly: false, only: [], level: 0 },
      { id: quick, name: "Quick room", about: "", creatorOnly: false, only: fillers, level: 0, shown: true },
      { id: slow, name: "Slow room", about: "", creatorOnly: false, only: [...shelved.slice(0, 13), guide], level: 0, shown: true },
    ] as CommunityConfig["spaces"],
  };
  units = 0;
  const two = (await unlocksOf(store, twoConfig, counted))!;
  is("the quick space names its first product", two[quick], { title: "Item 0", href: `/@lockedclub/p/${productSegment({ id: fillers[0], title: "Item 0" })}` });
  is("the slow space, behind 13 hidden products, still names Guide", two[slow], guideLink);
  is("and the reads stay inside the cap", units <= collectionUnits(MAX_UNLOCK_PRODUCTS), true);
  done();
}

void main();
