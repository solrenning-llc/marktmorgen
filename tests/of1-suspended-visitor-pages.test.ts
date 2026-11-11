/**
 * 662 [OF1], the pages of a store open to any visitor: a store switched off
 * after notices about its content (lib/takedown.ts, `store.suspended`) shows
 * the same "not available" page as the store's own page (StoreResting with
 * `suspended`) on each of them, and nothing of the store's products, prices
 * or forms; its manifest and its crawler rules answer 404, kept by no cache,
 * as its sitemap does. Switched back on, each comes back as it was. The ways
 * a person already has (taking an address off a waitlist, moving a paid
 * booking) stay open. Through the real pages and routes, on a synthetic store.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import BookPage, { generateMetadata as bookMeta } from "@/app/[handle]/book/[product]/page";
import FreePage, { generateMetadata as freeMeta } from "@/app/[handle]/free/page";
import JoinPage, { generateMetadata as joinMeta } from "@/app/[handle]/join/page";
import LeftPage, { generateMetadata as leftMeta } from "@/app/[handle]/left/page";
import ReviewsPage, { generateMetadata as reviewsMeta } from "@/app/[handle]/p/[product]/reviews/page";
import ReviewPage, { generateMetadata as reviewMeta } from "@/app/[handle]/review/page";
import WaitlistPage, { generateMetadata as waitlistMeta } from "@/app/[handle]/waitlist/page";
import { GET as manifest } from "@/app/[handle]/manifest.webmanifest/route";
import { GET as robots } from "@/app/[handle]/store-robots/route";
import { StoreResting } from "@/components/store-resting";
import { StoreTracking } from "@/components/store-tracking";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, noteTakedown, setProductCall, setStripeAccount, setSubscription } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { answering } from "./security/next-headers";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Query = Record<string, string>;
type Out = { node: unknown } | { redirect: string } | { notFound: true };

/** A page's answer: what it draws, or where it sends the visitor. */
async function answer(run: () => Promise<unknown>): Promise<Out> {
  try {
    return { node: await run() };
  } catch (error) {
    const digest = String((error as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] ?? "" };
    if (digest.includes(";404")) return { notFound: true };
    throw error;
  }
}

/** The store's "not available" page, as the store's own page draws it. */
const suspendedPage = (out: Out) => {
  if (!("node" in out)) return false;
  const node = out.node as { type?: unknown; props?: { suspended?: boolean } } | null;
  return node?.type === StoreResting && node.props?.suspended === true;
};

async function html(out: Out): Promise<string> {
  if (!("node" in out)) return "";
  const stream = await renderToReadableStream(out.node as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/**
 * Whether a page's tree carries the creator's ad pixels and the visit count (StoreTracking). The
 * page's own components (the booking page's MovePage and Shell) are drawn to see inside them; a
 * component that cannot be drawn outside React (a hook) is left as it is. Its HTML cannot say:
 * the pixels and the beacon draw nothing on the server, only in the browser.
 */
async function tracks(node: unknown): Promise<boolean> {
  if (Array.isArray(node)) {
    for (const child of node) if (await tracks(child)) return true;
    return false;
  }
  if (!node || typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === StoreTracking) return true;
  if (typeof el.type === "function") {
    try {
      if (await tracks(await (el.type as (props: unknown) => unknown)(el.props))) return true;
    } catch {
      // A client component: nothing of the store's tracking is drawn from inside it.
    }
  }
  return tracks(el.props?.children ?? null);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_of1_pages";
  const owner = "of1-pages@example.test";
  await claimHandle(owner, "glazeworks", "Glaze Works", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1TestGlaze0001", true);
  await setSubscription(owner, { customerId: "cus_of1pages", subscriptionId: "sub_of1pages", active: true, tier: "creator", period: paidPeriod() });
  const paid = await addProduct(owner, "Glaze Workshop Replay", "", "29", null);
  const free = await addProduct(owner, "Free Glaze Guide", "", "0", null);
  const call = await addProduct(owner, "Studio Call With Ana", "", "45", null);
  if (!paid.ok || !free.ok || !call.ok) throw new Error("product fixtures were not created");
  const weekly = { kind: "weekly", minutes: 30, tz: "America/New_York", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 14, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };
  await setProductCall(owner, call.product.id, readSetup(weekly) as CallSetup);
  const handle = "@glazeworks";
  const titles = ["Glaze Workshop Replay", "Free Glaze Guide", "Studio Call With Ana"];

  const ask = (path: string, query: Query) => answering(new NextRequest(`https://marktmorgen.com/${handle}${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`));
  const pages: { name: string; path: string; query: Query; run: (query: Query) => Promise<unknown>; meta: () => Promise<{ title?: unknown; robots?: unknown }> }[] = [
    { name: "the booking page of a call", path: `/book/${call.product.id}`, query: {}, run: (q) => BookPage({ params: Promise.resolve({ handle, product: call.product.id }), searchParams: Promise.resolve(q) }), meta: () => bookMeta({ params: Promise.resolve({ handle, product: call.product.id }), searchParams: Promise.resolve({}) }) },
    { name: "the free copy's page", path: "/free", query: { status: "sent", product: free.product.id }, run: (q) => FreePage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(q) }), meta: () => freeMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }) },
    { name: "the sign-up box's page", path: "/join", query: { status: "sent" }, run: (q) => JoinPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(q) }), meta: () => joinMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }) },
    { name: "the way back from an unpaid checkout", path: "/left", query: { p: paid.product.id }, run: (q) => LeftPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(q) }), meta: () => leftMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }) },
    { name: "the list of a product's reviews", path: `/p/${paid.product.id}/reviews`, query: {}, run: (q) => ReviewsPage({ params: Promise.resolve({ handle, product: paid.product.id }), searchParams: Promise.resolve(q) }), meta: () => reviewsMeta({ params: Promise.resolve({ handle, product: paid.product.id }), searchParams: Promise.resolve({}) }) },
    { name: "the page to write a review", path: "/review", query: { status: "sent", product: paid.product.id }, run: (q) => ReviewPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(q) }), meta: () => reviewMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }) },
    { name: "the waitlist's page", path: "/waitlist", query: { status: "sent", product: paid.product.id }, run: (q) => WaitlistPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(q) }), meta: () => waitlistMeta({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) }) },
  ];
  const open = async (page: (typeof pages)[number], query = page.query) => {
    ask(page.path, query);
    return answer(() => page.run(query));
  };
  const file = async (route: typeof manifest | typeof robots, path: string) => {
    const response = await route(new NextRequest(`https://marktmorgen.com/${handle}${path}`), { params: Promise.resolve({ handle }) });
    return [response.status, response.headers.get("cache-control")];
  };

  part("A store switched off after a report (lib/takedown.ts)");
  await noteTakedown(owner, null, true);
  for (const page of pages) {
    const out = await open(page);
    is(`${page.name} says the store is not available, as the store's page does`, suspendedPage(out), true);
    const drawn = await html(out);
    is(`${page.name} shows none of the store's products, prices or forms`, [titles.some((t) => drawn.includes(t)), drawn.includes("$29") || drawn.includes("$45"), drawn.includes("<form")], [false, false, false]);
    ask(page.path, {});
    const meta = await page.meta();
    const title = String(meta.title ?? "");
    is(`${page.name}'s title names no product and not the store`, [titles.some((t) => title.includes(t)), title.includes("Glaze Works")], [false, false]);
    // Its robots.txt is now 404 (crawl allowed), so each page drawn at 200 asks on its own not to be indexed.
    const robotsMeta = meta.robots as { index?: unknown } | undefined;
    is(`${page.name} asks not to be indexed while the store is switched off`, robotsMeta?.index, false);
  }
  is("the store's app manifest is not given, kept by no cache", await file(manifest, "/manifest.webmanifest"), [404, "no-store"]);
  is("nor the rules for crawlers on its own domain", await file(robots, "/store-robots"), [404, "no-store"]);

  part("What a person already has stays open");
  const waitlist = pages.find((p) => p.path === "/waitlist")!;
  is("the waitlist's page still offers to take an address off the list", suspendedPage(await open(waitlist, { leave: "x".repeat(24) })), false);
  is("and says it was taken off", suspendedPage(await open(waitlist, { status: "left", product: paid.product.id })), false);
  is("the booking page still lets a paid booking be moved, the buyer's own", suspendedPage(await open(pages[0], { move: "cs_test_of1move000000" })), false);
  // What stays open names nothing a product's id in the address asks for: anyone who saw an old link has the id.
  const left = await open(waitlist, { status: "left", product: paid.product.id });
  const leftDrawn = await html(left);
  is("the page that says an address was taken off names no product from the address", [titles.some((t) => leftDrawn.includes(t)), leftDrawn.includes("See Glaze")], [false, false]);
  const badLeave = await open(waitlist, { leave: "x".repeat(24), product: paid.product.id });
  is("nor does a link to leave that is not one", [(await html(badLeave)).includes("Glaze Workshop Replay"), (await html(badLeave)).includes("See Glaze")], [false, false]);
  const badToken = await open(waitlist, { leave: "a".repeat(48), product: paid.product.id });
  is("nor one shaped like a link to leave that the list does not know", [suspendedPage(badToken), (await html(badToken)).includes("Glaze Workshop Replay")], [false, false]);
  // Leaving failed (app/api/store/waitlist/leave/route.ts): the person is told the address is still on the list.
  const expired = await open(waitlist, { status: "expired", product: paid.product.id });
  const expiredDrawn = await html(expired);
  is("a failed leave still says the link has expired, naming no product", [suspendedPage(expired), expiredDrawn.includes("This link has expired"), expiredDrawn.includes("Glaze Workshop Replay")], [false, true, false]);
  // A real link to leave still takes the address off, and says what it is for, from the link itself.
  const leaveToken = "b".repeat(48);
  const stats = (await ensureStatsId(owner))!.statsId;
  await redis.pipeline([["SET", waitlistTokenKey(leaveToken), JSON.stringify({ s: stats, h: "glazeworks", p: paid.product.id, e: "buyer@example.test", k: "leave" })]]);
  const realLeave = await open(waitlist, { leave: leaveToken, product: free.product.id });
  const realDrawn = await html(realLeave);
  is("a real link to leave still offers its button, naming the product it was for", [realDrawn.includes("<form"), realDrawn.includes("Glaze Workshop Replay"), realDrawn.includes("Free Glaze Guide")], [true, true, false]);
  is("and links to no product page of a store switched off", realDrawn.includes("See Glaze"), false);
  // Nothing of the creator's ad pixels or the visit count runs on what stays open.
  is("the waitlist's open pages carry no ad pixels or visit count", [await tracks((left as { node: unknown }).node), await tracks((badLeave as { node: unknown }).node), await tracks((expired as { node: unknown }).node), await tracks((realLeave as { node: unknown }).node)], [false, false, false, false]);
  is("nor does moving a booking, even from a link that is not one", await tracks((await open(pages[0], { move: "cs_test_of1move000000" }) as { node: unknown }).node), false);

  part("Switched back on, every page is as it was");
  await noteTakedown(owner, null, false);
  for (const page of pages) {
    is(`${page.name} is drawn again`, suspendedPage(await open(page)), false);
  }
  is("the booking page shows the call again", (await html(await open(pages[0]))).includes("Studio Call With Ana"), true);
  is("the way back from checkout shows the product again", (await html(await open(pages[3]))).includes("Glaze Workshop Replay"), true);
  is("the booking page's title names the call again", String((await pages[0].meta()).title).includes("Studio Call With Ana"), true);
  is("the waitlist's page carries the store's tracking again", await tracks((await open(waitlist, { status: "left", product: paid.product.id }) as { node: unknown }).node), true);
  is("and names the product again", (await html(await open(waitlist, { status: "left", product: paid.product.id }))).includes("Glaze Workshop Replay"), true);
  is("as does moving a booking", await tracks((await open(pages[0], { move: "cs_test_of1move000000" }) as { node: unknown }).node), true);
  is("the manifest is given again", (await file(manifest, "/manifest.webmanifest"))[0], 200);
  is("and the rules for crawlers", (await file(robots, "/store-robots"))[0], 200);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
