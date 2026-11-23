/**
 * Codex L-20261120-0258 (row 35 of #5010, MEDIUM): opening a creator's Stripe account (app/api/stripe/connect) created
 * the account at Stripe, with the creator's address and the store's name, before anything here knew of it. A store
 * deleted while that request was in flight was gone when the answer came back, the account id was thrown away, and
 * an account holding the creator's data was left at Stripe with nothing here able to finish, disconnect or erase it.
 * Two tabs, or a press again after a lost answer, each opened an account of their own.
 *
 * Now the attempt is written on the store before Stripe is asked (beginStripeConnect), with the very address, name
 * and country it sends, and Stripe is asked with one idempotency key per attempt: a press again after a lost answer
 * gets the same account back, never a second one, while Stripe keeps the key (29 days here, inside its 30). For a day
 * after each press, the store is neither deleted ("stripe_connecting") nor closed by the walk. A refusal that says no
 * account was made clears it only when the key had never been sent before; an answer that says nothing certain keeps
 * it for the next press. A store deleted more than a day after its last press, with an answer lost and never pressed
 * again, leaves its account known only to Stripe and the creator: a residue told in #5095, not covered here.
 * Synthetic stores and sessions; Stripe mocked; MemoryRedis (tests/redis-stub.ts).
 */
import { NextRequest } from "next/server";
import { POST as connectPOST } from "@/app/api/stripe/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ERASING_KEY, STRIPE_CONNECT_HOLD_SECONDS, STRIPE_CONNECT_REPLACED_KEPT, STRIPE_CONNECT_REUSE_SECONDS, beginStripeConnect, claimHandle, clearStripeConnect, createStore, deleteStore as deleteWith, erasingField, finishStripeConnect, setCommunity, storeForId, storeRef } from "@/lib/store";
import { BATCH_KEY, StripeConnectingError, prepareStore, queueDeleted } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { LOCKED_UNTIL_STAR_COMMANDS, STRIPE_CONNECT_PRESS_EXTRA_COMMANDS, TAKE_COMMANDS } from "./plan-cost-registry";
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
let answer: "ok" | "lost" | "refused" | "down" | "idempotency" | "replay-gone" = "ok";
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
    if (answer === "replay-gone") {
      // A plain 400 that by itself says nothing was made (a key rotated, a replay Stripe no longer makes): after an
      // earlier send of the same key it proves nothing about what that send made (coordinator's MEDIUM 1 on #5095).
      answer = "ok";
      return Response.json({ error: { type: "invalid_request_error", message: "Synthetic: this request can no longer be replayed." } }, { status: 400 });
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
  const location = new URL(response.headers.get("location") ?? "", "https://marktmorgen.com");
  // The host compared whole, never a prefix of the address (CodeQL js/incomplete-url-substring-sanitization).
  return location.protocol === "https:" && location.host === "connect.stripe.com" ? "onboarding" : location.searchParams.get("stripe");
}

// Each part starts from an empty database: its own stores, and none of the studio's shared pools spent by the parts before.
const reset = () => { redis.clear(); byKey.clear(); opened = 0; keys = []; meanwhile = null; answer = "ok"; };

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

  part("A refusal of a press again never clears an attempt whose key was sent before (coordinator's MEDIUM 1 on #5095)");
  {
    reset();
    const owner = "connect-twice@example.com";
    const store = await extraStore(owner, "connecttwicefirst", "connecttwiceextra");
    answer = "lost";
    is("the first press: Stripe makes the account and the answer is lost", await connect(owner, store.sid), "error");
    const first = (await storeForId(store.sid))?.stripeConnecting;
    answer = "replay-gone";
    is("the press again is refused, and the creator is told why, with a way out", await connect(owner, store.sid), "attempt-refused");
    const kept = (await storeForId(store.sid))?.stripeConnecting;
    is("the attempt stays, the same one, its key sent twice", [kept?.id === first?.id, kept?.sends], [true, 2]);
    is("and the store is still held against deletion", (await deleteStore(storeRef(store))).ok ? "deleted" : "kept", "kept");
    is("clearing it by hand is refused too: its key left more than once", await clearStripeConnect(storeRef(store), store.sid, first?.id ?? ""), false);
    is("a third press finishes it with the same key", await connect(owner, store.sid), "onboarding");
    is("one account at Stripe, the one the first press made", [opened, (await storeForId(store.sid))?.stripeAccountId ?? null, new Set(keys).size], [1, "acct_1Synthetic1", 1]);
  }

  part("Each press holds the store a day again, even on an attempt written days ago (coordinator's MEDIUM 2 on #5095)");
  {
    reset();
    const owner = "connect-repress@example.com";
    const store = await extraStore(owner, "connectrepressfirst", "connectrepressextra");
    const threeDays = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Repress" }, threeDays);
    let deleted = "not tried";
    let walked: unknown = "not tried";
    meanwhile = async () => {
      const read = await storeForId(store.sid);
      try { if (read) await prepareStore(read); walked = "prepared"; } catch (error) { walked = error; }
      const result = await deleteStore(storeRef(store));
      deleted = result.ok ? "deleted" : result.reason;
    };
    is("a press three days on goes on to onboarding", await connect(owner, store.sid), "onboarding");
    is("while Stripe was asked, the deletion was refused", deleted, "stripe_connecting");
    is("and the closing walk waited", walked instanceof StripeConnectingError, true);
    is("the account is written on the store", (await storeForId(store.sid))?.stripeAccountId ?? null, "acct_1Synthetic1");
  }

  part("Another country is allowed a day after the last press, not 29 (coordinator's decision on #5095)");
  {
    reset();
    const owner = "connect-switch@example.com";
    const store = await extraStore(owner, "connectswitchfirst", "connectswitchextra");
    const old = Date.now() - (STRIPE_CONNECT_HOLD_SECONDS + 60) * 1000;
    const german = await beginStripeConnect(storeRef(store), store.sid, { country: "de", email: owner, name: "Switch" }, old);
    const germanId = german && !("other" in german) ? german.id : "none";
    is("a press for France a day and a minute after the German one goes on", await connect(owner, store.sid, "FR"), "onboarding");
    is("asked with a new key, not the German attempt's", keys.length === 1 && keys[0] !== `connect-${store.sid}-${germanId}`, true);
  }

  part("A store whose erasure has begun opens no Stripe account (coordinator's LEVE 3 on #5095)");
  {
    reset();
    const owner = "connect-erasing@example.com";
    const store = await extraStore(owner, "connecterasingfirst", "connecterasingextra");
    await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]]);
    is("the press is refused", await connect(owner, store.sid), "error");
    is("nothing is asked of Stripe", keys.length, 0);
    is("and no attempt is written to hold the half-erased store open", (await storeForId(store.sid))?.stripeConnecting ?? null, null);
  }

  part("The walk's first read of an open attempt touches nothing (coordinator's LEVE 3 on #5095)");
  {
    reset();
    const owner = "connect-untouched@example.com";
    const store = await extraStore(owner, "connectuntouchedfirst", "connectuntouchedextra");
    await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Untouched" });
    const ref = storeRef(store);
    await redis.pipeline([["ZADD", FINAL_INDEX, 1, ref]]);
    const read = await storeForId(store.sid);
    if (!read) throw new Error("no store");
    const sent: (string | number)[][] = [];
    const real = redis.pipeline.bind(redis);
    redis.pipeline = async (commands) => { sent.push(...commands); return real(commands); };
    let thrown: unknown = null;
    try { await prepareStore(read); } catch (error) { thrown = error; }
    redis.pipeline = real;
    is("it waits, saying why", thrown instanceof StripeConnectingError, true);
    is("without a single command sent", sent.length, 0);
    is("its closing day stays in the final line", (await redis.pipeline([["ZSCORE", FINAL_INDEX, ref]]))[0] !== null, true);
    is("no walk entry is written for it", (await redis.pipeline([["HGET", BATCH_KEY, ref]]))[0], null);
    is("and its record, with the attempt, is intact", Boolean((await storeForId(store.sid))?.stripeConnecting), true);
  }

  part("A press costs what the registry prices: the studio unit plus STRIPE_CONNECT_PRESS_EXTRA_COMMANDS (coordinator's df44 on #5095)");
  {
    reset();
    const owner = "connect-cost@example.com";
    const store = await extraStore(owner, "connectcostfirst", "connectcostextra");
    const real = redis.pipeline.bind(redis);
    const sent: (string | number)[][] = [];
    redis.pipeline = (async (commands: (string | number)[][]) => { sent.push(...commands); return real(commands); }) as typeof redis.pipeline;
    let said: string | null;
    try { said = await connect(owner, store.sid); } finally { redis.pipeline = real; }
    // Billed as Upstash bills a script: one, plus every call inside it; from the press's first read of the session on
    // (the helper opens the session first, which is the sign-in's, not the press's).
    const press = sent.slice(Math.max(0, sent.findIndex((c) => c[0] === "GET" && String(c[1]).startsWith("nl:auth:session:"))));
    const billed = press.reduce((sum, c) => sum + (c[0] === "EVAL" ? 1 + (String(c[1]).match(/redis\.call\(/g) ?? []).length : 1), 0);
    is("the press goes on to onboarding", said, "onboarding");
    is(`its billed commands (${billed}) are within the studio unit and the press's own line`, billed <= 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS + STRIPE_CONNECT_PRESS_EXTRA_COMMANDS, true);
    is("and the line is not idle: the second turn of the lock is really there", billed > 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, true);
  }

  part("An attempt past its 29 days is dropped, the creator's address with it (coordinator's df44 on #5095)");
  {
    reset();
    const owner = "connect-expired@example.com";
    const store = await extraStore(owner, "connectexpiredfirst", "connectexpiredextra");
    await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Expired" }, Date.now() - (STRIPE_CONNECT_REUSE_SECONDS + 60) * 1000);
    is("read back, the store holds no attempt any more", (await storeForId(store.sid))?.stripeConnecting ?? null, null);
    const younger = await extraStore("connect-younger@example.com", "connectyoungerfirst", "connectyoungerextra");
    await beginStripeConnect(storeRef(younger), younger.sid, { country: "us", email: "connect-younger@example.com", name: "Younger" }, Date.now() - 28 * 24 * 60 * 60 * 1000);
    is("one younger than 29 days is still kept, for a press again", Boolean((await storeForId(younger.sid))?.stripeConnecting), true);
  }

  part("An answer that comes back just past the 29th day still finds its attempt (Claude 4 3Rj's NIT on #5095)");
  {
    // The press began a moment before the attempt turned 29 days old and Stripe answered a moment after: the attempt is
    // read as none for reuse and holding, but the answer is for it, so the account is written (and a refusal closes it),
    // never left for a press again with a new key, which could open a second account.
    reset();
    const owner = "connect-edge@example.com";
    const store = await extraStore(owner, "connectedgefirst", "connectedgeextra");
    const edge = Date.now() - STRIPE_CONNECT_REUSE_SECONDS * 1000 + 150;
    const attempt = await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Edge" }, edge);
    is("the press writes its attempt just inside the 29 days", Boolean(attempt && "id" in attempt), true);
    await new Promise((done) => setTimeout(done, 300));
    const finished = attempt && "id" in attempt ? await finishStripeConnect(storeRef(store), store.sid, attempt.id, "acct_EdgeAnswer01") : null;
    is("the answer just past the 29th day writes the account", finished?.stripeAccountId ?? null, "acct_EdgeAnswer01");
    is("and closes the attempt", (await storeForId(store.sid))?.stripeConnecting ?? null, null);
    const refusedOwner = "connect-edge-refused@example.com";
    const refused = await extraStore(refusedOwner, "connectedgerefusedfirst", "connectedgerefusedextra");
    const second = await beginStripeConnect(storeRef(refused), refused.sid, { country: "us", email: refusedOwner, name: "Edge" }, Date.now() - STRIPE_CONNECT_REUSE_SECONDS * 1000 + 150);
    await new Promise((done) => setTimeout(done, 300));
    is("a refusal just past the 29th day closes its attempt", second && "id" in second ? await clearStripeConnect(storeRef(refused), refused.sid, second.id) : false, true);
    const other = await extraStore("connect-edge-other@example.com", "connectedgeotherfirst", "connectedgeotherextra");
    const stale = await beginStripeConnect(storeRef(other), other.sid, { country: "us", email: "connect-edge-other@example.com", name: "Edge" }, Date.now() - (STRIPE_CONNECT_REUSE_SECONDS + 60) * 1000);
    is("an answer for another attempt id still writes nothing", stale && "id" in stale ? await finishStripeConnect(storeRef(other), other.sid, "0".repeat(32), "acct_EdgeAnswer02") : null, null);
    is("a stale attempt's own late answer is written too", stale && "id" in stale ? (await finishStripeConnect(storeRef(other), other.sid, stale.id, "acct_EdgeAnswer03"))?.stripeAccountId ?? null : null, "acct_EdgeAnswer03");
  }

  part("An attempt that is replaced or lapses leaves its id on the store's record, never only a log (Claude 1 2as's LOW 2 on #5095)");
  {
    // Past its 29 days, or another country a day after the last press, an attempt is replaced: an account Stripe made
    // with its lost answer can then be found only by its idempotency key, which holds its id. The id, the country and
    // its times stay on the record (never the address or the name), at most STRIPE_CONNECT_REPLACED_KEPT of them.
    reset();
    const owner = "connect-replaced@example.com";
    const store = await extraStore(owner, "crepfirst", "crepextra");
    const old = await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Replaced" }, Date.now() - (STRIPE_CONNECT_REUSE_SECONDS + 60) * 1000);
    const oldId = old && "id" in old ? old.id : "none";
    const fresh = await beginStripeConnect(storeRef(store), store.sid, { country: "us", email: owner, name: "Replaced" });
    const kept = (await storeForId(store.sid))?.stripeConnectReplaced ?? [];
    is("a press past the 29 days writes a new attempt", fresh && "id" in fresh && fresh.id !== oldId, true);
    is("and the old attempt's id and country stay on the record", kept.map((r) => [r.id, r.country]), [[oldId, "us"]]);
    is("without the creator's address or name", JSON.stringify(kept).includes(owner) || JSON.stringify(kept).includes("Replaced"), false);

    const other = await extraStore("connect-replaced-other@example.com", "crepofirst", "crepoextra");
    const ca = await beginStripeConnect(storeRef(other), other.sid, { country: "ca", email: "connect-replaced-other@example.com", name: "Other" }, Date.now() - (STRIPE_CONNECT_HOLD_SECONDS + 60) * 1000);
    await beginStripeConnect(storeRef(other), other.sid, { country: "us", email: "connect-replaced-other@example.com", name: "Other" });
    is("another country a day after the last press: the replaced one is kept", ((await storeForId(other.sid))?.stripeConnectReplaced ?? []).map((r) => [r.id, r.country]), [[ca && "id" in ca ? ca.id : "none", "ca"]]);

    const lapsed = await extraStore("connect-replaced-lapsed@example.com", "creplfirst", "creplextra");
    const gone = await beginStripeConnect(storeRef(lapsed), lapsed.sid, { country: "us", email: "connect-replaced-lapsed@example.com", name: "Lapsed" }, Date.now() - (STRIPE_CONNECT_REUSE_SECONDS + 60) * 1000);
    await setCommunity(storeRef(lapsed), true);
    const after = await storeForId(lapsed.sid);
    is("a lapsed attempt dropped by any later save leaves its id, not its address", [after?.stripeConnecting ?? null, (after?.stripeConnectReplaced ?? []).map((r) => r.id), JSON.stringify(after?.stripeConnectReplaced ?? []).includes("connect-replaced-lapsed@")], [null, [gone && "id" in gone ? gone.id : "none"], false]);

    const many = await extraStore("connect-replaced-many@example.com", "crepmfirst", "crepmextra");
    for (let i = 0; i < STRIPE_CONNECT_REPLACED_KEPT + 2; i += 1) {
      await beginStripeConnect(storeRef(many), many.sid, { country: "us", email: "connect-replaced-many@example.com", name: "Many" }, Date.now() - (STRIPE_CONNECT_REUSE_SECONDS + 60 + (STRIPE_CONNECT_REPLACED_KEPT + 2 - i) * 60) * 1000);
    }
    is(`at most ${STRIPE_CONNECT_REPLACED_KEPT} kept, the newest`, ((await storeForId(many.sid))?.stripeConnectReplaced ?? []).length, STRIPE_CONNECT_REPLACED_KEPT);
  }

  part("A cross-border refusal closes the attempt even after an earlier send (coordinator's df44 on #5095, optional)");
  {
    reset();
    const owner = "connect-border@example.com";
    const store = await extraStore(owner, "connectborderfirst", "connectborderextra");
    answer = "down";
    is("a first press with no answer keeps the attempt", await connect(owner, store.sid), "error");
    answer = "refused";
    is("a press again refused across the border is told so", await connect(owner, store.sid), "country-unsupported");
    is("and the attempt is gone: no account can exist in that country", (await storeForId(store.sid))?.stripeConnecting ?? null, null);
    is("so the store is not held from its deletion", (await deleteStore(storeRef(store))).ok, true);
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
