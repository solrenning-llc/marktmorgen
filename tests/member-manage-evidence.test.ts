import { createHash } from "node:crypto";
import { openCancel, openPortal, requestManageLink } from "@/lib/membership-manage";
import { claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { clearLimitReply, limitReply } from "./member-manage-redis";
import { done, is, part } from "./check";

const account = "acct_1TestClub000001";
const customer = "cus_Member000001";
const subscription = "sub_Member0000001";
const token = "a".repeat(64);
const origin = "https://marktmorgen.com";
const calls: { method: string; path: string }[] = [];
const originalFetch = globalThis.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;
const originalMailKey = process.env.RESEND_API_KEY;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  calls.push({ method, path: url.pathname });
  const reply = (value: unknown) => new Response(JSON.stringify(value));
  if (url.hostname !== "api.stripe.com") throw Error("Unexpected provider");
  if (url.pathname === "/v1/customers") return reply({ data: [], has_more: false });
  if (url.pathname === `/v1/customers/${customer}`) return reply({ id: customer, email: "member@example.com" });
  if (url.pathname === "/v1/subscriptions") return reply({ data: [{
    id: subscription, customer, status: "active", metadata: { store: "club" },
    cancel_at_period_end: false, cancel_at: null,
    items: { data: [{ price: { recurring: { interval: "month" } } }] },
  }], has_more: false });
  if (url.pathname === "/v1/billing_portal/configurations") return reply({ id: "bpc_Member000001" });
  if (url.pathname === "/v1/billing_portal/sessions") return reply({ url: "https://billing.stripe.com/p/session" });
  throw Error("Unexpected Stripe operation");
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_pause_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_pause_only_a_stand_in";
  redis.clear();
  await claimHandle("club@example.com", "club", "Supper Club", "");
  await setStripeAccount("club@example.com", account, true);
  const store = (await storeForEmail("club@example.com"))!;
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: account, c: customer, h: "club" }), "EX", 3600]]);

  async function inject(reply: unknown, at = 1): Promise<void> {
    const keys = redis.keys().filter(key => /^nl:(rl:manage:|manage:opens:)/.test(key));
    if (keys.length) await redis.pipeline([["DEL", ...keys]]);
    limitReply(reply, at);
  }

  // The limiter's two replies (lib/window-count.ts): the INCR's count, then the EXPIRE … NX's 0 or 1.
  const malformed: [string, unknown][] = [
    ["missing EXPIRE reply", [1]], ["null count", [null, 1]],
    ["boolean count", [false, 1]], ["text count", ["1", 1]],
    ["zero count", [0, 1]], ["negative count", [-1, 1]],
    ["fractional count", [1.5, 1]], ["unsafe count", [Number.MAX_SAFE_INTEGER + 1, 1]],
    ["NaN count", [NaN, 1]], ["infinite count", [Infinity, 1]],
    ["missing EXPIRE acknowledgement", [1, undefined]], ["unknown EXPIRE acknowledgement", [1, false]],
    ["EXPIRE acknowledgement out of range", [1, 2]], ["text EXPIRE acknowledgement", [1, "1"]],
    ["extra result", [1, 1, "OK"]], ["empty reply", []], ["null reply", null],
  ];
  part("A link request needs both exact limit replies before member discovery");
  for (const at of [1, 2]) for (const [name, reply] of malformed) {
    calls.length = 0;
    await inject(reply, at);
    let result: unknown;
    try { result = await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.9", origin }); }
    catch { result = "error"; }
    is(`${name} at limit ${at} refuses before providers`, [result, calls.length], ["error", 0]);
  }

  part("Both portal buttons refuse an unknown shared open count");
  for (const [name, open] of [
    ["portal", () => openPortal(store, token, origin)],
    ["cancel", () => openCancel(store, token, subscription, origin)],
  ] as const) for (const [detail, reply] of malformed) {
    calls.length = 0;
    await inject(reply);
    let result: unknown;
    try { result = await open(); } catch { result = "threw"; }
    is(`${name}: ${detail} refuses before providers`, [result, calls.length], [{ ok: false, reason: "error" }, 0]);
  }

  part("Explicit acknowledgements keep the original boundaries");
  for (const ack of [1, 0]) {
    calls.length = 0;
    await inject([10, ack]);
    is("the IP limit's last included request continues", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.10", origin }), "sent");
    is("only member discovery was read", calls, [{ method: "GET", path: "/v1/customers" }]);
    await inject([11, ack]);
    is("the next IP request is limited", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.11", origin }), "limited");
    await inject([5, ack], 2);
    is("the address limit's last included request continues", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.12", origin }), "sent");
    await inject([6, ack], 2);
    is("the next address request is limited", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.13", origin }), "limited");
    await inject([10, ack]);
    is("the last included portal open continues", (await openPortal(store, token, origin)).ok, true);
    await inject([11, ack]);
    is("the next portal open is used", await openPortal(store, token, origin), { ok: false, reason: "used" });
    await inject([10, ack]);
    is("the last included cancel open continues", (await openCancel(store, token, subscription, origin)).ok, true);
    await inject([11, ack]);
    is("the next cancel open is used", await openCancel(store, token, subscription, origin), { ok: false, reason: "used" });
  }
}

async function staleKey(): Promise<void> {
  // The race the SET NX EX + INCR pair lost (review of #2498): the key was there for the SET, so the SET did nothing,
  // and it ran out before the INCR, which made it again with no expiry. Every later SET NX then did nothing, the count
  // only grew, and the link or the address was refused for good. A count that finds its key with no expiry gives it
  // back its window, so the key and its hashed address never outlive it.
  part("A limit key left with no expiry gets its window back, never counts for good");
  clearLimitReply();
  redis.clear();
  await claimHandle("club@example.com", "club", "Supper Club", "");
  await setStripeAccount("club@example.com", account, true);
  const store = (await storeForEmail("club@example.com"))!;
  const hash = createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:manage:link:${hash}`, JSON.stringify({ a: account, c: customer, h: "club" }), "EX", 3600]]);
  const opens = `nl:manage:opens:${createHash("sha256").update(`nimbus-manage-opens:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", opens, "3"]]);
  is("the stale opens key starts with no expiry", await redis.pipeline([["TTL", opens]]), [-1]);
  calls.length = 0;
  is("an open within the link's ten still goes through", (await openPortal(store, token, origin)).ok, true);
  const [left] = (await redis.pipeline([["TTL", opens]])) as number[];
  is("and the opens key has its window back (at most the link's hour)", left > 0 && left <= 60 * 60, true);
  is("counted once more, not reset", await redis.pipeline([["GET", opens]]), ["4"]);

  const addr = `nl:rl:manage:addr:${createHash("sha256").update("nimbus-manage-addr:member@example.com").digest("hex").slice(0, 32)}`;
  await redis.pipeline([["SET", addr, "2"]]);
  is("a link request still goes through", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.20", origin }), "sent");
  const [addrLeft] = (await redis.pipeline([["TTL", addr]])) as number[];
  is("and the address key has its window back too (at most an hour)", addrLeft > 0 && addrLeft <= 60 * 60, true);
}

void main().then(staleKey).finally(() => {
  clearLimitReply(); globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = originalKey;
  if (originalMailKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalMailKey;
}).then(done).catch(error => { console.error(error); process.exit(1); });
