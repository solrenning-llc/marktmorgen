/**
 * Codex CX1's conditional HIGH on #3332 (review 5846675995, at e1ca5537): a running subscription whose metadata
 * names no store as text (metadata {}, {store: null}, {store: 7}, {store: ""}) passed renewalRowReadable and was taken
 * for another store's by the inequality: it was not stopped, and the pass still said done, so the closing wrote its
 * `renewals` mark and a renewal hidden by an unreadable identity could go on charging. Now only a store named as text
 * that is not this one is another's (left alone, as before); an identity that is not known keeps the pass not done,
 * with nothing ended on a guess. Synthetic only: a stand-in for Stripe.
 */
import "./redis-stub";
import { done, is, part } from "./check";
import { stopRenewals } from "@/lib/closed-store-data";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_closed_store_renewals_identity_only";

const ACCOUNT = "acct_1RenewIdent01";
const HANDLE = "renewals-identity";
let rows: Record<string, unknown>[] = [];
const deleted: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "DELETE" && path.startsWith("/subscriptions/")) {
    const id = decodeURIComponent(path.split("/").pop() ?? "");
    deleted.push(id);
    return json({ id, object: "subscription", status: "canceled" });
  }
  if (method === "GET" && path === "/subscriptions/search") return json({ object: "search_result", data: rows, has_more: false, next_page: null });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const store = { handle: HANDLE, previousHandles: [], releasedHandles: [], stripeAccountId: ACCOUNT } as unknown as Store;
const row = (id: string, metadata: unknown) => ({ id, object: "subscription", status: "active", metadata });
const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
  const real = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = real;
  }
};

async function main(): Promise<void> {
  for (const [label, metadata] of [
    ["metadata {}", {}],
    ["store null", { store: null }],
    ["store a number", { store: 7 }],
    ["store empty", { store: "" }],
  ] as [string, unknown][]) {
    part(`A running subscription whose store is not known (${label})`);
    rows = [row("sub_IdentUnknown01", metadata)];
    deleted.length = 0;
    const result = await quietly(() => stopRenewals(store, Date.now() + 60_000));
    is(`${label}: not stopped on a guess`, deleted, []);
    is(`${label}: and the pass is not done, so the closing asks again`, result.done, false);
  }

  part("Controls");
  rows = [row("sub_IdentOther0001", { store: "another-shop" })];
  deleted.length = 0;
  const other = await quietly(() => stopRenewals(store, Date.now() + 60_000));
  is("another store named as text: left alone, and the pass is done", [deleted, other.done], [[], true]);
  rows = [row("sub_IdentOwn000001", { store: HANDLE })];
  deleted.length = 0;
  const own = await quietly(() => stopRenewals(store, Date.now() + 60_000));
  is("the store's own: stopped, and the pass is done", [deleted, own.done], [["sub_IdentOwn000001"], true]);

  done();
}

void main();
