/**
 * Every view of the studio's affiliates page (app/studio/affiliates/page.tsx) and every { op: "settle" } sent to
 * app/api/store/affiliates/paypal asked PayPal again what each open payout batch paid (lib/paypal-payouts.ts,
 * settlePayPal): a new OAuth token from the creator's own PayPal app, then up to 10 pages of every batch still on its
 * way, with no pace at all (the route paces "connect" and "pay", not "settle"). Fifty reloads of the page while one
 * batch waits on PayPal were 100 calls to the creator's PayPal app (and its rate limit), each paid for in function
 * time, for an answer the daily job reads anyway.
 *
 * What is checked, with a synthetic stand-in for PayPal whose batch stays PENDING:
 *   - fifty settles asked for by views within a few minutes ask PayPal once (one token and one page), not fifty times;
 *   - the daily job, which is not a view, still reads the batch right after;
 *   - the page and the route ask for the paced reading.
 */
import { readFileSync } from "node:fs";
import { connectPayPal, payWithPayPal, settlePayPal } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statspace01";
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";

let tokens = 0;
let reads = 0;
const items = new Map<string, string>();
let batches = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") {
    tokens += 1;
    return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: { sender_item_id: string }[] };
    batches += 1;
    const id = `BATCH${batches}PACE`;
    for (const item of body.items) items.set(`${id}:${item.sender_item_id}`, "PENDING");
    return json({ batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } }, 201);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+PACE)$/.exec(url.pathname)?.[1];
  if (batch) {
    reads += 1;
    const mine = [...items.entries()].filter(([k]) => k.startsWith(`${batch}:`));
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "PENDING" },
      total_pages: 1,
      items: mine.map(([k, status], i) => ({ payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: status, payout_item: { sender_item_id: k.split(":")[1] } })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidpace0001", handle: "pacepaypal", name: "Pace Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestPace00001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_pace_only";
  console.error = () => {};
  redis.clear();
  const store = shop();
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
  const paid = await payWithPayPal(store);
  if (!paid.ok) throw new Error(`not sent: ${JSON.stringify(paid)}`);
  is("one batch is on its way, PENDING at PayPal", batches, 1);

  part("Fifty views within a few minutes");
  tokens = 0;
  reads = 0;
  for (let i = 0; i < 50; i += 1) {
    const out = await settlePayPal(store, { paced: true });
    if (i === 49) is("each still says who is on their way", out.waiting, 1);
  }
  is("ask PayPal once: one token and one page (before: 50 and 50)", [tokens, reads], [1, 1]);

  part("The daily job is not a view");
  tokens = 0;
  reads = 0;
  await settlePayPal(store);
  is("it reads the batch right after", [tokens, reads], [1, 1]);

  part("The page and the route ask for the paced reading");
  const page = readFileSync("app/studio/affiliates/page.tsx", "utf8");
  const route = readFileSync("app/api/store/affiliates/paypal/route.ts", "utf8");
  is("the affiliates page", page.includes("settlePayPal(store, { paced: true })"), true);
  is("the settle op", route.includes("settlePayPal(store, { paced: true })"), true);
  is("and neither settles unpaced", [/settlePayPal\(store\)/.test(page), /settlePayPal\(store\)/.test(route)], [false, false]);
  done();
}

void main().catch((error) => {
  console.error = (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`);
  console.error(error);
  process.exitCode = 2;
});
