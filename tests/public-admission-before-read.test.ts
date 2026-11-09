/**
 * A public store page pays for itself before it reads (traffic audit, 9 November 2026; owner's rule MR: a ceiling
 * before every spend). Two findings, both read with no request of the store's window taken first:
 *
 *   ALTO 1   app/[handle]/book/[product]/page.tsx asked the creator's Stripe account (lib/calls.ts readBusy: up to
 *            five pages of checkouts and five disputes) on every load, and on every made-up `?move=`, without
 *            isResting or takePublicRequest, even with the store's window used up. A robot without JavaScript
 *            never sends the presence beacon, so nothing counted it.
 *   MEDIO 3  generateMetadata read before the store's admission: the product's sales page and description
 *            (app/[handle]/p/[product]), a blog post (blog/[post]) and a published email (letters/[letter]), so a
 *            store resting past its window still read them on every request.
 *
 * Each check marked "(fact)" holds on main as well; every other check fails there.
 */
import { StoreResting } from "@/components/store-resting";
import BookPage, { generateMetadata as bookMeta } from "@/app/[handle]/book/[product]/page";
import ProductPage, { generateMetadata as productMeta } from "@/app/[handle]/p/[product]/page";
import { generateMetadata as postMeta } from "@/app/[handle]/blog/[post]/page";
import { generateMetadata as letterMeta } from "@/app/[handle]/letters/[letter]/page";
import { readSetup, type CallSetup } from "@/lib/call-setup";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setProductPage, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { answering } from "./security/next-headers";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let stripe = 0;
// The window's units taken when the creator's Stripe account was first asked, on the load being watched.
let unitsAtFirstStripe: number | null = null;
let unitsNow = 0;
globalThis.fetch = (async () => {
  stripe += 1;
  if (unitsAtFirstStripe === null) unitsAtFirstStripe = unitsNow;
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_public_admission";

const NY = "America/New_York";
const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = { kind: "weekly", minutes: 30, tz: NY, weekly: WEEKDAYS, noticeHours: 1, horizonDays: 14, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] };

type Watched = { commands: number; units: number; stripe: number; bytes: number; named: number; firstStripeAt: number | null; result: unknown };

/** Runs one request, counting its Redis commands, the window's units it took, its Stripe calls and the bytes Redis answered. */
async function watch(ip: string, path: string, run: () => Promise<unknown>, name = "\u0000"): Promise<Watched> {
  answering(new Request(`https://marktmorgen.com${path}`, { headers: { "x-forwarded-for": ip, "user-agent": "curl/8" } }));
  const original = redis.pipeline.bind(redis);
  let commands = 0, bytes = 0, named = 0;
  const before = stripe;
  unitsNow = 0;
  unitsAtFirstStripe = null;
  redis.pipeline = async (cmds) => {
    commands += cmds.length;
    for (const c of cmds) {
      if (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) unitsNow += Number(c[2]);
      if (c.some((part) => String(part).includes(name))) named += 1;
    }
    const out = await original(cmds);
    bytes += Buffer.byteLength(JSON.stringify(out ?? null));
    return out;
  };
  let result: unknown = null;
  try {
    result = await run();
    // The move page is an async server component the page returns: Next runs it while drawing; here, by hand.
    const el = result as { type?: unknown; props?: unknown } | null;
    if (el && typeof el.type === "function" && (el.type as { name?: string }).name === "MovePage") result = await (el.type as (p: unknown) => Promise<unknown>)(el.props);
  } catch {
    // redirect() or notFound(): what counts here is what was read.
  } finally {
    redis.pipeline = original;
  }
  return { commands, units: unitsNow, stripe: stripe - before, bytes, named, firstStripeAt: unitsAtFirstStripe, result };
}

const resting = (result: unknown) => (result as { type?: unknown } | null)?.type === StoreResting;

async function shop(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, `Store ${handle}`, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner)) as Store;
}

async function main(): Promise<void> {
  redis.clear();

  // ---- The booking page ------------------------------------------------------------------------------------------
  const BOOK = "admitbook@example.com";
  await shop(BOOK, "admitbook");
  await setStripeAccount(BOOK, "acct_1TestAdmitBook01", true);
  const call = await addProduct(BOOK, "Coaching", "", "45", null);
  if (!call.ok) throw new Error("setup");
  await setProductCall(BOOK, call.product.id, readSetup(weekly) as CallSetup);
  const booking = (await storeForEmail(BOOK)) as Store;
  const book = (query: Record<string, string>, ip: string) =>
    watch(ip, `/@admitbook/book/${call.product.id}`, () => BookPage({ params: Promise.resolve({ handle: "@admitbook", product: call.product.id }), searchParams: Promise.resolve(query) }));

  part("A booking page with the store's window open");
  const open = await book({}, "198.51.100.7");
  is("(fact) the page asks the creator's Stripe account for its times", open.stripe >= 1, true);
  is("the page takes the store's requests before Stripe is asked (at least the page and its times)", (open.firstStripeAt ?? 0) >= 2, true);
  is("(fact) the page is drawn, not resting", resting(open.result), false);

  part("The store's public requests used up (its buyers' share left)");
  const publicLimit = publicVisitLimit(requestLimitFor(booking));
  await takePublicRequest(booking, "public", Date.now(), publicLimit, { shared: true });
  is("(fact) the public share is used up: a public request is refused", await takePublicRequest(booking, "public", Date.now(), 1, { shared: true }), false);
  let calls = 0, commands = 0, rested = 0;
  for (let i = 0; i < 50; i += 1) {
    const r = await book({}, `203.0.113.${i}`);
    calls += r.stripe;
    commands += r.commands;
    if (resting(r.result)) rested += 1;
  }
  console.log(`  measured: 50 loads -> ${calls} Stripe calls, ${commands} Redis commands, ${rested} resting`);
  is("50 loads ask Stripe nothing", calls, 0);
  is("50 loads read Redis only for their admission (at most 10 commands each)", commands <= 50 * 10, true);
  is("each load shows the resting page", rested, 50);
  const title = await watch("203.0.113.90", "/", () => bookMeta({ params: Promise.resolve({ handle: "@admitbook", product: call.product.id }), searchParams: Promise.resolve({}) }));
  is("the tab title says the page rests, and names no call", (title.result as { title?: string } | null)?.title, `${speech(booking).w.restingTitle} — ${booking.name}`);

  part("A booking's move page is the buyer's: it stays open while the public pages rest");
  const move = await book({ move: `cs_test_${"b".repeat(24)}` }, "203.0.113.150");
  is("the move counts against the store's window before Stripe is asked", (move.firstStripeAt ?? 0) >= 1, true);
  is("(fact) its checkout is read once", move.stripe, 1);
  is("it is not the resting page", resting(move.result), false);

  part("The store's whole window used up: made-up moves");
  await takePublicRequest(booking, "buyer", Date.now(), requestLimitFor(booking), { shared: true });
  is("(fact) the rest of the window taken: a buyer's request is refused", await takePublicRequest(booking, "buyer", Date.now(), 1, { shared: true }), false);
  let moved = 0, movedResting = 0;
  for (let i = 0; i < 25; i += 1) {
    const r = await book({ move: `cs_test_${"a".repeat(20)}${i}` }, "203.0.113.200");
    moved += r.stripe;
    if (resting(r.result)) movedResting += 1;
  }
  console.log(`  measured: 25 made-up moves -> ${moved} Stripe calls`);
  is("25 made-up moves ask Stripe nothing", moved, 0);
  is("each shows the resting page", movedResting, 25);

  // ---- The product page's title ----------------------------------------------------------------------------------
  const PROD = "admitprod@example.com";
  const product = await shop(PROD, "admitprod");
  const guide = await addProduct(PROD, "Guide", "", "19", null);
  if (!guide.ok) throw new Error("setup");
  await setProductPage(PROD, guide.product.id, true);
  // A sales page as large as is kept (MAX_PAGE_BYTES = 120,000), written straight to its key.
  redis.run(["SET", `nl:product:page:${product.statsId}:${guide.product.id}`, JSON.stringify({ v: 1, blocks: [{ id: "t", kind: "text", text: "x".repeat(119_000) }], seoTitle: "", seoDescription: "" })]);

  part("A product page with the store's window open");
  const healthy = await watch("198.51.100.8", "/", () => productMeta({ params: Promise.resolve({ handle: "@admitprod", product: guide.product.id }) } as never));
  is("(fact) its title names the product", String((healthy.result as { title?: string } | null)?.title ?? "").startsWith("Guide"), true);
  is("the title's reading is paid for: one request of the window", healthy.units, 1);

  part("A product page with the store's window used up");
  await takePublicRequest(product, "buyer", Date.now(), requestLimitFor(product), { shared: true });
  is("(fact) the window is used up: a buyer's request is refused", await takePublicRequest(product, "buyer", Date.now(), 1, { shared: true }), false);
  let bytes = 0, metaRested = 0;
  for (let i = 0; i < 50; i += 1) {
    const r = await watch(`203.0.113.${i}`, "/", () => productMeta({ params: Promise.resolve({ handle: "@admitprod", product: guide.product.id }) } as never));
    bytes += r.bytes;
    if ((r.result as { title?: string } | null)?.title === `${speech(product).w.restingTitle} — ${product.name}`) metaRested += 1;
  }
  console.log(`  measured: 50 titles -> ${bytes} bytes answered by Redis`);
  is("50 titles do not read the sales page (under 10 KB each)", bytes < 50 * 10_000, true);
  is("each title says the page rests", metaRested, 50);
  const body = await watch("203.0.113.99", "/", () => ProductPage({ params: Promise.resolve({ handle: "@admitprod", product: guide.product.id }), searchParams: Promise.resolve({}) } as never));
  is("(fact) the page itself rests", resting(body.result), true);

  // ---- A blog post's and a published email's titles --------------------------------------------------------------
  const POSTS = "admitpost@example.com";
  const posts = await shop(POSTS, "admitpost");
  is("(fact) the window taken", await takePublicRequest(posts, "buyer", Date.now(), requestLimitFor(posts), { shared: true }), true);
  const POST_ID = "0a1b2c3d4e";
  const post = await watch("203.0.113.120", "/", () => postMeta({ params: Promise.resolve({ handle: "@admitpost", post: `a-post-${POST_ID}` }) }), POST_ID);
  is("with the window used up, a post's title reads no post", post.named, 0);
  const LETTER_ID = "0123456789abcdef0123";
  const letter = await watch("203.0.113.121", "/", () => letterMeta({ params: Promise.resolve({ handle: "@admitpost", letter: LETTER_ID }), searchParams: Promise.resolve({}) }), LETTER_ID);
  is("with the window used up, an email's title reads no email", letter.named, 0);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
