/**
 * The PayPal connect's mark is written only while the store is live (lib/paypal-sales.ts, markOnboarding).
 *
 * The mark (nl:ppsell:start:<statsId>, a day) was a plain SET EX: a connect started after the store's erasure began
 * wrote it back after the erasure had begun, so an erased store kept a mark under its statsId for a day (Codex
 * L-20261120-0310; the erasure does not delete this family, which runs out within a day, lib/data-families.ts). Now the write goes through the store's fence (lib/live-fence.ts, SET_IF_STORE_LIVE): a store
 * erasing or gone gets null and nothing written, and the connect route sends the creator back to the studio with
 * "error" instead of to PayPal. Adapted from Claude 7 xAF's test on #5109 (closed as a duplicate of this fix).
 *
 * Real code over the in-memory Redis; synthetic records only; PayPal's API answered by a stub.
 */
import { NextRequest } from "next/server";
import { POST as connect } from "@/app/api/store/paypal/connect/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { ONBOARDING_SECONDS, markOnboarding, onboardingStarted } from "@/lib/paypal-sales";
import { ERASING_KEY, claimHandle, closeStoreRecord, ensureStatsId, ensureStoreId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.PAYPAL_PARTNER_CLIENT_ID = "partner-client-fence";
process.env.PAYPAL_PARTNER_SECRET = "partner-secret-fence";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH02";
process.env.PAYPAL_BN_CODE = "BN_FENCE";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname !== "api-m.paypal.com") throw new Error(`Unexpected synthetic provider request: ${url}`);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAfence", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/customer/partner-referrals" && init?.method === "POST") {
    return json({ links: [{ href: "https://www.paypal.com/bizsignup/partner/entry?referralToken=fence", rel: "action_url", method: "GET" }] }, 201);
  }
  throw new Error(`Unexpected synthetic provider request: ${url}`);
}) as typeof fetch;

type Batch = (string | number)[][];
const original = redis.pipeline.bind(redis);
/** The plain SET the mark used to be written with: never sent any more. */
let plainMarks = 0;
redis.pipeline = (async (batch: Batch) => {
  if (batch.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:start:"))) plainMarks += 1;
  return original(batch);
}) as typeof redis.pipeline;

let shops = 0;
async function shop() {
  shops += 1;
  const email = `paypal-fence-${shops}@example.com`;
  is(`synthetic store ${shops}`, (await claimHandle(email, `paypalfence${shops}`, "A store", "")).ok, true);
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = (await storeForEmail(email))!;
  return { email, store, statsId: store.statsId!, field: await erasingField(storeRef(store)), key: `nl:ppsell:start:${store.statsId}` };
}
const ttl = async (key: string) => Number((await original([["TTL", key]]))[0]);

async function main() {
  part("Control: a live store's mark is written through the fence, for a day");
  const live = await shop();
  const attempt = await markOnboarding(live.store);
  is("the mark is the attempt", await onboardingStarted(live.statsId), attempt);
  const kept = await ttl(live.key);
  is("kept for the onboarding's day", kept > 0 && kept <= ONBOARDING_SECONDS, true);
  is("no plain SET of the mark", plainMarks, 0);

  part("A store whose erasure has begun: nothing is written, and no attempt is answered");
  const erasing = await shop();
  await original([["HSET", ERASING_KEY, erasing.field, String(Date.now())]]);
  is("no attempt is answered", await markOnboarding(erasing.store), null);
  is("no mark under the erasing store's statsId", await onboardingStarted(erasing.statsId), false);
  await original([["HDEL", ERASING_KEY, erasing.field]]);
  is("the erasing mark lifted, the connect marks again", typeof (await markOnboarding(erasing.store)), "string");

  part("A store closed meanwhile: the fence finds its key gone, nothing is written");
  const closed = await shop();
  const before = closed.store;
  is("closed", await closeStoreRecord(closed.store), true);
  is("no attempt is answered", await markOnboarding(before), null);
  is("no mark under the closed store's statsId", await onboardingStarted(closed.statsId), false);

  part("The connect route, with the store erasing: back to the studio with \"error\", not to PayPal, and no mark");
  const routed = await shop();
  const cookie = `${SESSION_COOKIE}=${await openSession(routed.email)}`;
  const post = () => connect(new NextRequest(`https://marktmorgen.com/api/store/paypal/connect?store=${routed.store.sid}`, { method: "POST", headers: { cookie, origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
  await original([["HSET", ERASING_KEY, routed.field, String(Date.now())]]);
  const answer = await post();
  const location = new URL(answer.headers.get("location") ?? "", "https://marktmorgen.com");
  is("303 back to the studio", [answer.status, location.hostname], [303, "marktmorgen.com"]);
  is("saying error", location.searchParams.get("paypal"), "error");
  is("and no mark", await onboardingStarted(routed.statsId), false);
  await original([["HDEL", ERASING_KEY, routed.field]]);
  const again = await post();
  is("the erasing mark lifted, the route sends the creator to PayPal", [again.status, new URL(again.headers.get("location") ?? "", "https://marktmorgen.com").hostname], [303, "www.paypal.com"]);
  is("with the mark written", typeof (await onboardingStarted(routed.statsId)), "string");
  is("never by a plain SET", plainMarks, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
