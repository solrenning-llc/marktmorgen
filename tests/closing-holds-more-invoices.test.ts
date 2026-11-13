/**
 * A member held at a store's closing has every open invoice voided and every
 * draft kept as a draft (lib/closing-holds.ts, holdOne), so nothing issued
 * before the closing is collected after it. Stripe lists them ten at a time:
 * a page that says more follow (has_more true) is not the member's whole list,
 * so the member is never counted held on it; it is tried again (rule 24).
 * Checked against a stand-in for Stripe; nothing real is reached.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { retryHolds, workKey } from "@/lib/closing-holds";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_holds_more_only";

const ACCOUNT = "acct_1ClosingMore";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);
const MEMBER = "sub_ClosingMember01";
const CUSTOMER = "cus_ClosingMember1";
const HANDLE = "closing-more-inv";

/** What Stripe answers for GET /subscriptions/<MEMBER>. */
let reply: unknown = {};
const writes: string[] = [];
const reads: string[] = [];
/** What Stripe lists for GET /invoices, by status, whatever subscription was asked for. */
let lists: Record<string, Record<string, unknown>[]> = {};
/** What Stripe's search of the store's subscriptions answers. */
let found: Record<string, unknown>[] = [];
/** A whole reply given as it is, in place of a list: for GET /invoices by status, and for the search ("search"). */
const asIs = new Map<string, unknown>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method !== "GET") {
    writes.push(`${method} ${path}`);
    return json({ id: path.split("/").pop() });
  }
  reads.push(path);
  if (path === `/subscriptions/${MEMBER}`) return json(reply);
  if (path === "/invoices" && asIs.has(url.searchParams.get("status") ?? "")) return json(asIs.get(url.searchParams.get("status") ?? ""));
  if (path === "/subscriptions/search" && asIs.has("search")) return json(asIs.get("search"));
  if (path === "/invoices") return json({ object: "list", data: lists[url.searchParams.get("status") ?? ""] ?? [], has_more: false });
  if (path === "/subscriptions/search") return json({ object: "search_result", data: found, has_more: false, next_page: null });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function setup() {
  redis.clear();
  writes.length = 0;
  reads.length = 0;
  lists = {};
  found = [];
  asIs.clear();
  const email = "closing-more-inv@example.com";
  await claimHandle(email, "closing-more-inv", "Closing more invoices", "");
  await setStripeAccount(email, ACCOUNT, true);
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await redis.pipeline([["HSET", workKey(folder), "calls", 100, `f:${MEMBER}`, "1", `m:${MEMBER}`, "member@example.com"]]);
  return { store, folder };
}

const fields = async (folder: string) => {
  const raw = await redis.run(["HKEYS", workKey(folder)]);
  return (Array.isArray(raw) ? raw.map(String) : []).sort();
};

async function main() {
  const member = { id: MEMBER, status: "active", metadata: { store: HANDLE }, customer: { id: CUSTOMER, email: "member@example.com" } };
  const open = (n: number) => ({ id: `in_MoreOpen${String(n).padStart(5, "0")}`, status: "open", subscription: MEMBER, customer: CUSTOMER });
  const draft = (n: number) => ({ id: `in_MoreDraft${String(n).padStart(4, "0")}`, status: "draft", auto_advance: true, subscription: MEMBER, customer: CUSTOMER });
  const paused = () => writes.includes(`POST /subscriptions/${MEMBER}`);

  for (const [status, row] of [["open", open], ["draft", draft]] as const) {
    part(`Ten ${status} invoices with more to follow: the member is not counted held`);
    const { store, folder } = await setup();
    asIs.set(status, { object: "list", data: Array.from({ length: 10 }, (_, i) => row(i + 1)), has_more: true });
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is(`its collection is not paused on a partial list of ${status} invoices`, paused(), false);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
  }

  part("Control: ten open invoices and no more are all voided and the member is held");
  {
    const { store, folder } = await setup();
    asIs.set("open", { object: "list", data: Array.from({ length: 10 }, (_, i) => open(i + 1)), has_more: false });
    reply = member;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("each of the ten is voided", writes.filter((w) => /^POST \/invoices\/in_MoreOpen\d+\/void$/.test(w)).length, 10);
    is("the member is held", [paused(), (await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, false, 0]);
  }

  done();
}

main();
