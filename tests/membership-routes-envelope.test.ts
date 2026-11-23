/**
 * Row 115 (#5010, #5232; coordinator 87f6 and b0d2): a membership's status is now kept through the store's live fence
 * (lib/membership-access.ts, setWhileStoreLive), so a status read from Stripe costs one EVAL with its calls in place of
 * one SET. membershipStatus runs only inside readOrder (lib/store-checkout.ts), and only for a checkout sold as a
 * membership whose subscription came back as an id (readOrder asks Stripe to expand it, so only when Stripe does not)
 * with no status kept. readOrder is called by eight public routes. Each is measured here end to end on that worst path
 * (a subscription checkout, its subscription an id, nothing kept, a product that carries what the route hands over),
 * every command billed as Upstash bills it (a script is one command plus each redis.call in its text), against the
 * public envelope: COMMANDS.laterPage + COMMANDS.laterCount (18) for each public request the route takes. What an order
 * writes once (lib/order-data.ts, orderWriteOnce: a listener's feed) is priced per order (ORDER_COMPUTE) and in the
 * data room, not per request, and is left out of the request, as tests/waitlist-confirm-cost.test.ts leaves the room's
 * own charges out. The two call routes that read the order only for a booking in the store's diary (book/move and the
 * booking page's move) never reach readOrder with a membership's checkout: measured as such.
 * Synthetic stores; in-memory Redis; Stripe stood in; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setProductCourse, setProductPodcast, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { POST as podcastOpen } from "@/app/api/store/podcast/open/route";
import { POST as courseStart } from "@/app/api/store/course/start/route";
import { POST as discordJoin } from "@/app/api/store/discord/join/route";
import { POST as bookMove } from "@/app/api/store/book/move/route";
import { GET as ics } from "@/app/api/store/ics/route";
import { GET as download } from "@/app/api/store/download/route";
import ThanksPage from "@/app/[handle]/thanks/page";
import BookPage from "@/app/[handle]/book/[product]/page";
import { answering } from "./security/next-headers";
import { seedDiscordServer } from "./discord-server-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { COMMANDS } from "./traffic-cost";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_membership_routes_envelope";
process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";
const ACCOUNT = "acct_1TestMemRoute1";
const SUB = "sub_MemberRoute0000001";
const SESSION = "cs_test_MemberRoute0000001";
const OWNER = "member-routes@example.test";
const HANDLE = "memberroutes";
const ORIGIN = "https://marktmorgen.com";
/** One public request, as a later page pays for it. */
const PAGE = COMMANDS.laterPage + COMMANDS.laterCount;
const STATUS_KEY = `nl:member:status:${ACCOUNT}:${SUB}`;

let productId = "";
let stripeCalls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") throw new Error(`no stand-in for ${url.hostname}${url.pathname}`);
  stripeCalls.push(url.pathname);
  if (url.pathname === `/v1/checkout/sessions/${SESSION}`) {
    // The worst path: the subscription comes back as its id, not expanded, so readOrder asks for its state.
    return new Response(JSON.stringify({
      id: SESSION, object: "checkout.session", mode: "subscription", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 60, subscription: SUB, payment_intent: null,
      customer_details: { email: "buyer@example.test" }, metadata: { store: HANDLE, product: productId },
    }));
  }
  if (url.pathname === `/v1/subscriptions/${SUB}`) return new Response(JSON.stringify({ id: SUB, object: "subscription", status: "active", pause_collection: null }));
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

type Command = (string | number)[];
/** Priced per order and in the data room (lib/order-data.ts, lib/store-data.ts), not per request. */
const ORDER_SCRIPT = /^-- marktmorgen:(order-write|store-data)/;
/** Every command as Upstash bills it: a script is one command plus each redis.call in its text. */
function bill(commands: Command[]): number {
  return commands.reduce((sum, c) => {
    if (c[0] !== "EVAL") return sum + 1;
    if (ORDER_SCRIPT.test(String(c[1]))) return sum;
    return sum + 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length;
  }, 0);
}
/** The store's public requests the route took (lib/traffic.ts counts them with INCRBY). */
const takenIn = (commands: Command[]) =>
  commands.reduce((sum, c) => sum + (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:") ? Number(c[2]) : 0), 0);

async function measure(work: () => Promise<unknown>): Promise<{ billed: number; taken: number; sent: Command[]; statusWrite: boolean; statusRead: boolean }> {
  redis.run(["DEL", STATUS_KEY]);
  stripeCalls = [];
  const real = redis.pipeline.bind(redis);
  const sent: Command[] = [];
  redis.pipeline = (async (commands: Command[]) => {
    sent.push(...commands);
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await work();
  } finally {
    redis.pipeline = real;
  }
  return {
    billed: bill(sent),
    taken: takenIn(sent),
    sent,
    statusRead: sent.some((c) => c[0] === "GET" && c[1] === STATUS_KEY),
    statusWrite: sent.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-cache-live:") && c.includes(STATUS_KEY)),
  };
}

async function freshStore(): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, HANDLE, "Fictional Club", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_memberroute1", subscriptionId: "sub_memberroutes1", active: true, tier: "creator", period: paidPeriod() } as never);
  const made = await addProduct(OWNER, "Fictional Club", "", "10", null);
  if (!made.ok) throw new Error(`no product: ${made.reason}`);
  productId = made.product.id;
  return (await storeForEmail(OWNER))!;
}

const post = (path: string, fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", body: new URLSearchParams(fields), headers: { origin: ORIGIN, host: "marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9" } });
const get = (path: string, query: Record<string, string>) =>
  new NextRequest(`${ORIGIN}${path}?${new URLSearchParams(query)}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": "203.0.113.9" } });

async function render(tree: unknown): Promise<string> {
  const stream = await renderToReadableStream(tree as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

/** A route that reads the order: its whole request on the worst path is inside the requests it took. */
function inside(name: string, run: Awaited<ReturnType<typeof measure>>): void {
  const requests = Math.max(1, run.taken);
  console.log("MEMBERSHIP_ROUTE", JSON.stringify({ route: name, billed: run.billed, taken: run.taken, envelope: requests * PAGE, statusRead: run.statusRead, statusWrite: run.statusWrite }));
  is(`(control) ${name}: the order was read on the worst path (the status asked of Stripe and kept through the fence)`, [run.statusRead, run.statusWrite], [true, true]);
  is(`${name}: its billed commands (${run.billed}) stay within the ${requests} public request(s) it took (${requests * PAGE})`, run.billed <= requests * PAGE, true);
}

async function main(): Promise<void> {
  part("podcast/open: a membership that is a podcast");
  {
    await freshStore();
    const attached = await setProductPodcast(OWNER, productId, { id: "b".repeat(32), episodes: 3 });
    if (!attached.ok) throw new Error(`no podcast: ${attached.reason}`);
    let location = "";
    const run = await measure(async () => {
      location = (await podcastOpen(post("/api/store/podcast/open", { handle: HANDLE, session_id: SESSION }))).headers.get("location") ?? "";
    });
    is("(control) the buyer is sent to their feed", /\/podcast\/[0-9a-f]+\?t=[0-9a-f]+$/.test(location), true);
    inside("podcast/open", run);
  }

  part("course/start: a membership that is a course");
  {
    await freshStore();
    const attached = await setProductCourse(OWNER, productId, { id: "c".repeat(32), lessons: 4 });
    if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
    let location = "";
    const run = await measure(async () => {
      location = (await courseStart(post("/api/store/course/start", { handle: HANDLE, session_id: SESSION, product: productId }))).headers.get("location") ?? "";
    });
    console.log("COURSE_START_LOCATION", location);
    inside("course/start", run);
  }

  part("discord/join: a membership with the store's Discord connected");
  {
    const store = await freshStore();
    await seedDiscordServer(storeKey(store), { id: "100000000000000001", name: "The Club", at: 1, kick: false });
    let location = "";
    const run = await measure(async () => {
      location = (await discordJoin(post("/api/store/discord/join", { handle: HANDLE, session_id: SESSION }))).headers.get("location") ?? "";
    });
    is("(control) the buyer is sent on to Discord", location.startsWith("https://discord.com/"), true);
    inside("discord/join", run);
  }

  part("download: a membership's order read for its download");
  {
    await freshStore();
    let status = 0;
    const run = await measure(async () => {
      status = (await download(get("/api/store/download", { handle: HANDLE, session_id: SESSION }))).status;
    });
    console.log("DOWNLOAD_STATUS", status);
    inside("download", run);
  }

  part("ics: a membership's checkout given to the calendar file (no call in it)");
  {
    await freshStore();
    let status = 0;
    const run = await measure(async () => {
      status = (await ics(get("/api/store/ics", { handle: HANDLE, session_id: SESSION }))).status;
    });
    is("(control) there is no call to put in a calendar", status, 404);
    inside("ics", run);
  }

  part("thanks page: a membership's thanks page, opened again (the order recorded on its first view, ORDER_COMPUTE)");
  {
    await freshStore();
    const query = { session_id: SESSION };
    const open = async () => {
      answering(new Request(`${ORIGIN}/@${HANDLE}/thanks?${new URLSearchParams(query)}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
      return render(await ThanksPage({ params: Promise.resolve({ handle: `@${HANDLE}` }), searchParams: Promise.resolve(query) }));
    };
    // The first view records the order once (its listing mark, its contact, its record): priced per order in
    // ORDER_COMPUTE and the order's own lines, not per view. Every later view is the page alone.
    const first = await measure(open);
    is("(control) the first view recorded the order", first.sent.some((c) => String(c[1]).startsWith("nl:listed:")), true);
    let html = "";
    const run = await measure(async () => {
      html = await open();
    });
    is("(control) the thanks page was drawn again", html.length > 0, true);
    // Opened again, its listing claim is already taken: no contact is written again. The page notes the store in the
    // buyer's library on every view (lib/buyer-library.ts, an order-write charged to the data room); that note was
    // there before row 115 and is priced by the room, so it stays out of the request, as the room's charges do above.
    is("(control) opened again, no contact is written again", run.sent.some((c) => c[0] === "EVAL" && /^-- marktmorgen:(crm-erased-returned|contact-)/.test(String(c[1]))), false);
    // At the envelope exactly (18; 15 before the fence, coordinator 5090): any command more on this page fails here.
    inside("thanks page", run);
  }

  part("book/move and the booking page's move: a membership's checkout is in no booking diary, so readOrder is never reached");
  {
    await freshStore();
    const call = await setProductCall(OWNER, productId, { minutes: 30, weekly: [] } as never).catch(() => null);
    console.log("CALL_SETUP", JSON.stringify(call && "ok" in call ? call.ok : null));
    const moved = await measure(async () => {
      await bookMove(post("/api/store/book/move", { handle: HANDLE, product: productId, session: SESSION, start: String(Date.now() + 86_400_000) }));
    });
    is("book/move: no order read from Stripe and no membership status asked or kept", [stripeCalls.length, moved.statusRead, moved.statusWrite], [0, false, false]);
    const page = await measure(async () => {
      answering(new Request(`${ORIGIN}/@${HANDLE}/book/${productId}?move=${SESSION}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
      try {
        await render(await BookPage({ params: Promise.resolve({ handle: `@${HANDLE}`, product: productId }), searchParams: Promise.resolve({ move: SESSION }) } as never));
      } catch (error) {
        // A move this store's diary does not know is sent on (notFound or redirect): what matters is what was read.
        if (!/NEXT_(REDIRECT|NOT_FOUND|HTTP_ERROR)/.test(String((error as { digest?: string })?.digest ?? error))) throw error;
      }
    });
    is("booking page (?move=): no order read from Stripe and no membership status asked or kept", [stripeCalls.length, page.statusRead, page.statusWrite], [0, false, false]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
