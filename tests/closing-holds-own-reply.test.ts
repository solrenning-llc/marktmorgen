/**
 * Rule 30 (from #2517): a member not held yet at a store's closing is read
 * again by id (lib/closing-holds.ts, retryHolds). A reply from Stripe that is
 * not the subscription asked for (another subscription's, or one with no id)
 * decides nothing: the member stays written down to be tried again, is never
 * dropped from the line, and no other subscription is held or written to in
 * its place. Checked against a stand-in for Stripe; nothing real is reached.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { retryHolds, workKey } from "@/lib/closing-holds";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_holds_own_reply_only";

const ACCOUNT = "acct_1ClosingOwnRep";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);
const MEMBER = "sub_ClosingMember01";
const OTHER = "sub_ClosingOther001";

/** What Stripe answers for GET /subscriptions/<MEMBER>. */
let reply: unknown = {};
const writes: string[] = [];
const reads: string[] = [];

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
  if (path === "/invoices") return json({ object: "list", data: [], has_more: false });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

async function setup() {
  redis.clear();
  writes.length = 0;
  reads.length = 0;
  const email = "closing-own-reply@example.com";
  await claimHandle(email, "closing-own-reply", "Closing own reply", "");
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
  part("A reply for another subscription, not chargeable, never drops the member");
  {
    const { store, folder } = await setup();
    reply = { id: OTHER, status: "canceled", metadata: {} };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
    is("nothing is written to Stripe", writes, []);
  }

  part("A reply with no id, not chargeable, never drops the member");
  {
    const { store, folder } = await setup();
    reply = { status: "canceled", metadata: {} };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
    is("nothing is written to Stripe", writes, []);
  }

  part("A reply for another subscription, already held, never drops the member");
  {
    const { store, folder } = await setup();
    reply = { id: OTHER, status: "active", metadata: { store_hold: String(ENDED_AT) }, pause_collection: { behavior: "void" } };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", (await fields(folder)).includes(`f:${MEMBER}`), true);
    is("and still counted for the creator", counts.failed, 1);
    is("nothing is written to Stripe", writes, []);
  }

  part("A reply for another subscription, chargeable, never holds that other one");
  {
    const { store, folder } = await setup();
    reply = { id: OTHER, status: "active", metadata: { store: "closing-own-reply" }, customer: { email: "other@example.com" } };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("nothing is written to Stripe for another subscription", writes, []);
    is("no invoice of another subscription is read", reads.filter((path) => path === "/invoices").length, 0);
    is("the other subscription is never written down as a member", (await fields(folder)).filter((field) => field.endsWith(OTHER)), []);
    is("the member is still to be tried again", [(await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, 1]);
  }

  // Claude 6 on #3098: a 200 whose JSON body is null, a string or a number is not the member's reply either.
  for (const [label, body] of [["null", null], ["a string", MEMBER], ["a number", 7]] as const) {
    part(`A reply that is ${label}, not an object, never drops the member`);
    const { store, folder } = await setup();
    reply = body;
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("the member is still to be tried again", [(await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, 1]);
    is("nothing is written to Stripe and no invoice is read", [writes, reads.filter((path) => path === "/invoices").length], [[], 0]);
  }

  part("The member's own reply still decides");
  {
    const { store, folder } = await setup();
    reply = { id: MEMBER, status: "canceled", metadata: {} };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("a member whose own subscription ended leaves the line", [(await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [false, 0]);
  }
  {
    const { store, folder } = await setup();
    reply = { id: MEMBER, status: "active", metadata: { store: "closing-own-reply" }, customer: { email: "member@example.com" } };
    const counts = await retryHolds(store, ENDED_AT, Date.now() + 10_000);
    is("a member whose own subscription is chargeable is held", [writes.includes(`POST /subscriptions/${MEMBER}`), (await fields(folder)).includes(`f:${MEMBER}`), counts.failed], [true, false, 0]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
