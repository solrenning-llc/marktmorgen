/**
 * 651 [WG11] unit 2, on Today (app/studio/page.tsx): the person's passkeys, and whether this session may add or keep
 * one, are read only after the passkeys whose wait has run out are removed (lib/passkeys.ts pendingRemoval), as before
 * the page sent its reads together. Read beside that removal, the list still held the passkey being removed, and the
 * studio showed a passkey that could no longer log in, with no removal date beside it.
 *
 * The real page, a real store and a real passkey set to be removed seven days and a minute ago (its removal record
 * written as lib/passkeys.ts writes one whose notice went out). What Today hands its passkey managers must not hold that passkey.
 *
 * And the store writes Today's parts make, in the order they had when the page read one section after another (#2900):
 * the ready cart link's count, which reads the billing month from Stripe and writes it when it is not known
 * (lib/billing-sync.ts refreshPeriod, under the store's lock), then a token's platforms (setAdsServer), then the
 * add-on's month (syncAssistant). Rendered side by side, the cart link's write met the others on the store's lock.
 *
 * And the banner over Today about two-step login (Claude 4's C4-2980 on #2900): when the person's two-step login could
 * not be read, the page says so plainly, rather than reading it as "no request to turn it off" and showing nothing.
 * Nor does Two-step login below, or the invitation to add an app's code, take that unread login for "off": they offer
 * no way to turn it on over it, and say it could not be read (CX-123 rule 24, lib/redis-reply.ts).
 *
 * And "Update now" (Claude 5's LEVE 1 on #2835): the day's reading of the store's numbers is taken only once the
 * reads the page waits for have answered, never for a page that ends in its error. Nor does the one read made after
 * it, the products the numbers name (Claude 5's residual LEVE on #2835), end the page in its error once the reading
 * is spent: the numbers then wait, as when they could not be read, and no product is named gone for it.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answering } from "./security/next-headers";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { REMOVAL_DAYS, listPasskeys } from "@/lib/passkeys";
import { addProduct, claimHandle, ensureStatsId, setAdsServer, setProductHidden, setAssistantPlan, setPixels, setSubscription, storeForEmail } from "@/lib/store";
import { NO_PIXELS } from "@/lib/pixels";
import StudioPage from "@/app/studio/page";
import { AppCodeInvite } from "@/components/app-code-invite";
import { StatsPanel } from "@/components/stats-panel";
import { TwoStepManager } from "@/components/two-step-manager";
import { makePasskey } from "./passkey-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** Every string shown anywhere in the page's tree, its parts waited for as passkeyLists waits for them. */
async function words(node: unknown, found: string[] = [], seen = new Set<unknown>()): Promise<string[]> {
  if (typeof node === "string") {
    found.push(node);
    return found;
  }
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return words(await node, found, seen);
  if (Array.isArray(node)) {
    for (const child of node) await words(child, found, seen);
    return found;
  }
  if (isValidElement(node)) await words((node.props as { children?: unknown }).children, found, seen);
  return found;
}

/**
 * Every list of passkeys handed to a component anywhere in the page's tree (the managers' `initial`). The page's
 * parts are promises rendered beside each other (WG11 unit 2, step 2): each is waited for, inside the request, as
 * React waits for them.
 */
async function passkeyLists(node: unknown, found: string[][] = [], seen = new Set<unknown>()): Promise<string[][]> {
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return passkeyLists(await node, found, seen);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => passkeyLists(child, found, seen)));
    return found;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    const initial = props.initial;
    if (Array.isArray(initial) && initial.every((p) => p && typeof p === "object" && "synced" in p && "id" in p)) found.push(initial.map((p) => String((p as { id: string }).id)));
    await Promise.all(Object.values(props).map((value) => passkeyLists(value as ReactNode, found, seen)));
  }
  return found;
}

/** The props of every element of one component anywhere in the page's tree, its parts waited for as passkeyLists waits for them. */
async function propsOf(node: unknown, type: unknown, found: Record<string, unknown>[] = [], seen = new Set<unknown>()): Promise<Record<string, unknown>[]> {
  if (!node || typeof node !== "object" || seen.has(node)) return found;
  seen.add(node);
  if (typeof (node as PromiseLike<unknown>).then === "function") return propsOf(await node, type, found, seen);
  if (Array.isArray(node)) {
    await Promise.all(node.map((child) => propsOf(child, type, found, seen)));
    return found;
  }
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    if (node.type === type) found.push(props);
    await Promise.all(Object.values(props).map((value) => propsOf(value as ReactNode, type, found, seen)));
  }
  return found;
}

/** What each Two-step login on the page shows, drawn as the browser first gets it. */
async function twoStepShown(tree: unknown): Promise<string[]> {
  return (await propsOf(tree, TwoStepManager)).map((props) => renderToStaticMarkup(createElement(TwoStepManager, props as Parameters<typeof TwoStepManager>[0])));
}

/**
 * #2900, merged with main's ready cart link: a trial that ends while Today is drawn. The page counted itself in the
 * trial; the cart link's count then finds the billing month not known and reads it from Stripe and writes it, under
 * the store's lock, as do the writes after it. Synthetic Stripe replies only. `aligned`: the store already keeps the
 * token's platforms, so no platforms write is made.
 */
async function writeOrder(aligned: boolean): Promise<void> {
  const FOURTH = aligned ? "today-write-aligned@example.com" : "today-write-order@example.com";
  await claimHandle(FOURTH, aligned ? "todaywritealigned" : "todaywriteorder", "Today write order", "");
  const statsId = (await ensureStatsId(FOURTH))?.statsId;
  if (!statsId) throw new Error("setup: statsId");
  // A first page of free products, so the two paid ones are read from their records (lib/cart-link-products.ts):
  // only then is the count taken.
  for (let i = 0; i < 24; i += 1) await addProduct(FOURTH, `Free ${i}`, "", "0", null);
  await addProduct(FOURTH, "Paid one", "", "19", null);
  await addProduct(FOURTH, "Paid two", "", "29", null);
  await setPixels(FOURTH, { ...NO_PIXELS, meta: "123456789012345" });
  await redis.pipeline([["SET", `nl:adsrv:${statsId}`, JSON.stringify({ meta: "synthetic-sealed-token" })]]);
  // Codex M's case on #2900 (review comment 6701366711): the store already keeps the token's platforms, so the
  // ServerEvents part writes nothing, and the add-on's write must still come after the cart link's.
  if (aligned) await setAdsServer(FOURTH, ["meta"]);
  const realNow = Date.now;
  const startS = Math.floor(realNow() / 1000);
  await setSubscription(FOURTH, { customerId: "cus_TodayOrder01", subscriptionId: "sub_TodayOrder01", active: true, tier: "creator", trialEnds: startS + 60 });
  await setAssistantPlan(FOURTH, { subscriptionId: "sub_TodayAssist01", active: true, period: { start: startS - 40 * 86_400, end: startS - 10 * 86_400, renews: true }, cancelsAtEnd: false, disputedAt: "" });
  const fourthSession = await openSession(FOURTH);
  const ownerKey = `nl:store:owner:${hex(`nimbus-store:${FOURTH}`).slice(0, 40)}`;
  const groups: Record<string, string[]> = { plan: ["subscriptionActive", "trialEnds", "period"], ads: ["adsServer"], assistant: ["assistantPlan"] };
  const fieldsOf = (raw: unknown) => {
    const record = JSON.parse(String(raw)) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(groups).map(([name, keys]) => [name, JSON.stringify(keys.map((k) => record[k] ?? null))]));
  };
  const keptPipeline = redis.pipeline;
  let seen = fieldsOf((await keptPipeline.call(redis, [["GET", ownerKey]]))[0]);
  const writes: string[] = [];
  let shifted = false;
  let offset = 0;
  Date.now = () => realNow() + offset;
  redis.pipeline = async (commands) => {
    // The cart link's first read (lib/cart-link-products.ts weigh): from here on the trial has ended.
    if (!shifted && commands.some((c) => c[0] === "HMGET" && String(c[2] ?? "").startsWith("p:"))) {
      shifted = true;
      offset = 120_000;
    }
    // Each trip takes a while, as over a real network: a part with fewer trips before its write reaches the lock first.
    await new Promise((wait) => setTimeout(wait, 5));
    const reply = await keptPipeline.call(redis, commands);
    if (commands.some((c) => c[0] !== "GET" && c[0] !== "MGET" && c[0] !== "HMGET" && c[0] !== "HGETALL" && c[0] !== "STRLEN")) {
      const now = fieldsOf((await keptPipeline.call(redis, [["GET", ownerKey]]))[0]);
      // Counted from the cart link's first read: what the page's own loading wrote before it is not a part's write.
      for (const name of Object.keys(groups)) if (shifted && now[name] !== seen[name]) writes.push(name);
      seen = now;
    }
    return reply;
  };
  const stripePeriod = { current_period_start: startS + 60, current_period_end: startS + 60 + 30 * 86_400 };
  // The plan line and stop fields Stripe always sends with a subscription (CX-123 rule 24, lib/billing.ts stateOf).
  const creatorMonth = { lookup_key: "nimbus_labs_creator_month", unit_amount: 6900, recurring: { interval: "month" } };
  const keptFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("Unexpected external request: " + url.hostname);
    const method = init?.method ?? "GET";
    // Still in its trial when the page loads (so the page's own sync writes no billing month), paid once it ended.
    if (method === "GET" && url.pathname === "/v1/subscriptions/sub_TodayOrder01")
      return Response.json(
        shifted
          ? { id: "sub_TodayOrder01", status: "active", cancel_at: null, cancel_at_period_end: false, items: { data: [{ ...stripePeriod, price: creatorMonth }] } }
          : { id: "sub_TodayOrder01", status: "trialing", trial_end: startS + 60, cancel_at: null, cancel_at_period_end: false, items: { data: [{ current_period_start: startS - 86_400, current_period_end: startS + 60, price: creatorMonth }] } },
      );
    if (method === "GET" && url.pathname === "/v1/subscriptions/sub_TodayAssist01") return Response.json({ id: "sub_TodayAssist01", status: "active", cancel_at_period_end: false, items: { data: [stripePeriod] } });
    if (method === "GET") return Response.json({ object: "list", data: [], has_more: false });
    throw new Error("Unexpected provider operation: " + method + " " + url.pathname);
  }) as typeof fetch;
  const keptKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_today_write_order_only";
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${fourthSession}` } }));
  try {
    await words(await StudioPage({ searchParams: Promise.resolve({}) }));
  } finally {
    redis.pipeline = keptPipeline;
    globalThis.fetch = keptFetch;
    Date.now = realNow;
    if (keptKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = keptKey;
    answering(null);
  }
  is("the trial ended during the visit, at the cart link's first read", shifted, true);
  const order = aligned ? ["plan", "assistant"] : ["plan", "ads", "assistant"];
  is(aligned ? "the billing month and the add-on's month are each written once, the platforms not at all" : "the billing month, the platforms and the add-on's month are each written once", [...writes].sort(), [...order].sort());
  is("in the order Today wrote them one section after another", writes, order);
  const after = await storeForEmail(FOURTH);
  is("and each is in the store", [after?.trialEnds, after?.adsServer, after?.assistantPlan?.period?.end], [0, ["meta"], stripePeriod.current_period_end]);
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "today-removal@example.com";
  await claimHandle(OWNER, "todayremoval", "Today removal", "");
  await ensureStatsId(OWNER);
  await makePasskey(OWNER, "cred-today-due").keep();
  await makePasskey(OWNER, "cred-today-kept").keep();
  // Set to go seven days and a minute ago, its notice delivered then (lib/passkeys.ts writeDrop): its wait is over.
  const asked = Date.now() - REMOVAL_DAYS * 86_400_000 - 60_000;
  await redis.pipeline([["SET", `nl:pk:drop:${hex(`nimbus-passkey-drop:${OWNER}`).slice(0, 40)}`, JSON.stringify({ atOf: { "cred-today-due": asked + REMOVAL_DAYS * 86_400_000 }, told: asked })]]);
  const session = await openSession(OWNER);

  part("Today, with a passkey whose wait has run out");
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${session}` } }));
  let lists: string[][] = [];
  try {
    lists = await passkeyLists(await StudioPage({ searchParams: Promise.resolve({}) }));
  } finally {
    answering(null);
  }
  is("the page hands its passkey managers a list", lists.length > 0, true);
  is("the passkey that was removed is in none of them", lists.map((ids) => ids.includes("cred-today-due")), lists.map(() => false));
  is("the other passkey is in each", lists.map((ids) => ids.includes("cred-today-kept")), lists.map(() => true));
  is("and the removal was applied", (await listPasskeys(OWNER)).map((p) => p.id), ["cred-today-kept"]);

  // Codex M's case on #2835 (review 5806799980): the page's own removal read fails once before it runs, so the
  // removal is applied by the second-step checks instead; the list is still read only after them.
  part("Today, when the page's first removal read fails once");
  const SECOND = "today-removal-fault@example.com";
  await claimHandle(SECOND, "todayremovalfault", "Today removal fault", "");
  await ensureStatsId(SECOND);
  await makePasskey(SECOND, "cred-fault-due").keep();
  await makePasskey(SECOND, "cred-fault-kept").keep();
  const dropKey = `nl:pk:drop:${hex(`nimbus-passkey-drop:${SECOND}`).slice(0, 40)}`;
  await redis.pipeline([["SET", dropKey, JSON.stringify({ atOf: { "cred-fault-due": asked + REMOVAL_DAYS * 86_400_000 }, told: asked })]]);
  const secondSession = await openSession(SECOND);
  const original = redis.pipeline;
  let faulted = false;
  redis.pipeline = async (commands) => {
    if (!faulted && commands.length === 1 && commands[0]?.[0] === "GET" && commands[0]?.[1] === dropKey) {
      faulted = true;
      throw new Error("SYNTHETIC_DROP_READ_FAULT");
    }
    return original.call(redis, commands);
  };
  answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${secondSession}` } }));
  let faultLists: string[][] = [];
  try {
    faultLists = await passkeyLists(await StudioPage({ searchParams: Promise.resolve({}) }));
  } finally {
    redis.pipeline = original;
    answering(null);
  }
  is("the fault happened once, on the removal's first read", faulted, true);
  is("the page still hands its passkey managers a list", faultLists.length > 0, true);
  is("the removed passkey is in none of them", faultLists.map((ids) => ids.includes("cred-fault-due")), faultLists.map(() => false));
  is("and the removal was applied by the second-step checks", (await listPasskeys(SECOND)).map((p) => p.id), ["cred-fault-kept"]);

  // Two-step login on, with a request to turn it off without a code waiting three days (lib/two-step.ts askReset).
  const THIRD = "today-two-step@example.com";
  await claimHandle(THIRD, "todaytwostep", "Today two-step", "");
  await ensureStatsId(THIRD);
  // A passkey too, so the page would invite them to add an app's code if it took their two-step login for "off".
  await makePasskey(THIRD, "cred-today-two-step").keep();
  const recordKey = `nl:2fa:${hex(`nimbus-2fa:${THIRD}`).slice(0, 40)}`;
  const reset = Date.now() + 3 * 86_400_000;
  await redis.pipeline([["SET", recordKey, JSON.stringify({ s: "synthetic-secret", since: Date.now() - 86_400_000, codes: [], last: -1, reset, backup: "" })]]);
  const thirdSession = await openSession(THIRD);
  // The page's parts are waited for inside the request, as React waits for them (#2900).
  const render = async (fault: boolean): Promise<{ text: string; twoStep: string[]; invites: number }> => {
    const kept = redis.pipeline;
    if (fault)
      redis.pipeline = async (commands) => {
        if (commands.some((c) => c[0] === "GET" && c[1] === recordKey)) throw new Error("SYNTHETIC_TWO_STEP_READ_FAULT");
        return kept.call(redis, commands);
      };
    answering(new NextRequest("https://marktmorgen.com/studio", { headers: { cookie: `${SESSION_COOKIE}=${thirdSession}` } }));
    try {
      const tree = await StudioPage({ searchParams: Promise.resolve({}) });
      return { text: (await words(tree)).join(" "), twoStep: await twoStepShown(tree), invites: (await propsOf(tree, AppCodeInvite)).length };
    } finally {
      redis.pipeline = kept;
      answering(null);
    }
  };
  part("Today, with a request to turn two-step login off, read");
  const readPage = await render(false);
  const read = readPage.text;
  is("the warning says two-step login is set to turn off", read.includes("Two-step login is set to turn off"), true);
  is("and does not say it could not be read", read.includes("Two-step login could not be read just now"), false);

  part("Today, when the person's two-step login cannot be read");
  const unreadPage = await render(true);
  const unread = unreadPage.text;
  is("the page says plainly it could not be read", unread.includes("Two-step login could not be read just now"), true);
  is("and that a request to turn it off may be waiting", unread.includes("cannot tell whether somebody asked to turn your two-step login off"), true);
  is("the warning is not shown as fact", unread.includes("Two-step login is set to turn off"), false);
  is("and it names Cancel only for once the request shows", unread.includes("Once it shows, if a request is waiting and it was not you, press Cancel"), true);
  is("the request is still there", JSON.parse(String((await redis.pipeline([["GET", recordKey]]))[0])).reset, reset);

  part("Two-step login below, read");
  const readShown = readPage.twoStep;
  is("the page shows Two-step login", readShown.length > 0, true);
  is("it says two-step login is on", readShown.map((html) => html.includes("On. Logging in with the emailed link also asks")), readShown.map(() => true));
  is("and offers to cancel the request", readShown.map((html) => html.includes("Cancel: keep two-step login on")), readShown.map(() => true));
  is("no invitation to add an app's code: it is on", readPage.invites, 0);

  part("Two-step login below, when it cannot be read");
  const unreadShown = unreadPage.twoStep;
  is("the page still shows Two-step login", unreadShown.length > 0, true);
  is("where the banner's link goes", unreadShown.map((html) => html.includes('id="two-step"')), unreadShown.map(() => true));
  is("it says it could not be read", unreadShown.map((html) => html.includes("Two-step login could not be read just now")), unreadShown.map(() => true));
  is("it is not said to be off", unreadShown.map((html) => html.includes("After the emailed link, ask for a six-digit code")), unreadShown.map(() => false));
  is("it offers no way to turn it on over it", unreadShown.map((html) => html.includes("Turn on two-step login")), unreadShown.map(() => false));
  is("nor asks to log in again to turn it on", unreadShown.map((html) => html.includes("Turning this on needs a login")), unreadShown.map(() => false));
  is("nor any other button or form, on a state it does not know", unreadShown.map((html) => /<button|<form/.test(html)), unreadShown.map(() => false));
  is("no invitation to add an app's code", unreadPage.invites, 0);
  is("and the record is untouched", JSON.parse(String((await redis.pipeline([["GET", recordKey]]))[0])).s, "synthetic-secret");

  // Claude 5's LEVE 1 on #2835: "Update now" (numbers=fresh) reads the store's numbers again from the day's own
  // budget (lib/store-readings.ts takeStoreReading). Sent together with the other reads, that reading was taken
  // even when a read the page waits for failed and the page ended in its error; it waits for them now.
  // And the products the numbers name (Claude 5's residual LEVE on #2835) are read after that reading, from what it
  // read: one outside the catalog's head (here hidden, so not on the first page) is read from its own record, and a
  // failure there came after the day's reading was spent and ended the page in its error.
  type Fault = "none" | "shelf" | "listing";
  const freshPage = async (owner: string, fault: Fault): Promise<{ loaded: boolean; spent: number; faults: number; panels: Record<string, unknown>[] }> => {
    await claimHandle(owner, owner.split("@")[0].replace(/[^a-z]/g, ""), "Today fresh", "");
    await ensureStatsId(owner);
    await addProduct(owner, "Guide", "", "19", null);
    let listing = "";
    if (fault !== "shelf") {
      const added = await addProduct(owner, "Hidden guide", "", "29", null);
      if (!added.ok) throw new Error("synthetic product not added");
      const hidden = await setProductHidden(owner, added.product.id, true);
      if (!hidden.ok) throw new Error("synthetic product not hidden");
      const store = (await storeForEmail(owner))!;
      is(`${owner}: the hidden product is outside the catalog's head (precondition)`, !store.catalog.inline && Boolean(store.catalog.id) && !store.catalog.head.some((l) => l.id === added.product.id), true);
      listing = `nl:catalog:${store.catalog.id}:l:${added.product.id}`;
    }
    const ownerSession = await openSession(owner);
    const kept = redis.pipeline;
    let spent = 0;
    let faults = 0;
    redis.pipeline = async (commands) => {
      if (commands.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:reading:day:"))) spent += 1;
      if (fault === "shelf" && commands.some((c) => c[0] === "GET" && String(c[1]).startsWith("nl:catalog:"))) throw new Error("SYNTHETIC_PRODUCTS_READ_FAULT");
      if (fault === "listing" && spent > 0 && commands.some((c) => c[0] === "GET" && String(c[1]) === listing)) {
        faults += 1;
        throw new Error("SYNTHETIC_LISTING_READ_FAULT");
      }
      return kept.call(redis, commands);
    };
    answering(new NextRequest("https://marktmorgen.com/studio?numbers=fresh", { headers: { cookie: `${SESSION_COOKIE}=${ownerSession}` } }));
    let loaded = true;
    let panels: Record<string, unknown>[] = [];
    try {
      const tree = await StudioPage({ searchParams: Promise.resolve({ numbers: "fresh" }) });
      await words(tree);
      panels = await propsOf(tree, StatsPanel);
    } catch {
      loaded = false;
    } finally {
      redis.pipeline = kept;
      answering(null);
    }
    return { loaded, spent, faults, panels };
  };
  const productTitles = (panels: Record<string, unknown>[]) =>
    panels.map((props) => (props.data as { products: { title: string }[] }).products.map((p) => p.title));
  part("Update now, when a read the page waits for fails");
  const failing = await freshPage("todayfreshfault@example.com", "shelf");
  is("the page ends in its error (precondition)", failing.loaded, false);
  is("the day's reading is not taken for it", failing.spent, 0);
  part("Update now, when every read answers");
  const healthy = await freshPage("todayfreshok@example.com", "none");
  is("the page loads", healthy.loaded, true);
  is("and the numbers are read again, from the day's budget", healthy.spent, 1);
  is("and they name both products, the one outside the head read from its record", productTitles(healthy.panels), [["Guide", "Hidden guide"]]);
  part("Update now, when the products the numbers name fail after the day's reading");
  const late = await freshPage("todayfreshlate@example.com", "listing");
  is("the reading was taken, and the products' read failed after it (precondition)", [late.spent, late.faults > 0], [1, true]);
  is("the page does not end in its error for it", late.loaded, true);
  is("the numbers wait, as when they could not be read, rather than name a product gone or leave one out", late.panels.length, 0);

  part("Today's store writes, when the billing month is read again during the visit");
  await writeOrder(false);
  part("Today's store writes, when the token's platforms are already in the store");
  await writeOrder(true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
