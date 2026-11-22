/**
 * Codex L-20261120-0258 (row 35 of #5010, MEDIUM): opening a creator's Stripe account (app/api/stripe/connect) created
 * the account at Stripe, with the creator's address and the store's name, before anything here knew of it. A store
 * deleted while that request was in flight was gone when the answer came back, the account id was thrown away, and
 * an account holding the creator's data was left at Stripe with nothing here able to finish, disconnect or erase it.
 * Two tabs, or a press again after a lost answer, each opened an account of their own.
 *
 * Now the attempt is written on the store before Stripe is asked (beginStripeConnect), with the very address, name
 * and country it sends, and Stripe is asked with one idempotency key per attempt: a press again after a lost answer
 * gets the same account back, never a second one. While an attempt is open, the store is not deleted
 * ("stripe_connecting"), for the hours Stripe keeps the key. A refusal that says no account was made clears it; an
 * answer that says nothing certain keeps it for the next press. Synthetic stores and sessions; Stripe mocked;
 * MemoryRedis (tests/redis-stub.ts).
 */
import { NextRequest } from "next/server";
import { POST as connectPOST } from "@/app/api/stripe/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { STRIPE_CONNECT_HOLD_SECONDS, beginStripeConnect, claimHandle, createStore, deleteStore as deleteWith, storeForId, storeRef } from "@/lib/store";
import { queueDeleted } from "@/lib/closed-store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_connect_erasure_race_only";
const deleteStore = (ref: string) => deleteWith(ref, queueDeleted);

/** Stripe's side: one account per idempotency key, as Stripe replays a request made again with the same key. */
const byKey = new Map<string, string>();
let opened = 0;
let keys: (string | null)[] = [];
/** What happens while Stripe is creating the account, once. */
let meanwhile: (() => Promise<void>) | null = null;
/** How Stripe answers the next account creation. */
let answer: "ok" | "lost" | "refused" = "ok";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  if (url.pathname === "/v2/core/accounts" && init?.method === "POST") {
    const key = new Headers(init.headers).get("idempotency-key");
    keys.push(key);
    if (answer === "refused") {
      answer = "ok";
      return Response.json({ error: { code: "cross_border_connected_account_creation_not_allowed", message: "Not here." } }, { status: 400 });
    }
    let id = key ? byKey.get(key) : undefined;
    if (!id) {
      opened += 1;
      id = `acct_1Synthetic${opened}`;
      if (key) byKey.set(key, id);
    }
    const step = meanwhile;
    meanwhile = null;
    if (step) await step();
    if (answer === "lost") {
      answer = "ok";
      throw new TypeError("fetch failed: the answer was lost after Stripe made the account");
    }
    return Response.json({ id });
  }
  if (url.pathname === "/v2/core/account_links") return Response.json({ url: "https://connect.stripe.com/setup/synthetic" });
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

async function extraStore(owner: string, first: string, extra: string) {
  await claimHandle(owner, first, `${first} store`, "");
  const made = await createStore(owner, extra, `${extra} store`, "");
  if (!made.ok) throw new Error(`no extra store: ${JSON.stringify(made)}`);
  return made.store;
}

async function connect(owner: string, sid: string) {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const form = new FormData();
  form.set("country", "US");
  const response = await connectPOST(new NextRequest("https://marktmorgen.com/api/stripe/connect", {
    method: "POST", headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com", cookie, "x-nimbus-store": sid }, body: form,
  }));
  const location = response.headers.get("location") ?? "";
  return location.startsWith("https://connect.stripe.com") ? "onboarding" : new URL(location, "https://marktmorgen.com").searchParams.get("stripe");
}

const reset = () => { byKey.clear(); opened = 0; keys = []; meanwhile = null; answer = "ok"; };

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};

  part("A store deleted while Stripe opens its account: refused, and the account is kept on the store");
  {
    reset();
    const owner = "connect-race@example.com";
    const store = await extraStore(owner, "connectracefirst", "connectraceextra");
    let deleted: string = "not tried";
    meanwhile = async () => {
      const result = await deleteStore(storeRef(store));
      deleted = result.ok ? "deleted" : result.reason;
    };
    const said = await connect(owner, store.sid);
    is("the deletion that came in the middle is refused, saying why", deleted, "stripe_connecting");
    const after = await storeForId(store.sid);
    is("the store keeps the account Stripe made, so it can be finished, disconnected or erased", after?.stripeAccountId ?? null, "acct_1Synthetic1");
    is("and the creator goes on to onboarding", said, "onboarding");
    is("once written, the attempt no longer holds the store", (await deleteStore(storeRef(store))).ok, true);
  }

  part("An answer lost after Stripe made the account: the press again gets the same account, never a second one");
  {
    reset();
    const owner = "connect-lost@example.com";
    const store = await extraStore(owner, "connectlostfirst", "connectlostextra");
    answer = "lost";
    is("the first press says it failed", await connect(owner, store.sid), "error");
    is("meanwhile the store cannot be deleted: Stripe may hold an account for it", (await deleteStore(storeRef(store))).ok ? "deleted" : "kept", "kept");
    is("the second press goes on to onboarding", await connect(owner, store.sid), "onboarding");
    is("one account at Stripe", opened, 1);
    is("asked both times with one idempotency key", keys.length === 2 && keys[0] !== null && keys[0] === keys[1], true);
    is("the store points at it", (await storeForId(store.sid))?.stripeAccountId ?? null, "acct_1Synthetic1");
  }

  part("A refusal that says no account was made clears the attempt");
  {
    reset();
    const owner = "connect-refused@example.com";
    const store = await extraStore(owner, "connectrefusedfirst", "connectrefusedextra");
    answer = "refused";
    is("the creator is told the country is not open", await connect(owner, store.sid), "country-unsupported");
    is("nothing at Stripe", opened, 0);
    is("and the store can be deleted", (await deleteStore(storeRef(store))).ok, true);
  }

  part("Two tabs at once open one account");
  {
    reset();
    const owner = "connect-tabs@example.com";
    const store = await extraStore(owner, "connecttabsfirst", "connecttabsextra");
    let second: string | null = null;
    meanwhile = async () => {
      second = await connect(owner, store.sid);
    };
    const first = await connect(owner, store.sid);
    is("both tabs go on to onboarding", [first, second], ["onboarding", "onboarding"]);
    is("one account at Stripe, with one key", [opened, new Set(keys).size], [1, 1]);
    is("the store points at it", (await storeForId(store.sid))?.stripeAccountId ?? null, "acct_1Synthetic1");
  }

  part("An attempt older than Stripe's idempotency window holds nothing");
  {
    reset();
    const owner = "connect-stale@example.com";
    const store = await extraStore(owner, "connectstalefirst", "connectstaleextra");
    const old = Date.now() - (STRIPE_CONNECT_HOLD_SECONDS + 60) * 1000;
    const attempt = await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Stale" }, old);
    is("an attempt was written, a day and a minute ago", Boolean(attempt), true);
    is("it no longer holds the store: the deletion goes through", (await deleteStore(storeRef(store))).ok, true);
  }

  done();
}

main().catch((error) => { console.log(error); process.exit(1); });
