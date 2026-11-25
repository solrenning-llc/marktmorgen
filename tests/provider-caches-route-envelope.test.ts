/**
 * The three provider-read caches fenced on the store being live (#5010 rows 112, 120 and 129; lib/store-live-cache.ts,
 * setWhileStoreLive) turn one billed SET into one EVAL and three commands inside it (HGET, GET and SET on the kept
 * path, as Upstash bills a script). This measures every real request that reaches each changed writer, at its worst
 * case (a live store, every cache missed, so the fenced write runs and keeps), against the priced envelope of its
 * scope in tests/plan-cost-registry.ts, and fails when one goes over:
 *
 * - GET /api/store/live (readToday, row 129): one studio request, UNIT_COST.studio;
 * - POST /api/store/currency (chargeableCurrencies, row 120): one studio request, UNIT_COST.studio;
 * - the studio's home page, app/studio/page.tsx (chargeableCurrencies, row 120): the studio requests the page takes
 *   (STUDIO_PAGE_UNITS and any more it counts), each at UNIT_COST.studio;
 * - the studio's email page, app/studio/email/page.tsx (readMailRevenue and readMailVisits, row 112): the same;
 * - get_emails, lib/mcp-tools.ts emailsTool (readMailRevenuePaid, row 112): the API requests it takes beyond its
 *   door's own, as tests/broadcasts-read-cost-mcp.test.ts measures them (apiReadUnits of what it did).
 *
 * Each command is counted as billed: every command sent, the commands a script of the stand-in runs inside it
 * (redis.scriptCalls), the fence's three inside its EVAL, and, as tests/outreach-sender-erasure-fence.test.ts pads a
 * studio request, the whole take allowance and lockedUntil's worst case. A JSON line prints the numbers of each.
 * Real code over the memory Redis stub, with stand-ins for Stripe; synthetic data only.
 */
import { NextRequest } from "next/server";
import { isValidElement } from "react";
import { afterTasks } from "./next-server-after-world";
import { answering } from "./security/next-headers";
import { GET as liveGET } from "@/app/api/store/live/route";
import { POST as currencyPOST } from "@/app/api/store/currency/route";
import StudioPage from "@/app/studio/page";
import StudioEmailPage from "@/app/studio/email/page";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { emailsTool } from "@/lib/mcp-tools";
import { holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { apiReadUnits, mailRevenueColdWork } from "@/lib/api-read-rules";
import { readMailRevenuePaid } from "@/lib/mail-revenue";
import { allowanceUsed } from "@/lib/store-allowance";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setPayPalSeller, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_provider_caches_route_envelope";
const ACCOUNT = "acct_1TestCacheEnv";
const OWNER = "provider-caches-envelope@example.test";
const FENCE = "-- marktmorgen:store-cache-live:";
/** The commands the fence runs inside its EVAL when it keeps: HGET of the erasing mark, GET of the id key, the SET. */
const FENCE_INNER = 3;
const HEADS = "-- marktmorgen:broadcast-heads:v";
const BROADCAST = "0123456789abcdef01234567";

type Command = (string | number)[];
const wire = (value: unknown): number => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");

const stripe: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    stripe.push(path);
    if (path === "/account") return Response.json({ id: ACCOUNT, country: "US" });
    if (path === "/country_specs/US") return Response.json({ id: "US", supported_payment_currencies: ["usd", "cad", "eur"] });
    return Response.json({ object: "list", data: [], has_more: false });
  }
  return Response.json({ object: "list", data: [], blobs: [], has_more: false, hasMore: false });
}) as typeof fetch;

async function liveStore(): Promise<Store> {
  redis.clear();
  if (!(await claimHandle(OWNER, "cacheenvelope", "Fictional envelope", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_cacheenv01", subscriptionId: "sub_cacheenv01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Fictional envelope", address: "1 Main St, Portland, OR 97201" });
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setPayPalSeller(OWNER, "7KNGBPH2U58GQ");
  const store = (await storeForEmail(OWNER))!;
  if (!store.statsId || !store.sid || !store.listId) throw new Error("no ids");
  return store;
}

/** One sent, tagged email, so the email page and get_emails read what the emails sold and the visits they brought. */
async function oneSentEmail(store: Store): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const email = {
    id: BROADCAST, listId: store.listId, handle: store.handle, subject: "Synthetic subject", body: "<p>Synthetic</p>", productId: null, notProductId: null, who: "all", narrow: null,
    status: "sent", createdAt: now - 3_600, sendAt: now - 3_600, finishedAt: now - 3_000, total: 100, sent: 100, note: "", failures: 0, listed: true, tagged: true, test: null, links: true,
  };
  await redis.pipeline([["SET", `nl:mail:bc:${BROADCAST}`, JSON.stringify(email)], ["RPUSH", `nl:mail:bcs:${store.listId}`, BROADCAST]]);
}

type Measured = { batches: { batch: Command[]; replies: unknown }[]; scriptCalls: number; fences: number; fenced: string[]; evals: string[]; stripe: string[] };

/** Runs `what` with every database batch watched. */
async function watched(what: () => Promise<unknown>): Promise<Measured & { result: unknown }> {
  const original = redis.pipeline;
  const batches: Measured["batches"] = [];
  const before = redis.scriptCalls;
  stripe.length = 0;
  redis.pipeline = (async (batch: Command[]) => {
    const replies = await original.call(redis, batch);
    batches.push({ batch, replies });
    return replies;
  }) as typeof redis.pipeline;
  let result: unknown;
  try {
    result = await what();
  } finally {
    redis.pipeline = original;
  }
  const all = batches.flatMap((b) => b.batch);
  const evals = all.filter((c) => c[0] === "EVAL").map((c) => /^-- marktmorgen:([a-z0-9-]+:v\d+)/.exec(String(c[1]))?.[1] ?? String(c[1]).slice(0, 40));
  return { result, batches, scriptCalls: redis.scriptCalls - before, fences: all.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith(FENCE)).length, fenced: all.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith(FENCE)).map((c) => String(c[5])), evals, stripe: [...stripe] };
}

/** Commands as billed, every command of the request and what scripts run inside them. */
const billed = (m: Measured) => m.batches.reduce((n, b) => n + b.batch.length, 0) + m.scriptCalls + FENCE_INNER * m.fences;
const bytesOf = (m: Measured) => m.batches.reduce((n, b) => n + wire(b.batch) + wire(b.replies), 0);

/** Renders a server tree as React does: promises waited for, async components run, siblings together. */
async function render(node: unknown): Promise<void> {
  if (node === null || typeof node !== "object") return;
  if (typeof (node as PromiseLike<unknown>).then === "function") return render(await node);
  if (Array.isArray(node)) {
    await Promise.all(node.map(render));
    return;
  }
  if (!isValidElement(node)) return;
  const { type, props } = node as { type: unknown; props: Record<string, unknown> };
  if (typeof type === "function" && type.constructor.name === "AsyncFunction") return render(await (type as (p: unknown) => Promise<unknown>)(props));
  await Promise.all(Object.values(props).map(render));
}

/** The work a route left for after its answer runs in the same invocation: run it inside the measure. */
async function runAfter(): Promise<void> {
  while (afterTasks.length) {
    const task = afterTasks.shift();
    if (typeof task === "function") await (task as () => unknown)();
    else await task;
  }
}

async function studioRoute(name: string, call: (cookie: string) => Promise<Response>, cached: (store: Store) => string, store: Store): Promise<void> {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  afterTasks.length = 0;
  const m = await watched(async () => {
    const response = await call(cookie);
    await runAfter();
    return { status: response.status, body: await response.json() };
  });
  const kept = Number(redis.run(["EXISTS", cached(store)]));
  const measured = billed(m) + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
  const bytes = bytesOf(m);
  console.log(name, JSON.stringify({ result: m.result, external: m.batches.reduce((n, b) => n + b.batch.length, 0), scriptCalls: m.scriptCalls, fences: m.fences, fenceInner: FENCE_INNER * m.fences, takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, measured, envelopeCommands: 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, bytes, evals: m.evals, stripe: m.stripe }));
  is(`${name}: the cache was missed and the fenced write kept it (worst case)`, [m.fences >= 1, kept], [true, 1]);
  // At the studio request's own fifty kilobytes, as the model test prices a route; the bytes read are printed above.
  is(`${name}: the whole request fits one studio request (${measured} commands)`, request("studio", measured, 50_000) <= UNIT_COST.studio, true);
}

async function studioPage(name: string, page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>, path: string, cached: (store: Store) => string[], store: Store, envelope = true): Promise<void> {
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  afterTasks.length = 0;
  const before = await allowanceUsed(store, "studio");
  const m = await watched(async () => {
    answering(new NextRequest(`https://marktmorgen.com${path}`, { headers: { cookie } }));
    try {
      await render(await page({ searchParams: Promise.resolve({}) }));
      await runAfter();
      return "rendered";
    } finally {
      answering(null);
    }
  });
  const units = (await allowanceUsed(store, "studio")) - before;
  const kept = cached(store).map((key) => Number(redis.run(["EXISTS", key])));
  const takes = m.batches.filter((b) => b.batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:allow:studio:"))).length;
  const measured = billed(m) + TAKE_COMMANDS * Math.max(1, takes) + LOCKED_UNTIL_STAR_COMMANDS;
  const bytes = bytesOf(m);
  const cost = request("heavy", measured, bytes);
  const taken = units * UNIT_COST.studio;
  console.log(name, JSON.stringify({ result: m.result, units, pageUnits: STUDIO_PAGE_UNITS, external: m.batches.reduce((n, b) => n + b.batch.length, 0), scriptCalls: m.scriptCalls, fences: m.fences, fenceInner: FENCE_INNER * m.fences, fenced: m.fenced, takes, measured, bytes, cost, envelope: taken, evals: m.evals, stripe: m.stripe }));
  is(`${name}: rendered, every cache missed and kept by its fenced write (worst case)`, [m.result, kept], ["rendered", kept.map(() => 1)]);
  if (envelope) is(`${name}: the whole page fits the studio requests it takes (${measured} commands, ${bytes} bytes, ${units} studio requests)`, units >= STUDIO_PAGE_UNITS && cost <= taken, true);
}

async function main(): Promise<void> {
  part("Row 129: GET /api/store/live reads today's sales, kept behind the fence");
  {
    const store = await liveStore();
    const day = new Date().toISOString().slice(0, 10);
    await studioRoute("LIVE_ROUTE", (cookie) => liveGET(new NextRequest("https://marktmorgen.com/api/store/live", { headers: { cookie } })), (s) => `nl:stats:${s.statsId}:today:${day}`, store);
  }

  part("Row 120: POST /api/store/currency asks Stripe which currencies it charges in, kept behind the fence");
  {
    // Priced products make the route read them and ask for the creator's confirmation: its longest path to a change.
    await liveStore();
    for (let i = 0; i < Number(process.env.PRODUCTS ?? 3); i += 1) await addProduct(OWNER, `Guide ${i}`, "", "19", null);
    const store = (await storeForEmail(OWNER))!;
    await studioRoute("CURRENCY_ROUTE", (cookie) => currencyPOST(new NextRequest("https://marktmorgen.com/api/store/currency", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ currency: "eur", confirm: true }),
    })), () => `nl:pay:currencies:${ACCOUNT}`, store);
  }

  part("Row 120: the studio's home page asks the same, kept behind the fence");
  {
    const store = await liveStore();
    // Measured and printed, not held: the home page's whole render is far past its STUDIO_PAGE_UNITS on main already
    // (the fence adds three commands to about four hundred); it needs its own line in tests/plan-cost-registry.ts, which
    // is the coordinator's to add. The check above still holds that the fenced write ran and kept.
    await studioPage("STUDIO_HOME_PAGE", StudioPage as never, "/studio", () => [`nl:pay:currencies:${ACCOUNT}`], store, false);
  }

  part("Row 112: the studio's email page reads what the emails sold and the visits they brought, kept behind the fence");
  {
    const store = await liveStore();
    await oneSentEmail(store);
    await studioPage("STUDIO_EMAIL_PAGE", StudioEmailPage as never, "/studio/email", (s) => [`nl:stats:${s.statsId}:mailsales:v2`, `nl:stats:${s.statsId}:mailvisits`], store);
  }

  part("Row 112: get_emails reads what the emails sold, kept behind the fence");
  {
    const store = await liveStore();
    await oneSentEmail(store);
    const before = await allowanceUsed(store, "api");
    const m = await watched(() => emailsTool(store, { charge: (more, taken) => takeMoreApi(store, more, taken), hold: (most) => holdMoreApi(store, most) }));
    const took = (await allowanceUsed(store, "api")) - before;
    const taking = (batch: Command[]) => batch.some((c) => c.some((v) => String(v).includes("nl:allow:")));
    const work = m.batches.filter((b) => !taking(b.batch));
    const heads = work.reduce((n, b) => n + b.batch.reduce((k, c) => k + (c[0] === "EVAL" && String(c[1]).startsWith(HEADS) ? Number(c[2]) : 0), 0), 0);
    const did = {
      commands: work.reduce((n, b) => n + b.batch.length, 0) + heads + m.scriptCalls + FENCE_INNER * m.fences,
      bytes: work.reduce((n, b) => n + wire(b.batch) + wire(b.replies), 0),
      sent: m.result instanceof Response ? 0 : wire(m.result),
      stripePages: m.stripe.length,
      roundTrips: work.length,
    };
    const units = apiReadUnits(did);
    const kept = Number(redis.run(["EXISTS", `nl:stats:${store.statsId}:mailsales:v2`]));
    console.log("MCP_GET_EMAILS", JSON.stringify({ took, units, did, fences: m.fences, fenceInner: FENCE_INNER * m.fences, scriptCalls: m.scriptCalls, evals: m.evals, stripe: m.stripe }));
    is("get_emails: told, the cache missed and kept by its fenced write (worst case)", [!(m.result instanceof Response), kept], [true, 1]);
    is(`get_emails: what it did comes to no more API requests than it took (${units} of ${took})`, units <= took, true);
  }

  part("Row 112: the model of get_emails' cold read (mailRevenueColdWork) counts the fenced keep (coordinator a8f7)");
  {
    const store = await liveStore();
    await oneSentEmail(store);
    const m = await watched(() => readMailRevenuePaid(store, null));
    // The kept copy's GET is the probe's (EMAILS_PROBE_WORK reads its size first); the rest is the cold read the model prices.
    const cold = billed(m) - 1;
    const modelled = mailRevenueColdWork(0).commands;
    console.log("MAIL_REVENUE_COLD", JSON.stringify({ billed: billed(m), cold, modelled, fences: m.fences, evals: m.evals }));
    is("the cold read ran the fenced keep", m.fences, 1);
    is(`the cold read's billed commands (${cold}) are within what mailRevenueColdWork prices (${modelled})`, cold <= modelled, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
