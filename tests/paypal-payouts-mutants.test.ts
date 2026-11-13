/**
 * Mutation testing of lib/paypal-payouts.ts (Claude 7, 13/11/2026): each case
 * kills a mutant that survived the tests importing the module. The creator's
 * money leaves through these paths, so what is pinned is what decides a
 * payment: why a press was refused (funds, a refused app, anything else), that
 * a batch whose answer was not known is sent again only on its day, only before
 * the creator's own check is due, and only while every line is still owed in
 * full to an approved affiliate in the same currency; and how the daily
 * settling reads a batch (every page, a batch PayPal denied, no app to ask).
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com and for
 * Stripe, and the in-memory Redis of tests/redis-stub.ts.
 */
import { connectPayPal, onTheirWay, payWithPayPal, paypalChecks, setAutoPay, settlePayPal, UNKNOWN_MANUAL_AFTER_MS, UNKNOWN_RETRY_EVERY_MS } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsmut001";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";

type Pay = "ok" | "dropped" | "no-id" | "funds" | "invalid" | "bad-request" | "unauthorized" | "forbidden";
let pay: Pay = "ok";
let token: "ok" | "empty" | "unauthorized" | "server" = "ok";
let stripeDown = false;
let made = 0;
/** What a GET of a batch answers, page by page. */
let pages: { status: string; items: { aff: string; status: string }[] }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return stripeDown ? json({ error: { message: "synthetic outage" } }, 500) : json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") {
    if (token === "unauthorized") return json({ error: "invalid_client" }, 401);
    if (token === "server") return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    return json({ access_token: token === "empty" ? "" : "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    if (pay === "funds") return json({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }, 422);
    if (pay === "invalid") return json({ name: "VALIDATION_ERROR", message: "Invalid request." }, 422);
    if (pay === "bad-request") return json({ name: "VALIDATION_ERROR", message: "Invalid request." }, 400);
    if (pay === "unauthorized") return json({ name: "AUTHENTICATION_FAILURE", message: "No." }, 401);
    if (pay === "forbidden") return json({ name: "NOT_AUTHORIZED", message: "No." }, 403);
    made += 1;
    if (pay === "dropped") throw new TypeError("fetch failed: the connection was reset");
    if (pay === "no-id") return json({ batch_header: { batch_status: "PENDING" } }, 201);
    return json({ batch_header: { payout_batch_id: `BATCH${made}ABC`, batch_status: "PENDING" } }, 201);
  }
  if (url.pathname.startsWith("/v1/payments/payouts/")) {
    const page = Number(url.searchParams.get("page") ?? "1");
    const p = pages[page - 1] ?? { status: "SUCCESS", items: [] };
    return json({
      batch_header: { batch_status: p.status },
      total_pages: pages.length,
      items: p.items.map((it, i) => ({ payout_item_id: `ITEM${page}X${i}ABCDEF`, transaction_status: it.status, payout_item: { sender_item_id: it.aff } })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now;
/** A clock held still while a boundary is checked, else the real one. */
let frozen: number | null = null;
Date.now = () => frozen ?? realNow();

function shop(over: Record<string, unknown> = {}): Store {
  return {
    sid: "sidmutants01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
    ...over,
  } as unknown as Store;
}

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const person = (id: string, email: string, code: string, status = "approved") => JSON.stringify({ id, email, code, status, appliedAt: 1, decidedAt: 2, note: "" });

async function seed(store: Store): Promise<void> {
  redis.clear();
  frozen = null;
  pay = "ok";
  token = "ok";
  stripeDown = false;
  made = 0;
  pages = [];
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, A, person(A, "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, B, person(B, "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", A, 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", B, 5000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const reason = (r: Awaited<ReturnType<typeof payWithPayPal>>) => (r.ok ? "paid" : r.reason);
const fields = async () => ((await redis.pipeline([["HKEYS", OPEN]]))[0] as string[]).sort();
const record = async (field: string) => JSON.parse(String((await redis.pipeline([["HGET", OPEN, field]]))[0])) as Record<string, unknown>;
const rewrite = async (field: string, change: Record<string, unknown>) => redis.pipeline([["HSET", OPEN, field, JSON.stringify({ ...(await record(field)), ...change })]]);

/** A batch sent whose answer never came: left under "?". */
async function unknownBatch(store: Store): Promise<string> {
  await seed(store);
  pay = "dropped";
  await payWithPayPal(store);
  pay = "ok";
  const [field] = await fields();
  if (!field?.startsWith("?")) throw new Error("setup: no unknown batch");
  return field;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_mutants_only";
  console.error = () => {};
  const store = shop();

  part("Connecting the app");
  redis.clear();
  is("an id in no valid shape", await connectPayPal(store, "short", SECRET), { ok: false, reason: "format" });
  is("a secret in no valid shape", await connectPayPal(store, CLIENT, "short"), { ok: false, reason: "format" });
  token = "unauthorized";
  is("PayPal refusing the app", await connectPayPal(store, CLIENT, SECRET), { ok: false, reason: "refused" });
  token = "server";
  is("PayPal failing", await connectPayPal(store, CLIENT, SECRET), { ok: false, reason: "error" });
  token = "empty";
  is("PayPal giving no token", await connectPayPal(store, CLIENT, SECRET), { ok: false, reason: "refused" });
  token = "ok";
  is("no store records", await connectPayPal(shop({ statsId: "" }), CLIENT, SECRET), { ok: false, reason: "error" });
  is("automatic pay with no app connected", await setAutoPay(store, true), false);
  is("connected", await connectPayPal(store, CLIENT, SECRET), { ok: true });
  is("automatic pay once connected", await setAutoPay(store, true), true);

  part("Why a press was refused");
  for (const [mode, want] of [["funds", "funds"], ["unauthorized", "refused"], ["forbidden", "refused"], ["invalid", "error"], ["bad-request", "error"]] as const) {
    await seed(store);
    pay = mode;
    is(`PayPal refusing (${mode})`, reason(await payWithPayPal(store)), want);
    is(`and nobody is on their way (${mode})`, (await onTheirWay(store)).size, 0);
  }
  await seed(store);
  token = "empty";
  is("no token for the app: reconnect", reason(await payWithPayPal(store)), "reconnect");
  await seed(store);
  stripeDown = true;
  is("refunds that cannot be read: nothing is sent", [reason(await payWithPayPal(store)), made], ["refunds", 0]);
  is("no store records", reason(await payWithPayPal(shop({ statsId: "" }))), "error");

  await seed(store);
  const realPipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    // The batch written down as on its way: Redis answers that the field was already there, so it is not known to be ours.
    if (commands[0]?.[0] === "HSET" && String(commands[0][2]).startsWith("?")) return [0, 1];
    return realPipeline(commands);
  }) as typeof redis.pipeline;
  try {
    is("not known to be held: nothing is sent", [reason(await payWithPayPal(store)), made], ["error", 0]);
  } finally {
    redis.pipeline = realPipeline;
  }

  part("A batch whose answer was not known, sent again");
  let field = await unknownBatch(store);
  const tried = realNow();
  await rewrite(field, { t: tried });
  frozen = tried + UNKNOWN_RETRY_EVERY_MS - 1;
  made = 0;
  await settlePayPal(store);
  is("tried within the day: not sent again", [made, (await fields())[0]], [0, field]);
  frozen = tried + UNKNOWN_RETRY_EVERY_MS;
  await settlePayPal(store);
  is("a whole day after its last try: sent again, and held under PayPal's id", [made, (await fields())[0]?.startsWith("?")], [1, false]);
  is("both still on their way", (await onTheirWay(store)).size, 2);

  field = await unknownBatch(store);
  const first = realNow();
  await rewrite(field, { at: first });
  frozen = first + UNKNOWN_MANUAL_AFTER_MS;
  made = 0;
  await settlePayPal(store);
  is("a week old: left for the creator's own check, never sent", [made, (await record(field)).m], [0, 1]);
  is("and counted as such", await paypalChecks(store), { checking: 0, manual: 2 });

  for (const [what, change] of [
    ["an affiliate no longer approved", async () => redis.pipeline([["HSET", `nl:aff:${STATS}:people`, B, person(B, "tom@example.com", "tom", "declined")]])],
    ["an affiliate gone", async () => redis.pipeline([["HDEL", `nl:aff:${STATS}:people`, B]])],
    ["a sale refunded since", async () => redis.pipeline([["HDEL", `nl:aff:${STATS}:sales`, "cs_2"]])],
  ] as const) {
    field = await unknownBatch(store);
    await change();
    made = 0;
    await settlePayPal(store);
    is(`${what}: never sent again, left for the creator's check`, [made, (await record(field)).m], [0, 1]);
  }
  field = await unknownBatch(store);
  made = 0;
  await settlePayPal(shop({ currency: "eur" }));
  is("the store's currency changed: never sent again", [made, (await record(field)).m], [0, 1]);

  field = await unknownBatch(store);
  pay = "no-id";
  await settlePayPal(store);
  is("sent again with no batch named: still waiting under our own id", [(await fields())[0], (await record(field)).m, await paypalChecks(store)], [field, undefined, { checking: 2, manual: 0 }]);

  part("The daily settling");
  await seed(store);
  await payWithPayPal(store);
  token = "empty";
  is("no app to ask: everybody waits", await settlePayPal(store), { paid: 0, released: 0, waiting: 2 });
  token = "ok";
  pages = [{ status: "DENIED", items: [{ aff: A, status: "PENDING" }, { aff: B, status: "PENDING" }] }];
  is("a batch PayPal denied: owed again", await settlePayPal(store), { paid: 0, released: 2, waiting: 0 });
  is("and the store leaves the daily job", (await redis.pipeline([["SISMEMBER", "nl:pp:stores", store.sid]]))[0], 0);
  await seed(store);
  await payWithPayPal(store);
  pages = [{ status: "SUCCESS", items: [{ aff: A, status: "SUCCESS" }] }, { status: "SUCCESS", items: [{ aff: B, status: "SUCCESS" }] }];
  is("both pages read: both paid", await settlePayPal(store), { paid: 2, released: 0, waiting: 0 });
  await seed(store);
  await payWithPayPal(store);
  pages = Array.from({ length: 10 }, (_, i) => ({ status: "SUCCESS", items: i === 0 ? [{ aff: A, status: "SUCCESS" }] : i === 9 ? [{ aff: B, status: "SUCCESS" }] : [] }));
  is("the tenth page is read too", await settlePayPal(store), { paid: 2, released: 0, waiting: 0 });

  done();
}

main().catch((error: unknown) => {
  Date.now = realNow;
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
