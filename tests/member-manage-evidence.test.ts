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

  const malformed: [string, unknown][] = [
    ["missing count", ["OK"]], ["null count", ["OK", null]],
    ["boolean count", ["OK", false]], ["text count", ["OK", "1"]],
    ["zero count", ["OK", 0]], ["negative count", ["OK", -1]],
    ["fractional count", ["OK", 1.5]], ["unsafe count", ["OK", Number.MAX_SAFE_INTEGER + 1]],
    ["NaN count", ["OK", NaN]], ["infinite count", ["OK", Infinity]],
    ["missing SET acknowledgement", [undefined, 1]], ["unknown SET acknowledgement", [false, 1]],
    ["extra result", ["OK", 1, "OK"]], ["empty reply", []], ["null reply", null],
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
  for (const first of ["OK", null]) {
    calls.length = 0;
    await inject([first, 10]);
    is("the IP limit's last included request continues", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.10", origin }), "sent");
    is("only member discovery was read", calls, [{ method: "GET", path: "/v1/customers" }]);
    await inject([first, 11]);
    is("the next IP request is limited", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.11", origin }), "limited");
    await inject([first, 5], 2);
    is("the address limit's last included request continues", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.12", origin }), "sent");
    await inject([first, 6], 2);
    is("the next address request is limited", await requestManageLink({ store, email: "member@example.com", ip: "203.0.113.13", origin }), "limited");
    await inject([first, 10]);
    is("the last included portal open continues", (await openPortal(store, token, origin)).ok, true);
    await inject([first, 11]);
    is("the next portal open is used", await openPortal(store, token, origin), { ok: false, reason: "used" });
    await inject([first, 10]);
    is("the last included cancel open continues", (await openCancel(store, token, subscription, origin)).ok, true);
    await inject([first, 11]);
    is("the next cancel open is used", await openCancel(store, token, subscription, origin), { ok: false, reason: "used" });
  }
}

void main().finally(() => {
  clearLimitReply(); globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = originalKey;
  if (originalMailKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = originalMailKey;
}).then(done).catch(error => { console.error(error); process.exit(1); });
