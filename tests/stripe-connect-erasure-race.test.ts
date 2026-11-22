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
import { STRIPE_CONNECT_HOLD_SECONDS, STRIPE_CONNECT_REUSE_SECONDS, beginStripeConnect, claimHandle, createStore, deleteStore as deleteWith, storeForId, storeRef } from "@/lib/store";
import { StripeConnectingError, prepareStore, queueDeleted } from "@/lib/closed-store-data";
import { StripeConnectError } from "@/lib/stripe-connect";
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
let answer: "ok" | "lost" | "refused" | "down" | "idempotency" = "ok";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  if (url.pathname === "/v2/core/accounts" && init?.method === "POST") {
    const key = new Headers(init.headers).get("idempotency-key");
    keys.push(key);
    if (answer === "down") {
      answer = "ok";
      return Response.json({ error: { type: "api_error", message: "Synthetic outage." } }, { status: 503 });
    }
    if (answer === "idempotency") {
      // Stripe's own shape for a key it cannot replay: its type says so, its code is another word.
      answer = "ok";
      return Response.json({ error: { type: "idempotency_error", code: "idempotency_key_in_use", message: "Synthetic." } }, { status: 400 });
    }
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

async function connect(owner: string, sid: string, country = "US") {
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const form = new FormData();
  form.set("country", country);
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

  part("A press again with another country is never asked for in the first one (Claude 7 xAF on #5095, MEDIUM)");
  {
    reset();
    const owner = "connect-country@example.com";
    const store = await extraStore(owner, "connectcountryfirst", "connectcountryextra");
    answer = "down";
    is("a German account is asked for and Stripe answers 503", await connect(owner, store.sid, "DE"), "error");
    const asked = keys.length;
    is("a press again choosing France is told an account is still being opened elsewhere", await connect(owner, store.sid, "FR"), "attempt-country");
    is("and nothing is asked of Stripe for it", keys.length, asked);
    is("the German attempt stays open", (await storeForId(store.sid))?.stripeConnecting?.country ?? null, "de");
    is("choosing Germany again finishes it, with the same key", [await connect(owner, store.sid, "DE"), keys.length === asked + 1 && keys[asked] === keys[0]], ["onboarding", true]);
  }

  part("A Stripe idempotency_error keeps the attempt, whatever its code (coordinator on #5095, LEVE 2)");
  {
    reset();
    is("an error whose type is idempotency_error is never read as nothing made", new StripeConnectError(400, "idempotency_key_in_use", "x", "idempotency_error").madeNothing, false);
    const owner = "connect-idem@example.com";
    const store = await extraStore(owner, "connectidemfirst", "connectidemextra");
    answer = "idempotency";
    is("the press says it failed", await connect(owner, store.sid), "error");
    is("the attempt stays open for the press again", Boolean((await storeForId(store.sid))?.stripeConnecting), true);
    is("and the store is still held against deletion", (await deleteStore(storeRef(store))).ok ? "deleted" : "kept", "kept");
  }

  part("An attempt is reused while Stripe keeps its v2 key (30 days), not only for the day it holds the store (LEVE 1)");
  {
    reset();
    const owner = "connect-reuse@example.com";
    const store = await extraStore(owner, "connectreusefirst", "connectreuseextra");
    const twoDays = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const first = await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Reuse" }, twoDays);
    const firstId = first && !("other" in first) ? first.id : "none";
    is("an attempt was written two days ago, its answer lost", firstId === "none", false);
    is("a press again now goes on to onboarding", await connect(owner, store.sid), "onboarding");
    is("asked with that attempt's key, so Stripe gives back the account it made", keys, [`connect-${store.sid}-${firstId}`]);
    is("the store points at it", (await storeForId(store.sid))?.stripeAccountId ?? null, "acct_1Synthetic1");

    reset();
    const late = await extraStore("connect-late@example.com", "connectlatefirst", "connectlateextra");
    const past = Date.now() - (STRIPE_CONNECT_REUSE_SECONDS + 60) * 1000;
    const stale = await beginStripeConnect(storeRef(late), late.sid, { country: "us", email: "connect-late@example.com", name: "Late" }, past);
    const staleId = stale && !("other" in stale) ? stale.id : "none";
    is("past the reuse window (inside Stripe's 30 days, a day to spare) a press again", await connect("connect-late@example.com", late.sid), "onboarding");
    is("asks with a new key, never one Stripe may have forgotten", keys.length === 1 && keys[0] !== `connect-${late.sid}-${staleId}`, true);
    is("the reuse window stays inside Stripe's 30 days", STRIPE_CONNECT_REUSE_SECONDS < 30 * 24 * 60 * 60 && STRIPE_CONNECT_REUSE_SECONDS > STRIPE_CONNECT_HOLD_SECONDS, true);
  }

  part("The closing walk does not close a store whose Stripe account is being opened (coordinator on #5095)");
  {
    reset();
    const owner = "connect-closing@example.com";
    const store = await extraStore(owner, "connectclosingfirst", "connectclosingextra");
    const snapshot = await storeForId(store.sid);
    if (!snapshot) throw new Error("no store");
    await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Closing" });
    const held = await storeForId(store.sid);
    if (!held) throw new Error("no store");
    let thrown: unknown = null;
    try { await prepareStore(held); } catch (error) { thrown = error; }
    is("prepared from a record with an open attempt: it waits, saying why", thrown instanceof StripeConnectingError, true);
    is("and the record stays", Boolean(await storeForId(store.sid)), true);
    thrown = null;
    try { await prepareStore(snapshot); } catch (error) { thrown = error; }
    is("prepared from a read taken before the attempt: seen under the lock, it waits", thrown instanceof StripeConnectingError, true);
    is("and the record still stays, with the attempt on it", Boolean((await storeForId(store.sid))?.stripeConnecting), true);
  }

  part("An attempt older than the day it holds the store no longer keeps it from deletion");
  {
    reset();
    const owner = "connect-stale@example.com";
    const store = await extraStore(owner, "connectstalefirst", "connectstaleextra");
    const old = Date.now() - (STRIPE_CONNECT_HOLD_SECONDS + 60) * 1000;
    // Still reused for a press again (above), but no longer a reason to keep the store from its owner's deletion.
    const attempt = await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Stale" }, old);
    is("an attempt was written, a day and a minute ago", Boolean(attempt), true);
    is("it no longer holds the store: the deletion goes through", (await deleteStore(storeRef(store))).ok, true);
  }

  done();
}

main().catch((error) => { console.log(error); process.exit(1); });
