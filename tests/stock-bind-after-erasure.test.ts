/**
 * Codex L's MEDIUM on main (relatorios-codex/L-20261120-0655-defect-stock-bind-after-erasure.md): a checkout of a
 * limited product holds a provisional field, then waits for Stripe to open the checkout (open(true)). The store's
 * erasure can begin or end in that wait: the closing walk removes the stock record (family E, nl:stock:) and the
 * store's live keys. When the late answer arrives, the checkout's own hold must not write the erased store's stock
 * record back: the hand-over (STOCK_BIND) is fenced on the store being live, in the same step as its writes. Gone,
 * nothing is bound, the checkout is closed at Stripe through the failed hand-over's path, and no hold is kept,
 * whether Stripe closes it or not. A store with an id and one from before ids (legacy), whose owner may open a new
 * store under the same address meanwhile, and a store whose account moved and began erasing under the new ref. The
 * live control still binds as before.
 * Synthetic: the Redis stand-in and a mocked Stripe only.
 */
import { parseProduct } from "@/lib/catalog";
import { stockLeft, withCartStockHolds, withStockHold } from "@/lib/stock";
import { ERASING_KEY, type Listing, type Store, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const EMAIL = "stock-erasure@example.invalid";
const ACCOUNT = "acct_test_stockerasure1";

/** What Stripe answers when asked to close a checkout: "expired", a refusal (400) or no answer (500). */
let closing: "expired" | "refused" | "down" = "expired";
const closed: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (url.hostname === "api.stripe.com" && expire && (init?.method ?? "GET") === "POST") {
    closed.push(expire[1]);
    if (closing === "refused") return new Response(JSON.stringify({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }), { status: 400 });
    if (closing === "down") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ id: expire[1], status: "expired" }));
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const limited = (id: string) => parseProduct({ id, title: `Print ${id}`, summary: "", priceCents: 2000, stock: 3, link: `https://example.com/${id}` }) as Listing;

/** The id key of the store kept under the owner's address now, if it has one. */
async function ownerIdKey(): Promise<string | null> {
  const raw = redis.run(["GET", await ownerKey(EMAIL)]);
  const sid = typeof raw === "string" ? (JSON.parse(raw) as { sid?: string }).sid : "";
  return sid ? storeIdCommand(sid)[1] : null;
}

/** Makes the store kept under the owner's address one from before ids: no id in its record, no id key. */
async function makeLegacy(): Promise<void> {
  const idKey = await ownerIdKey();
  if (idKey) redis.run(["DEL", idKey]);
  const kept = JSON.parse(String(redis.run(["GET", await ownerKey(EMAIL)]))) as Store;
  redis.run(["SET", await ownerKey(EMAIL), JSON.stringify({ ...kept, sid: "" })]);
}

type State = "live" | "gone" | "erasing" | "reopened" | "moved";

/** What the closing walk (and, for "reopened" and "moved", what the owner) did while Stripe was opening the checkout. */
async function happen(state: State, real: Store, keys: string[]): Promise<void> {
  if (state === "live") return;
  // The walk removes the stock family (E) whatever else happened.
  for (const key of keys) redis.run(["DEL", key]);
  if (state === "gone" || state === "reopened") {
    // The erasure's record step: the store's id key, if it has one, and its record.
    const idKey = await ownerIdKey();
    if (idKey) redis.run(["DEL", idKey]);
    redis.run(["DEL", await ownerKey(EMAIL)]);
  }
  if (state === "reopened") {
    // The owner opens a new store under the same address: the same owner key, another statsId.
    redis.run(["SET", await ownerKey(EMAIL), JSON.stringify({ ...real, sid: "", statsId: "0123456789abcdef0123456789abcdef" })]);
  }
  if (state === "erasing") redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(real)), "1"]);
  if (state === "moved") {
    // moveAccount repoints the id key, and an erasure begun after the move marks the new ref's field.
    const idKey = await ownerIdKey();
    if (!idKey) throw new Error("no id key");
    const moved = "stock-erasure-moved@example.invalid";
    redis.run(["SET", idKey, moved]);
    redis.run(["HSET", ERASING_KEY, await erasingField(moved), "1"]);
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.STRIPE_SECRET_KEY = "sk_test_only";
  let n = 0;
  const cases: [kind: "primary" | "legacy", state: State, answer: typeof closing, cart: number][] = [];
  for (const kind of ["primary", "legacy"] as const) for (const state of ["live", "gone", "erasing", "reopened", "moved"] as const) {
    if (kind === "primary" && state === "reopened") continue;
    if (kind === "legacy" && state === "moved") continue;
    for (const answer of state === "live" ? (["expired"] as const) : (["expired", "refused", "down"] as const)) for (const cart of [1, 2]) cases.push([kind, state, answer, cart]);
  }
  for (const [kind, state, answer, cart] of cases) {
    const label = `${kind}/${state}/stripe ${answer}/${cart === 1 ? "one product" : "a cart of two"}`;
    part(label);
    redis.clear();
    closed.length = 0;
    closing = answer;
    await claimHandle(EMAIL, "stock-erasure", "Synthetic", "");
    await ensureStatsId(EMAIL);
    await ensureStoreId(EMAIL);
    if (kind === "legacy") await makeLegacy();
    const real = { ...(await storeForEmail(EMAIL))!, stripeAccountId: ACCOUNT } as Store;
    if (kind === "legacy") is(label + " starts from a store with no id", real.sid, "");
    const products = cart === 1 ? [limited("print1")] : [limited("print1"), limited("print2")];
    const keys = products.map((product) => `nl:stock:${real.statsId}:${product.id}`);
    n += 1;
    const id = `cs_test_stockerasure${String(n).padStart(6, "0")}`;
    let heldWhileOpening: boolean[] = [];
    const open = async (held: boolean) => {
      is(label + " opens with its units held", held, true);
      // The provisional hold is there while Stripe is asked.
      heldWhileOpening = keys.map((key) => redis.run(["EXISTS", key]) === 1);
      await happen(state, real, keys);
      return { id };
    };
    const result = cart === 1 ? await withStockHold(real, products[0], open) : await withCartStockHolds(real, products, open);
    is(label + " held a provisional unit while Stripe opened the checkout", heldWhileOpening, keys.map(() => true));
    if (state === "live") {
      is(label + " a live store binds as before", result, { ok: true, value: { id } });
      for (const key of keys) {
        const fields = redis.run(["HKEYS", key]) as string[];
        is(label + " its stock record keeps the checkout's own hold, the provisional one let go", [fields.includes(id), fields.some((f) => f.startsWith("p_"))], [true, false]);
      }
      is(label + " and one unit counts as held", await stockLeft(real, products[0]), 2);
      is(label + " nothing is closed at Stripe", closed, []);
      continue;
    }
    is(label + " nobody is sent to the checkout", result, { ok: false, reason: "busy" });
    is(label + " the erased store's stock record is not written back", keys.map((key) => redis.run(["EXISTS", key])), keys.map(() => 0));
    is(label + " the checkout is closed at Stripe, through the failed hand-over's path", closed, [id]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
