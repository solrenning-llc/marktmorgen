/**
 * An affiliate signing out of their page on this browser, said exactly (CX-123 rule 24; Claude 6's audit, round 3).
 *
 * The sign-out swallowed a failed delete of the affiliate's session (`.catch(() => {})`) and said "You are signed
 * out on this browser" all the same. The browser's cookie went, but the session lived on at the server, so a copied
 * cookie still opened the affiliate's email address and commissions while the page said they were signed out.
 *
 * As at the creator's sign-out (app/api/auth/signout; tests/auth-sessions-exact.test.ts): the cookie goes whatever
 * happens, and "signed out" is said only when ending the session did not fail; otherwise the page says the session
 * may still be open. The healthy path and a browser with no session answer as before.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { affiliateCookieName, affiliateForSession, joinAsBuyer } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { POST as signOut } from "@/app/api/store/affiliates/signout/route";
import { store as redis } from "./redis-stub";

type Command = (string | number)[];

const SITE = "https://marktmorgen.com";
const HANDLE = "harbor";
const COOKIE = affiliateCookieName(HANDLE);
const isSessionDelete = (c: Command) => c[0] === "DEL" && String(c[1]).startsWith("nl:aff:session:");

// The creator's Stripe account, read back for the order that lets a buyer join (as in tests/buyer-affiliates.test.ts).
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const found = url.pathname === "/v1/checkout/sessions/cs_test_dana000000001";
  const body = found
    ? {
        id: "cs_test_dana000000001",
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        amount_total: 2700,
        currency: "usd",
        created: Math.floor(Date.now() / 1000),
        customer_details: { email: "dana@example.com" },
        metadata: { store: HANDLE, product: "p8w2m4q9zz" },
      }
    : { error: { message: "No such checkout.session" } };
  return new Response(JSON.stringify(body), { status: found ? 200 : 404 });
}) as typeof fetch;

/** A store with an affiliate signed in on this browser, in a clean synthetic Redis. */
async function signedIn() {
  process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_signout_a_stand_in";
  redis.clear();
  const made = await claimHandle("owner@example.com", HANDLE, "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, buyers: true, rates: {} });
  const store = await storeForEmail("owner@example.com");
  if (!store) throw new Error("no store");
  const joined = await joinAsBuyer(store, "cs_test_dana000000001");
  if (!joined.ok) throw new Error(`could not join: ${joined.reason}`);
  assert.equal((await affiliateForSession(store, joined.session))?.id, joined.affiliate.id);
  return { store, session: joined.session };
}

const post = (session?: string) => {
  const form = new FormData();
  form.set("handle", HANDLE);
  return new NextRequest(`${SITE}/api/store/affiliates/signout`, {
    method: "POST",
    body: form,
    headers: { host: "marktmorgen.com", origin: SITE, ...(session ? { cookie: `${COOKIE}=${session}` } : {}) },
  });
};

/** Runs `work` with the session's delete failing at Redis; every other command reaches the store as usual. */
async function deleteFailing<T>(work: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = async (commands: Command[]) => {
    if (commands.some(isSessionDelete)) throw new Error("Redis error: a stand-in failure");
    return original(commands);
  };
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

const cookieCleared = (response: Response) => response.headers.getSetCookie().some((c) => c.startsWith(`${COOKIE}=;`) && c.includes("Max-Age=0"));

test("affiliate sign-out, its delete failing: this browser's cookie goes, but the page never says signed out", async () => {
  const { store, session } = await signedIn();
  const response = await deleteFailing(() => signOut(post(session)));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${SITE}/@${HANDLE}/affiliates?status=signedout-unknown`);
  assert.notEqual(response.headers.get("location"), `${SITE}/@${HANDLE}/affiliates?status=signedout`);
  assert.equal(cookieCleared(response), true);
  // The session is still open at the server: exactly what the page must not deny.
  assert.ok(await affiliateForSession(store, session));
});

test("the page has words for a sign-out that may not have ended the session, in every store language", () => {
  for (const language of LANGUAGE_CODES) {
    const notice = affiliatesWords(language).notices["signedout-unknown"];
    assert.ok(notice, `no notice in ${language}`);
    assert.ok(notice.title && notice.body, `an empty notice in ${language}`);
    assert.notEqual(notice.title, affiliatesWords(language).notices.signedout.title, `said as signed out in ${language}`);
  }
});

test("affiliate sign-out, read in its shape: the session is gone and said so", async () => {
  const { store, session } = await signedIn();
  const response = await signOut(post(session));
  assert.equal(response.headers.get("location"), `${SITE}/@${HANDLE}/affiliates?status=signedout`);
  assert.equal(cookieCleared(response), true);
  assert.equal(await affiliateForSession(store, session), null);
});

test("affiliate sign-out with no session on this browser: nothing to end, said as signed out", async () => {
  await signedIn();
  const response = await signOut(post());
  assert.equal(response.headers.get("location"), `${SITE}/@${HANDLE}/affiliates?status=signedout`);
  assert.equal(cookieCleared(response), true);
});
