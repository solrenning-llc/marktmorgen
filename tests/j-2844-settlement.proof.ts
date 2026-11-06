/**
 * Independent J reproduction; settlement issue first reported by Revisor 1. Synthetic only.
 * Redis answers the PayPal payouts read in an unknown shape (rule 24): never
 * read as "this call wrote it", "not connected" or "store gone".
 *
 *   - settling: a SET NX on a paid item that answers anything but "OK" or
 *     null books nothing, so the affiliate book is never counted twice, and
 *     the item stays on its way for the next run;
 *   - the daily job: a store whose record could not be read stays in the
 *     settle set (only a confirmed absent store leaves it);
 *   - the creator's PayPal link: an unknown answer is not "not connected"
 *     and not "auto-pay off".
 *
 * Synthetic only: a stand-in for PayPal's API on api-m.paypal.com, the Redis stub.
 */
import { connectPayPal, onTheirWay, payWithPayPal, paysAutomatically, readPayPal, setAutoPay, settleAllPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsexact01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";
let itemStatus: Record<string, string> = {};
const created: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    created.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return json({ batch_header: { payout_batch_id: `BATCH${created.length}ABC`, batch_status: "PENDING" } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+ABC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const items = created[Number(batch.slice(5, -3)) - 1].items as { sender_item_id: string }[];
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: items.map((item, i) => ({
        payout_item_id: `ITEM${batch}${i}`,
        transaction_status: itemStatus[item.sender_item_id] ?? "PENDING",
        payout_item: { sender_item_id: item.sender_item_id },
      })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidexact01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  created.length = 0;
  itemStatus = {};
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

const real = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
/** Answers `reply` (after running the commands, when `run`) for a pipeline `match` picks; the rest reach the stub. */
async function intercepted<T>(match: (commands: Commands) => boolean, reply: (commands: Commands) => Promise<unknown[]>, body: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Commands) => (match(commands) ? reply(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}
async function rejects(body: () => Promise<unknown>): Promise<boolean> {
  try {
    await body();
    return false;
  } catch {
    return true;
  }
}
const paidTo = async (store: Store) => (await readBook(store)).rows.find((r) => r.affiliate.id === "aaaaaaaaaaaa")?.paid ?? -1;
const itemSet = (commands: Commands) => commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith("nl:pp:item:");

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_j2844_only";
  console.error = () => {};
  const store = shop();
  for (const fault of ["claim-applied-ack-lost", "ledger-write-throws"] as const) {
    part(`R1 finding, independent reproduction: ${fault}`);
    await seed(store);
    await payWithPayPal(store);
    itemStatus = { aaaaaaaaaaaa: "SUCCESS" };
    const match = fault === "claim-applied-ack-lost" ? itemSet :
      (c: Commands) => c[0]?.[0] === "HSET" && c[0]?.[1] === `nl:aff:${STATS}:payouts`;
    const failed = await intercepted(match, async (c) => {
      if (fault === "claim-applied-ack-lost") { await real(c); return []; }
      throw new Error("Synthetic ledger unavailable before write");
    }, () => rejects(() => settlePayPal(store)));
    is("first settling refuses uncertain result", failed, true);
    is("before retry nothing is booked", await paidTo(store), 0);
    is("before retry the recipient stays reserved", [...await onTheirWay(store)], ["aaaaaaaaaaaa"]);
    const retry = await settlePayPal(store);
    const paid = await paidTo(store);
    const away = [...await onTheirWay(store)];
    const second = await payWithPayPal(store);
    console.log("OBSERVED", JSON.stringify({ fault, retry, paidInBook: paid, away, secondPay: second.ok, batchesSent: created.length }));
    is("retry preserves one accounted payout or the pending reservation", paid === 3000 || away.includes("aaaaaaaaaaaa"), true);
    is("a second batch never sends the already paid recipient", second.ok, false);
  }
  part("readLink rejects malformed stored auto metadata");
  for (const auto of ["false", 1, {}, [], null]) {
    await seed(store);
    const raw = (await real([["GET", `nl:pp:${STATS}`]]))[0];
    if (typeof raw !== "string") throw new Error("seed missing");
    await real([["SET", `nl:pp:${STATS}`, JSON.stringify({...JSON.parse(raw), auto})]]);
    const autoResult = await paysAutomatically(store).then(v => String(v), () => "unknown");
    console.log("METADATA", JSON.stringify({auto, autoResult}));
    is("unconfirmed boolean never grants automatic payment permission", autoResult, "unknown");
  }
  done();
}
void main();
