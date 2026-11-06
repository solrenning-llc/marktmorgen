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
import { connectPayPal, setAutoPay } from "@/lib/paypal-payouts";
import { sendPaydayEmails } from "@/lib/affiliate-payday";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

const STATS = "0123456789abcdef0123456789abcdef";
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
async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_j2844_only";
  process.env.RESEND_API_KEY = "re_synthetic_j2844_only";
  console.error = () => {};
  const store = {...shop(), email: "owner@example.com"};
  await seed(store);
  await setAutoPay(store, true);
  await real([["SET", "nl:store:owner:synthetic", JSON.stringify(store)]]);
  const month = "2026-11";
  const today = new Date("2026-11-05T12:00:00.000Z");
  const linkRead = (c: Commands) => c.length === 1 && c[0][0] === "GET" && c[0][1] === `nl:pp:${STATS}`;
  await sendPaydayEmails(Date.now()+60_000,today);
  is("healthy control reaches a configured automatic payout", created.length, 1);
  await seed(store);
  const saved = (await real([["GET", `nl:pp:${STATS}`]]))[0];
  if (typeof saved !== "string") throw new Error("missing fixture link");
  await real([["SET", `nl:pp:${STATS}`, JSON.stringify({...JSON.parse(saved), auto:"false"})], ["SET", "nl:store:owner:synthetic", JSON.stringify(store)]]);
  const metadata = await sendPaydayEmails(Date.now()+60_000,today);
  console.log("PAYDAY_METADATA",JSON.stringify({metadata,batchesSent:created.length}));
  is("malformed auto metadata never dispatches an automatic payout",created.length,0);
  await seed(store);
  await setAutoPay(store,true);
  await real([["SET", "nl:store:owner:synthetic", JSON.stringify(store)]]);
  const first = await intercepted(linkRead, async () => [], () => sendPaydayEmails(Date.now()+60_000, today));
  const claim = await real([["GET", `nl:aff:payday:${STATS}:${month}`]]);
  const retry = await sendPaydayEmails(Date.now()+60_000,today);
  console.log("PAYDAY", JSON.stringify({first,claim,retry,batchesSent:created.length}));
  is("fixture reaches the due store and reports an unavailable link", [first.due,first.failed], [1,1]);
  is("failed PayPal read leaves this month's attempt retryable", claim, [null]);
  is("healthy retry can dispatch the previously configured automatic payout", created.length, 1);
  done();
}
void main();
