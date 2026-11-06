/** Evidence only: real pause route, membership helpers and Stripe adapter; explicit local boundaries elsewhere. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "../app/api/store/manage/pause/route";

type Raw = Record<string, unknown>;
type Action = "pause" | "resume";
type Mode = "healthy" | "empty" | "wrong-id" | "unchanged";
const SUB = "sub_QPauseSynthetic0001", CUSTOMER = "cus_QPauseSynthetic001", ACCOUNT = "acct_QPauseSynthetic01";
const TOKEN = "a".repeat(64), DAY = 86_400;
const shop = { handle: "fictional-pause", name: "Fictional pause store", email: "creator@example.test", language: "en", pause: 2, leaving: { on: false } };
let backend: Raw, currentAction: Action, currentMode: Mode;
let calls = 0, posts = 0, cacheClears = 0;
const emails: Raw[] = [];

// Only these imports at the route/helper boundaries are replaced by the launcher.
export const MANAGE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const normaliseHandle = (value: string) => value;
export const storeForHandle = async (handle: string) => handle === shop.handle ? shop : null;
export const withinStore = async () => true;
export const fromAnotherSite = () => false;
export const limited = async (request: Request) => request;
export const clientAddress = () => "203.0.113.10";
export const originFrom = (request: Request) => new URL(request.url).origin;
export const grantOf = async () => ({ a: ACCOUNT, c: CUSTOMER, e: "buyer@example.test" });
export const subsOf = async () => [structuredClone(backend)];
export const forgetStatus = async () => { cacheClears++; };
export const readListings = async () => [{ id: "fictional-product", title: "Fictional membership" }];
export const sendEmail = async (message: Raw) => { emails.push(message); return true; };
export const fromCreator = () => "Fictional creator <creator@example.test>";
export const storeBase = () => "https://example.test/@fictional-pause";
export const speech = () => ({ date: (value: number) => new Date(value).toISOString().slice(0, 10) });
export const countLeave = async () => { throw new Error("Unexpected leave counter outside this proof"); };

function initial(action: Action): Raw {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: SUB, object: "subscription", customer: CUSTOMER, status: "active", cancel_at_period_end: false,
    metadata: { store: shop.handle, product: "fictional-product", ...(action === "resume" ? { pause_from: String(now - DAY), paused_at: String(now - 2 * DAY) } : {}) },
    items: { data: [{ current_period_end: now + 20 * DAY, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
    pause_collection: action === "resume" ? { behavior: "void", resumes_at: now + 30 * DAY } : null,
  };
}
function updated(body: URLSearchParams): Raw {
  const metadata = { ...(backend.metadata as Record<string, string>) };
  for (const [name, value] of body) {
    const field = name.match(/^metadata\[(.+)\]$/)?.[1];
    if (field) { if (value === "") delete metadata[field]; else metadata[field] = value; }
  }
  return { ...backend, metadata, pause_collection: body.has("pause_collection") ? null : { behavior: body.get("pause_collection[behavior]"), resumes_at: Number(body.get("pause_collection[resumes_at]")) } };
}
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // No actual network implementation is retained or called, even for this hostname.
  assert.equal(url.hostname, "api.stripe.com", "Every unexpected external destination is blocked");
  calls++; assert.ok(calls <= 2_000, "Synthetic per-scenario command ceiling");
  assert.equal(new Headers(init?.headers).get("stripe-account"), ACCOUNT);
  const method = init?.method ?? "GET";
  if (method === "POST" && url.pathname === `/v1/subscriptions/${SUB}`) {
    posts++; const wanted = updated(new URLSearchParams(String(init?.body)));
    if (currentMode === "healthy") { backend = wanted; return Response.json(backend); }
    if (currentMode === "wrong-id") return Response.json({ ...wanted, id: "sub_QDifferentSynthetic001" });
    if (currentMode === "unchanged") return Response.json(structuredClone(backend));
    return Response.json({});
  }
  if (method === "GET" && url.pathname === `/v1/customers/${CUSTOMER}`) return Response.json({ id: CUSTOMER, email: "buyer@example.test" });
  throw new Error(`Unexpected synthetic Stripe request: ${method} ${url.pathname}`);
}) as typeof fetch;

for (const action of ["pause", "resume"] as const) for (const mode of ["healthy", "empty", "wrong-id", "unchanged"] as const) {
  test(`${action}: ${mode} subscription acknowledgement`, async () => {
    currentAction = action; currentMode = mode; backend = initial(action);
    const before = structuredClone(backend); calls = posts = cacheClears = 0; emails.length = 0;
    const form = new URLSearchParams({ handle: shop.handle, token: TOKEN, subscription: SUB, action, months: "1" });
    const response = await POST(new Request("https://example.test/api/store/manage/pause", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.test" }, body: form }) as never);
    const status = new URL(response.headers.get("location")!, "https://example.test").searchParams.get("status");
    const success = currentAction === "pause" ? "paused" : "resumed";
    console.log(JSON.stringify({ action, mode, redirect: status, posts, syntheticCalls: calls, backendChanged: JSON.stringify(backend) !== JSON.stringify(before), confirmationEmails: emails.length, cacheClearBoundaryCalls: cacheClears }));
    assert.equal(posts, 1);
    if (mode === "healthy") {
      assert.equal(status, success);
      assert.notDeepEqual(backend, before);
      assert.equal(Boolean(backend.pause_collection), action === "pause");
      assert.equal(emails.length, action === "pause" ? 1 : 0);
      assert.equal(cacheClears, 1);
    } else {
      assert.deepEqual(backend, before, "The explicit synthetic backend did not apply this malformed/stale acknowledgement");
      assert.notEqual(status, success, "Unknown or contradictory update evidence must not be announced as confirmed success");
      assert.equal(emails.length, 0, "No confirmation email before a known update");
      assert.equal(cacheClears, 0, "No confirmed-update cache-clear path before a known update");
    }
  });
}
