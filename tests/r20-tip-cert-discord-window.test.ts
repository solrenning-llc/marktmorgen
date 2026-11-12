/**
 * Audit R20, finding 3 (the free part): the tip, certificate and Discord
 * pages answered the public without taking a request of the store's window
 * (lib/traffic.ts, isResting), so neither the store's month (requestLimitFor)
 * nor one connection's share of the day (clientDayShare) bounded them, and
 * they kept answering after the store's public pages rest. The tip page also
 * asked Stripe about any well-formed session id in its address, one call on
 * the creator's connected account per made-up id.
 *
 * Checked, with the real pages against the in-memory Redis:
 * - each drawing of the three pages takes a request of the window, as the
 *   store page does (the control);
 * - with the window used up, the three rest with the store;
 * - the tip page asks Stripe only about a session the store's own tip
 *   checkout recorded (lib/store-tip-checkout.ts), for this store, and never
 *   about a made-up id;
 * - a mark Redis answers in any shape but the one written, or a confirmed
 *   absence, never reaches Stripe (CX-123 rule 24): the page says nothing was
 *   confirmed, as it did;
 * - a mark that cannot be written is a checkout not handed out.
 *
 * Synthetic store, Stripe stood in by a fetch stub; nothing real is called.
 */
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import StorePage from "@/app/[handle]/page";
import TipPage from "@/app/[handle]/tip/page";
import CertificatePage from "@/app/[handle]/certificate/[id]/page";
import DiscordPage from "@/app/[handle]/discord/page";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, setTips, storeForEmail } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { speech } from "@/lib/buyer-words";
import { createTipCheckout, readTip } from "@/lib/store-tip-checkout";
import { isResting, takePublicRequest } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "r20-tipcert@example.com";
const HANDLE = "r20tipcert";
const DRAWS = 25;
process.env.STRIPE_SECRET_KEY = "sk_test_r20_tipcert_only";

const OPENED = `cs_test_${"o".repeat(24)}`;
let stripeReads: string[] = [];
let stripeSession: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") return answer({ id: OPENED, url: "https://checkout.stripe.com/c/pay/test" });
  if (path.startsWith("/checkout/sessions/") && method === "GET") {
    const id = decodeURIComponent(path.slice("/checkout/sessions/".length));
    stripeReads.push(id);
    return id === OPENED ? answer(stripeSession) : answer({ error: { message: "No such checkout.session" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

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

/** Units of the store's window taken while `run` draws DRAWS times. */
async function measured(run: (k: number) => Promise<string>): Promise<{ answered: number; units: number }> {
  const original = redis.pipeline.bind(redis);
  let units = 0;
  redis.pipeline = async (list) => {
    for (const c of list) if (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) units += Number(c[2]);
    return original(list);
  };
  let answered = 0;
  try {
    for (let k = 0; k < DRAWS; k++) if (!(await run(k)).startsWith("thrown")) answered += 1;
  } finally {
    redis.pipeline = original;
  }
  return { answered, units };
}

/** Each GET of a tip mark answered `reply` instead of what Redis holds. */
async function withMarkReply<T>(reply: (real: unknown[]) => unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (list) => {
    const real = await original(list);
    return list.length === 1 && list[0][0] === "GET" && String(list[0][1]).startsWith("nl:tip:co:") ? (reply(real) as unknown[]) : real;
  };
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

const ask = (path: string) => answering(new NextRequest(`https://marktmorgen.com${path}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "R20 Tip Cert", "Pots.");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_r20tipcert1", subscriptionId: "sub_r20tipcert1", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_r20tipcert0001", true);
  await setTips(OWNER, { on: true, heading: "", line: "", amounts: [] });
  const store = (await storeForEmail(OWNER))!;
  const certId = "r20cert000000001";
  const issuedAt = Math.floor(Date.now() / 1000) - 3_600;
  await redis.pipeline([["SET", `nl:cert:${certId}`, JSON.stringify({ id: certId, store: storeKey(store), productId: "p1", courseId: "c1", name: "Ada Student", title: "Glazing", creator: "R20 Tip Cert", email: "ada@example.com", issuedAt, withdrawnAt: 0 })]]);
  const handleParam = `@${HANDLE}`;

  const pages: [string, (k: number) => Promise<string>][] = [
    ["tip page", (k) => { const id = `cs_live_${String(k).padStart(12, "a")}`; ask(`/@${HANDLE}/tip?session_id=${id}`); return drawn(() => TipPage({ params: Promise.resolve({ handle: handleParam }), searchParams: Promise.resolve({ session_id: id }) })); }],
    ["certificate page", (k) => { ask(`/@${HANDLE}/certificate/${certId}?x=${k}`); return drawn(() => CertificatePage({ params: Promise.resolve({ handle: handleParam, id: certId }), searchParams: Promise.resolve({ x: String(k) }) })); }],
    ["Discord page", (k) => { ask(`/@${HANDLE}/discord?status=joined&x=${k}`); return drawn(() => DiscordPage({ params: Promise.resolve({ handle: handleParam }), searchParams: Promise.resolve({ status: "joined", x: String(k) }) })); }],
  ];

  part("The store's own page takes a request of the window each time (control)");
  const front = await measured((k) => { ask(`/@${HANDLE}?x=${k}`); return drawn(() => StorePage({ params: Promise.resolve({ handle: handleParam }), searchParams: Promise.resolve({}) } as never)); });
  is("the store page is answered and counted", front.answered === DRAWS && front.units >= DRAWS, true);

  part(`${DRAWS} drawings of each page, each at its own address`);
  for (const [name, run] of pages) {
    stripeReads = [];
    const m = await measured(run);
    is(`${name}: answered every time`, m.answered, DRAWS);
    is(`${name}: each drawing takes a request of the store's window`, m.units >= DRAWS, true);
    if (name === "tip page") is("tip page: no Stripe call for a session id the store's tip checkout never opened", stripeReads, []);
  }

  part("The tip page asks Stripe only about a checkout the store's tip checkout opened");
  stripeSession = { id: OPENED, status: "complete", payment_status: "paid", amount_total: 500, currency: "usd", metadata: { store: HANDLE, kind: "tip" } };
  stripeReads = [];
  is("before the checkout is opened: nothing asked, nothing confirmed", [(await readTip(store, OPENED)).state, stripeReads.length], ["waiting", 0]);
  const opened = await createTipCheckout(store, "https://marktmorgen.com", 500);
  is("the checkout opens as before", opened, { url: "https://checkout.stripe.com/c/pay/test", id: OPENED });
  stripeReads = [];
  is("opened here and paid: thanked, with what Stripe took (healthy path)", await readTip(store, OPENED), { state: "paid", amount: 500, currency: "usd" });
  is("one Stripe read for it", stripeReads, [OPENED]);
  ask(`/@${HANDLE}/tip?session_id=${OPENED}`);
  const thanked = await drawn(() => TipPage({ params: Promise.resolve({ handle: handleParam }), searchParams: Promise.resolve({ session_id: OPENED }) }));
  is("and the page thanks the supporter", thanked.includes("Thank you for your support"), true);
  const other = { ...store, email: "someone-else@example.com", sid: "", extra: false };
  stripeReads = [];
  is("another store's mark is not this one's: nothing asked", [(await readTip(other as typeof store, OPENED)).state, stripeReads.length], ["waiting", 0]);

  part("A mark Redis does not answer in its exact shape never reaches Stripe (rule 24)");
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["confirmed absent (null)", () => [null]],
    ["a number", () => [1]],
    ["a word that is not the mark", () => ["OK"]],
    ["two replies for one command", (real) => [...real, "1"]],
    ["no reply", () => []],
    ["not a list", () => "1"],
    ["the mark inside a list", () => [["1"]]],
  ];
  for (const [label, reply] of shapes) {
    stripeReads = [];
    const outcome = await withMarkReply(reply, () => readTip(store, OPENED));
    is(`${label}: not confirmed, no Stripe call`, [outcome.state, stripeReads.length], ["waiting", 0]);
  }
  stripeReads = [];
  const failing = await withMarkReply(() => { throw new Error("Redis down"); }, () => readTip(store, OPENED));
  is("Redis failing: not confirmed, no Stripe call", [failing.state, stripeReads.length], ["waiting", 0]);

  part("A mark that cannot be written is a checkout not handed out");
  const original = redis.pipeline.bind(redis);
  for (const [label, reply] of [["a reply that is not OK", [null]], ["no reply", []], ["a number", [1]]] as [string, unknown[]][]) {
    redis.pipeline = async (list) => (list.length === 1 && list[0][0] === "SET" && String(list[0][1]).startsWith("nl:tip:co:") ? reply : original(list));
    let refused = "";
    try {
      await createTipCheckout(store, "https://marktmorgen.com", 500);
    } catch (error) {
      refused = (error as Error).message;
    } finally {
      redis.pipeline = original;
    }
    is(`${label}: refused`, refused !== "", true);
  }

  part("With the store's window used up, the three pages rest with the store");
  ask(`/@${HANDLE}`);
  await takePublicRequest(store, "public", Date.now(), requestLimitFor(store), { shared: true });
  is("the store's public pages rest", await isResting(store), true);
  const resting = speech(store).w.restingTitle;
  for (const [name, run] of pages) {
    stripeReads = [];
    const out = await run(DRAWS + 1);
    is(`${name}: rests with the store`, out.includes(resting) && !out.includes("Ada Student") && !linksToDiscord(out), true);
    if (name === "tip page") is("tip page: resting, no Stripe call", stripeReads, []);
  }
  done();
}

/** Whether the page links to Discord: each href's host is read as a URL, never matched as a substring. */
function linksToDiscord(html: string): boolean {
  return [...html.matchAll(/href="([^"]*)"/g)].some(([, href]) => {
    let host = "";
    try {
      host = new URL(href.replaceAll("&amp;", "&"), "https://marktmorgen.com").hostname;
    } catch {
      return false;
    }
    return host === "discord.com" || host.endsWith(".discord.com") || host === "discord.gg";
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
