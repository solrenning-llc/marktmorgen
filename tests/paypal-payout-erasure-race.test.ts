/**
 * PayPal Payouts against a store's erasure (Codex L-20261120-0448 and L-20261120-0349; L-20261120-0345 was already
 * fixed on main by KEEP_LINK_IF_LIVE, tests/paypal-link-store-erasure.test.ts).
 *
 * 1. Sending (0448, HIGH): payWithPayPal writes its batch down (nl:pp:open:<statsId>, nl:pp:stores) and then asks
 *    PayPal for the money. A store whose erasure has begun (its id key gone or its erasing mark there) gets neither the
 *    batch written back nor a request for the money. And the erasure's mark is written under the press's own lock
 *    (nl:pp:<statsId>:lock), so a press already holding it finishes before the erasure begins, and one after it is
 *    refused.
 * 2. Settling (0349): settlePayPal reads a batch's status from PayPal, which can take seconds, and then writes back the
 *    lines still on their way. A store erased meanwhile does not get its open batch (affiliate ids, amounts, receiver
 *    prints) written back.
 *
 * Synthetic: stand-ins for PayPal, Stripe and Redis; no money, account or credential is real.
 */
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { ERASING_KEY, erasingField, ownerKey, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { markLive } from "./live-store";
import { done, is, part } from "./check";

const STATS = "statsrace001";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const posts: unknown[] = [];
/** The money request's answer lost on the way back: the press keeps its "?" entry (Claude 6 on #4963). */
let lostPost = false;
/** Run once, inside the next PayPal call of this path: the moment the erasure "wins" a race. */
let during: { path: "token" | "batch"; run: () => Promise<void> } | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") {
    if (during?.path === "token") {
      const run = during.run;
      during = null;
      await run();
    }
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts.push(JSON.parse(String(init.body)));
    if (lostPost) throw new TypeError("fetch failed: the answer was lost");
    return json({ batch_header: { payout_batch_id: `RACE${posts.length}BATCHAB`, batch_status: "PENDING" } }, 201);
  }
  if (url.pathname.startsWith("/v1/payments/payouts/") && (init?.method ?? "GET") === "GET") {
    if (during?.path === "batch") {
      const run = during.run;
      during = null;
      await run();
    }
    return json({ batch_header: { batch_status: "PENDING" }, items: [{ payout_item_id: "ITEMRACE0001", transaction_status: "PENDING", payout_item: { sender_item_id: "a00000000000", receiver: "p0@example.com" } }], total_pages: 1 });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidrace00001",
    handle: "raceharbor",
    name: "Race Harbor",
    previousHandles: [],
    releasedHandles: [],
    statsId: STATS,
    stripeAccountId: "acct_1TestRace000001",
    currency: "usd",
    catalog: { items: [] },
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

/** One approved affiliate with two sales, the store live, its PayPal app kept. */
async function seed(store: Store): Promise<void> {
  redis.clear();
  posts.length = 0;
  during = null;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const id = "a00000000000";
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, id, JSON.stringify({ id, email: "p0@example.com", code: "code0", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ...[1, 2].map((n) => ["HSET", `nl:aff:${STATS}:sales`, `cs_0_${n}`, JSON.stringify({ ref: `cs_0_${n}`, pi: `pi_0_${n}`, aff: id, at, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })]),
  ]);
  await markLive(store);
  if (!(await connectPayPal(store, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept");
}

/** What the erasure does that matters here: its mark, the store's own keys and its PayPal families gone. */
async function erase(store: Store): Promise<void> {
  await redis.pipeline([
    ["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())],
    ["DEL", storeIdCommand(store.sid)[1]],
    ["DEL", await ownerKey(storeRef(store))],
    ["DEL", `nl:pp:open:${STATS}`],
    ["SREM", "nl:pp:stores", store.sid],
  ]);
}

const openLeft = async () => Number(redis.run(["HLEN", `nl:pp:open:${STATS}`]));
const watched = async (store: Store) => Number(redis.run(["SISMEMBER", "nl:pp:stores", store.sid]));

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_erasure_race_only";
  process.env.PAYPAL_SECRET_KEY ??= "paypal-erasure-race-synthetic-secret-0001";
  const store = shop();

  part("Sending: a store erased while the press waits on PayPal's token gets no money asked for and nothing written back");
  await seed(store);
  during = { path: "token", run: () => erase(store) };
  const sent = await payWithPayPal(store);
  is("no request for the money reaches PayPal", posts.length, 0);
  is("the press does not say it paid", sent.ok, false);
  is("no open batch is written back for the erased store", await openLeft(), 0);
  is("and the store is not put back in the settling's set", await watched(store), 0);

  part("Sending: only the erasing mark there (the store's keys not yet gone) is refused the same way");
  await seed(store);
  during = { path: "token", run: async () => { await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]); } };
  const marked = await payWithPayPal(store);
  is("no request for the money, nothing written", [posts.length, marked.ok, await openLeft()], [0, false, 0]);

  part("Sending: a live store still pays, writes its batch down and is settled later");
  await seed(store);
  const live = await payWithPayPal(store);
  is("one request, paid, its batch kept on its way and the store in the settling's set", [posts.length, live.ok, await openLeft(), await watched(store)], [1, true, 1, 1]);

  part("Settling: a store erased while PayPal answers a batch's status does not get the batch written back");
  // `live` above left one batch on its way, PENDING at PayPal.
  during = { path: "batch", run: () => erase(store) };
  await settlePayPal(store);
  is("the erased store's open batch stays gone", await openLeft(), 0);

  part("Settling: a live store keeps a PENDING batch on its way");
  await seed(store);
  await payWithPayPal(store);
  await settlePayPal(store);
  is("its batch is still on its way", await openLeft(), 1);

  // Claude 6 on #4963 (MEDIUM): the settling's other writers of the open batches, needsManualCheck (which can run
  // outside the press's lock) and settleUnknown's count of a try before it sends the same request again.
  part("Settling: an old '?' batch of a store erased while the settling waits on PayPal's token is not written back");
  await seed(store);
  lostPost = true;
  const unknown = await payWithPayPal(store);
  lostPost = false;
  const field = ((redis.run(["HKEYS", `nl:pp:open:${STATS}`]) as string[]) ?? [])[0] ?? "";
  is("setup: the press left a '?' entry", [unknown.ok, field.startsWith("?")], [false, true]);
  const aged = JSON.parse(String(redis.run(["HGET", `nl:pp:open:${STATS}`, field])));
  redis.run(["HSET", `nl:pp:open:${STATS}`, field, JSON.stringify({ ...aged, at: Date.now() - 8 * 86_400_000 })]);
  during = { path: "token", run: () => erase(store) };
  await settlePayPal(store);
  is("the erased store's '?' batch stays gone (needsManualCheck)", await openLeft(), 0);

  part("Settling: a fresh '?' batch of a store whose erasing mark is there is never sent again");
  await seed(store);
  lostPost = true;
  await payWithPayPal(store);
  lostPost = false;
  const sentBefore = posts.length;
  await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
  await settlePayPal(store);
  is("no money is asked for again for a store being erased (settleUnknown)", posts.length - sentBefore, 0);

  part("Settling: a live store's fresh '?' batch is still sent again once, with the same key");
  await seed(store);
  lostPost = true;
  await payWithPayPal(store);
  lostPost = false;
  const liveBefore = posts.length;
  await settlePayPal(store);
  is("the same request is sent once more", posts.length - liveBefore, 1);

  // Codex P on #4963 (MEDIUM, 7050684301): a store from before ids (sid "") is fenced on its owner's record. After its
  // erasure finishes, its owner may make a new store under the same key; that record's being there must not let the
  // erased store's open batch back in. The record's statsId, which never changes for a store, tells the two apart
  // (the v2 identity of #4964, lib/store-live-cache.ts).
  part("Settling: a store from before ids, erased and its owner key reused by a new store, does not get its batch back");
  const legacy = { ...shop(), sid: "", email: "legacy-race@example.com" } as Store;
  const owner = await ownerKey(storeRef(legacy));
  redis.clear();
  posts.length = 0;
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "a00000000000", JSON.stringify({ id: "a00000000000", email: "p0@example.com", code: "code0", status: "approved", appliedAt: 1, decidedAt: 2, note: "" })],
    ...[1, 2].map((n) => ["HSET", `nl:aff:${STATS}:sales`, `cs_0_${n}`, JSON.stringify({ ref: `cs_0_${n}`, pi: `pi_0_${n}`, aff: "a00000000000", at: Math.floor(Date.now() / 1000) - 86_400, product: "p1", title: "Guide", base: 10000, total: 10000, currency: "usd", rate: 30, self: false })]),
    ["SET", owner, JSON.stringify({ statsId: STATS, handle: "raceharbor" })],
  ]);
  if (!(await connectPayPal(legacy, CLIENT, SECRET)).ok) throw new Error("synthetic PayPal app not kept for the legacy store");
  const paidLegacy = await payWithPayPal(legacy);
  is("setup: the legacy store pays and keeps its batch on its way", [paidLegacy.ok, await openLeft()], [true, 1]);
  during = {
    path: "batch",
    run: async () => {
      const field = await erasingField(storeRef(legacy));
      // The erasure runs to its end (its mark cleared with it), then the owner makes a new store under the same key.
      await redis.pipeline([["HSET", ERASING_KEY, field, String(Date.now())], ["DEL", owner], ["DEL", `nl:pp:open:${STATS}`]]);
      await redis.pipeline([["HDEL", ERASING_KEY, field], ["SET", owner, JSON.stringify({ statsId: "statsnew0001", handle: "newharbor" })]]);
    },
  };
  await settlePayPal(legacy);
  is("the erased legacy store's batch is not written back under the new store's owner key", await openLeft(), 0);

  part("Settling: a live store from before ids, its own record there, keeps a PENDING batch on its way");
  await redis.pipeline([["SET", owner, JSON.stringify({ statsId: STATS, handle: "raceharbor" })]]);
  posts.length = 0;
  await payWithPayPal(legacy);
  await settlePayPal(legacy);
  is("its batch is still on its way", await openLeft(), 1);

  part("The erasure's mark waits for the press's own lock (lib/closed-store-data.ts)");
  const source = (await import("node:fs")).readFileSync("lib/closed-store-data.ts", "utf8");
  const marker = /const markErasing = async \(\) => \{[^}]*"HSET", ERASING_KEY/.test(source);
  const underLock = /if \(store\.statsId\) await withLock\(`nl:pp:\$\{store\.statsId\}:lock`, 120, 5_000, markErasing\);/.test(source);
  is("the mark is written under nl:pp:<statsId>:lock", [marker, underLock], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
