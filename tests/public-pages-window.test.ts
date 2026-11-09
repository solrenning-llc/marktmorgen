/**
 * Review of #3331, LEVE 2 (rule 30, siblings of R20 finding 3): the sign-up
 * box's page (app/[handle]/join), the wait-list page (app/[handle]/waitlist)
 * and a store's own page (app/[handle]/[slug]) answered the public without
 * taking a request of the store's window (lib/traffic.ts, isResting), so
 * neither the store's month (requestLimitFor) nor one connection's share of
 * the day (clientDayShare) bounded the reads behind them (a link's token, a
 * product, a page's blocks and forms), and they kept answering after the
 * store's public pages rest.
 *
 * Checked, with the real pages against the in-memory Redis:
 * - each drawing of each page takes a request of the window, as the store
 *   page does (the control);
 * - with the public share of the window used up, they rest with the store,
 *   before any token, product or page is read;
 * - the way to take an address off a wait list stays open past the public
 *   share, on the share kept for what people already have (who: "buyer"),
 *   still counted, and rests only when the whole window is used.
 *
 * Synthetic store; nothing real is called.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import StorePage from "@/app/[handle]/page";
import JoinPage from "@/app/[handle]/join/page";
import WaitlistPage from "@/app/[handle]/waitlist/page";
import StoreOwnPage from "@/app/[handle]/[slug]/page";
import { addProduct, claimHandle, ensureStatsId, setSitePages, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { parsePage } from "@/lib/sales-page";
import { siteKey } from "@/lib/site-page-rules";
import { waitlistTokenKey } from "@/lib/waitlist-tokens";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "public-pages-window@example.com";
const HANDLE = "ppwindow";
const DRAWS = 25;
const PAGE_ID = "ppwpage001";
const PAGE_SLUG = "about";
const PAGE_WORDS = "Kiln notes for the public";

async function drawn(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    return `thrown ${String((error as { digest?: unknown }).digest ?? error)}`;
  }
}

/** Every command sent while `run` draws, and the units of the store's window it took. */
async function watched<T>(run: () => Promise<T>): Promise<{ out: T; units: number; commands: unknown[][] }> {
  const original = redis.pipeline.bind(redis);
  let units = 0;
  const commands: unknown[][] = [];
  redis.pipeline = async (list) => {
    for (const c of list) {
      commands.push(c);
      if (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) units += Number(c[2]);
    }
    return original(list);
  };
  try {
    return { out: await run(), units, commands };
  } finally {
    redis.pipeline = original;
  }
}

/** Units of the store's window taken while `run` draws DRAWS times. */
async function measured(run: (k: number) => Promise<string>): Promise<{ answered: number; units: number }> {
  let answered = 0;
  const { units } = await watched(async () => {
    for (let k = 0; k < DRAWS; k++) if (!(await run(k)).startsWith("thrown")) answered += 1;
  });
  return { answered, units };
}

/** Each drawing comes from its own page's connection, so no connection's share of the day is what refuses it. */
const ask = (path: string, ip: string) => answering(new NextRequest(`https://marktmorgen.com${path}`, { headers: { "x-forwarded-for": ip } }));
const hex48 = (k: number) => `${String(k).padStart(4, "0")}${"ab".repeat(22)}`;
/** A read of a link's token, a product's listing or a page's blocks: none may happen while the page rests. */
const READS = /^nl:(join:t:|wl:t:|catalog:[^:]+:l:|product:page:)/;
/** The keys of those reads among the commands sent, by family, whatever the command (GET, MGET, STRLEN...). */
const readsIn = (commands: unknown[][]) => commands.flatMap((c) => c.slice(1).filter((a) => READS.test(String(a))).map((a) => String(a).split(":").slice(0, 3).join(":")));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Public Pages Window", "Pots.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ppwindow01", subscriptionId: "sub_ppwindow01", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_ppwindow000001", true);
  const made = await addProduct(OWNER, "Glazing course", "", "0", null);
  if (!made.ok) throw new Error("product fixture was not created");
  const productId = made.product.id;
  await setSitePages(OWNER, [{ id: PAGE_ID, slug: PAGE_SLUG, title: "About", nav: false, target: "", from: 0 }]);
  const store = (await storeForEmail(OWNER))!;
  await writePage(store.statsId!, siteKey(PAGE_ID), { ...parsePage({}), blocks: [{ id: "blk001", kind: "text", heading: "", body: PAGE_WORDS }] } as never, ROOM);
  // A real link to take an address off the wait list (lib/waitlist.ts, joinWaitlist writes the same grant).
  const leave = randomBytes(24).toString("hex");
  await redis.pipeline([["SET", waitlistTokenKey(leave), JSON.stringify({ s: store.statsId, h: store.handle, p: productId, e: "ada@example.com", k: "leave" }), "EX", 3_600]]);
  const handle = `@${HANDLE}`;
  const g = givingWords(store.language);

  const join = (query: Record<string, string>) => () => JoinPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(query) });
  const wait = (query: Record<string, string>) => () => WaitlistPage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve(query) });
  const own = (query: Record<string, string>) => () => StoreOwnPage({ params: Promise.resolve({ handle, slug: PAGE_SLUG }), searchParams: Promise.resolve(query) });
  const qs = (query: Record<string, string>) => new URLSearchParams(query).toString();

  // [name, address and arguments for drawing k, whether it is the way off a wait list]
  const pages: [string, (k: number) => Record<string, string>, (q: Record<string, string>) => () => Promise<unknown>, string, boolean][] = [
    ["join page, a link's confirm button", (k) => ({ token: hex48(k) }), join, "join", false],
    ["join page, check your inbox", (k) => ({ status: "sent", x: String(k) }), join, "join", false],
    ["wait-list page, a link's confirm button", (k) => ({ token: hex48(k) }), wait, "waitlist", false],
    ["wait-list page, check your inbox for a product", (k) => ({ status: "sent", product: productId, x: String(k) }), wait, "waitlist", false],
    ["wait-list page, the way off the list", (k) => ({ leave: k === 0 ? leave : hex48(k) }), wait, "waitlist", true],
    ["wait-list page, taken off", (k) => ({ status: "left", product: productId, x: String(k) }), wait, "waitlist", true],
    ["the store's own page", (k) => ({ x: String(k) }), own, PAGE_SLUG, false],
  ];
  const draw = (i: number, k: number) => {
    const [, query, page, path] = pages[i];
    const q = query(k);
    ask(`/@${HANDLE}/${path}?${qs(q)}`, `203.0.113.${20 + i}`);
    return drawn(page(q));
  };

  part("The store's own front page takes a request of the window each time (control)");
  const front = await measured((k) => { ask(`/@${HANDLE}?x=${k}`, "203.0.113.9"); return drawn(() => StorePage({ params: Promise.resolve({ handle }), searchParams: Promise.resolve({}) } as never)); });
  is("the store page is answered and counted", front.answered === DRAWS && front.units >= DRAWS, true);

  part("The pages draw what they drew before (healthy path)");
  is("the store's own page shows its blocks", (await draw(6, 900)).includes(PAGE_WORDS), true);
  is("a real link off the wait list shows its button", (await draw(4, 0)).includes(g.removeButton), true);

  part(`${DRAWS} drawings of each page, each at its own address`);
  for (let i = 0; i < pages.length; i++) {
    const m = await measured((k) => draw(i, k));
    is(`${pages[i][0]}: answered every time`, m.answered, DRAWS);
    is(`${pages[i][0]}: each drawing takes a request of the store's window`, m.units >= DRAWS, true);
  }

  part("With the public share of the window used up, the pages rest with the store, before reading anything");
  const whole = requestLimitFor(store);
  const probe = await watched(() => takePublicRequest(store, "buyer", Date.now(), 1, { shared: true }));
  const used = Number((await redis.pipeline([["GET", String(probe.commands.find((c) => c[0] === "INCRBY")?.[1])]]))[0]);
  await takePublicRequest(store, "buyer", Date.now(), publicVisitLimit(whole) - used, { shared: true });
  is("the store's public pages rest", await isResting(store), true);
  const restingTitle = speech(store).w.restingTitle;
  for (let i = 0; i < pages.length; i++) {
    const [name, , , , removal] = pages[i];
    const { out, units, commands } = await watched(() => draw(i, i === 4 ? 0 : 500 + i));
    const read = readsIn(commands);
    if (removal) {
      is(`${name}: stays open past the public share, and is counted`, [out.includes(restingTitle), units >= 1], [false, true]);
      if (i === 4) is("the real link still shows its button", out.includes(g.removeButton), true);
    } else {
      is(`${name}: rests with the store`, [out.includes(restingTitle), out.includes(PAGE_WORDS), out.includes(g.removeButton)], [true, false, false]);
      is(`${name}: resting, nothing behind it is read`, read, []);
    }
  }

  part("With the whole window used, the way off the list rests too");
  await takePublicRequest(store, "buyer", Date.now(), whole, { shared: true });
  for (const i of [4, 5]) {
    const { out, commands } = await watched(() => draw(i, i === 4 ? 0 : 800 + i));
    is(`${pages[i][0]}: rests, nothing behind it read`, [out.includes(restingTitle), readsIn(commands)], [true, []]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
