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
 *     read) draws the locked view, never the content, and never fails the page.
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

  async function draw(as: string): Promise<string> {
    cookieValues.clear();
    store = (await storeForEmail(OWNER))!;
    cookieValues.set(passCookieName(store), await mintPass(store, as, "all"));
    try {
      const page = await CommunityPage({ params: Promise.resolve({ handle: "@lockedclub" }), searchParams: Promise.resolve({}) });
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

  part("An unknown access answer draws the locked view, never the content");
  stripe = "down";
  html = await draw(STRANGER);
  is("Stripe down: the page is drawn, locked, with nothing from inside", [html.startsWith("PAGE_FAILED"), lockedPart(html).includes("Inner circle"), nothingInside(html)], [false, true, []]);
  stripe = "empty";
  const original = redis.pipeline.bind(redis);
  // Rule 23 (the pre-review of 9 November 2026, P1): the spaces are answered from the one kept reading of what the
  // member holds (lib/community-access.ts holdingsOf, nl:cm:<id>:h:...), the same the door reads, no longer from a
  // kept answer of their own (:sp:ok:). Its reply lost leaves the door itself not known: the page says so, and
  // nothing from inside, and no locked list, is drawn.
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "GET" && /:sp:ok:|:h:/.test(String(c[1])))) throw new Error("synthetic lost reply");
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    html = await draw(OUTSIDER);
    is("the kept answer not read: the page is drawn, with nothing from inside", [html.startsWith("PAGE_FAILED"), nothingInside(html)], [false, []]);
    html = await draw(INSIDER);
    is("even for a member who holds the product: locked, never the content", [html.startsWith("PAGE_FAILED"), html.includes("PRIVATE-INNER-TEXT")], [false, false]);
  } finally {
    redis.pipeline = original;
  }

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
  html = await draw(OUTSIDER);
  is("the page follows: Secret room locked with nothing from inside, Draft room gone", [lockedPart(html).includes("Secret room"), lockedPart(html).includes("Draft room"), nothingInside(html)], [true, false, []]);

  part("The creator chooses it in the studio");
  const studio = readFileSync("components/community-studio.tsx", "utf8");
  is("the space's form offers Hidden and Visible and locked", [studio.includes("Visible and locked"), studio.includes("Hidden")], [true, true]);
  done();
}

void main();
