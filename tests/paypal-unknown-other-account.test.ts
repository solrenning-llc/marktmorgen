/**
 * A PayPal payout batch whose answer was not known is never sent again from
 * another PayPal account (issue #4448, ALTO; Codex X8, reproduced by Claude 2).
 * The batch was sent from account A and its answer was lost, so the creator's
 * money may have left A. If the store connects account B before the daily
 * settling, the retry must not POST the same batch with B's token: PayPal's
 * idempotency (the same sender_batch_id and PayPal-Request-Id) is per
 * merchant, and nothing says it holds across two, so B could pay everyone a
 * second time. Money that may have left counts as sent (rule 30): the batch
 * stays on its way, left for the creator's own check. A batch from before
 * the sender was kept (no `s`) is held the same way. The same app still gets
 * its retry, as before.
 *
 * Synthetic only: a stand-in for PayPal that gives each app its own token
 * and records the token of every payout POST.
 */
import { connectPayPal, onTheirWay, payWithPayPal, paypalChecks, settlePayPal } from "@/lib/paypal-payouts";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsother01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT_A = "AAAAAAAAAAAAAAAAAAAAclientA0123456789";
const SECRET_A = "secretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CLIENT_B = "BBBBBBBBBBBBBBBBBBBBclientB0123456789";
const SECRET_B = "secretBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SCOPE = "https://uri.paypal.com/payments/payouts openid";

/** "drop": PayPal makes the batch and the answer is lost; "make": it makes it and answers. */
let mode: "drop" | "make" = "make";
let postsBy: string[] = [];
let batches = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") return json({ object: "list", data: [], has_more: false });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    const basic = Buffer.from((headers.get("authorization") ?? "").replace(/^Basic /, ""), "base64").toString();
    const token = basic.startsWith(`${CLIENT_A}:`) ? "tokenA" : basic.startsWith(`${CLIENT_B}:`) ? "tokenB" : "";
    if (!token) return json({ error: "invalid_client" }, 401);
    return json({ access_token: token, token_type: "Bearer", scope: SCOPE, expires_in: 32400 });
  }
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    postsBy.push(headers.get("authorization") ?? "");
    batches += 1;
    if (mode === "drop") throw new TypeError("fetch failed: the answer was lost");
    return json({ batch_header: { payout_batch_id: `BATCH${batches}OTH`, batch_status: "PENDING" } }, 201);
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidother01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(): Promise<void> {
  redis.clear();
  postsBy = [];
  batches = 0;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
  ]);
}

async function linked(store: Store, client: string, secret: string): Promise<void> {
  const result = await connectPayPal(store, client, secret);
  if (!result.ok) throw new Error(`not linked: ${JSON.stringify(result)}`);
}

/** Every unknown ("?") entry in the open batches, as stored. */
async function unknownEntries(): Promise<Record<string, unknown>[]> {
  const [raw] = await redis.pipeline([["HGETALL", OPEN]]);
  const flat = raw as string[];
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < flat.length; i += 2) if (flat[i].startsWith("?")) out.push(JSON.parse(flat[i + 1]) as Record<string, unknown>);
  return out;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_other_account_only";
  console.error = () => {};
  const store = shop();

  part("Sent from A, the answer lost, B connected before the settling: never sent again from B");
  await seed();
  await linked(store, CLIENT_A, SECRET_A);
  mode = "drop";
  const first = await payWithPayPal(store);
  is("the press is not known", first.ok ? "paid" : first.reason, "unknown");
  is("one POST, with A's token", postsBy, ["Bearer tokenA"]);
  await linked(store, CLIENT_B, SECRET_B);
  mode = "make";
  await settlePayPal(store);
  is("no POST was made with B's token", postsBy.filter((p) => p === "Bearer tokenB").length, 0);
  is("affiliate still on their way", (await onTheirWay(store)).has("aaaaaaaaaaaa"), true);
  is("left for the creator's own check", await paypalChecks(store), { checking: 0, manual: 1 });
  await settlePayPal(store);
  is("a later settling sends nothing either", postsBy.length, 1);
  is("and a press pays nobody in it", (await payWithPayPal(store)).ok ? "paid" : "held", "held");
  is("still one POST in all", postsBy.length, 1);

  part("Sent from A, B connected, then A again: still the account that sent it, so the retry is made");
  await seed();
  await linked(store, CLIENT_A, SECRET_A);
  mode = "drop";
  await payWithPayPal(store);
  await linked(store, CLIENT_A, SECRET_A);
  mode = "make";
  await settlePayPal(store);
  is("the retry goes from A, with the same key", postsBy, ["Bearer tokenA", "Bearer tokenA"]);
  is("now known by PayPal's id, nothing unknown left", (await unknownEntries()).length, 0);

  part("A batch kept from before the sender was recorded: never sent again, left for the creator's own check");
  await seed();
  await linked(store, CLIENT_A, SECRET_A);
  mode = "drop";
  await payWithPayPal(store);
  const [entry] = await unknownEntries();
  const [raw] = await redis.pipeline([["HKEYS", OPEN]]);
  const field = (raw as string[]).find((f) => f.startsWith("?")) as string;
  const legacy = { ...entry };
  delete legacy.s;
  await redis.pipeline([["HSET", OPEN, field, JSON.stringify(legacy)]]);
  mode = "make";
  await settlePayPal(store);
  is("no retry without the sender's proof", postsBy.length, 1);
  is("held for the creator's own check", await paypalChecks(store), { checking: 0, manual: 1 });
  done();
}

void main();
