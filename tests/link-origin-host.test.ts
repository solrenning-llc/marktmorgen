/**
 * Four public "email me a link" forms build the
 * one-time link from the request's own host (originFrom) instead of
 * linkOrigin. Every domain a creator connects is served by this same app, so
 * a POST sent to one creator's domain (a script sends no Origin header, so
 * fromAnotherSite lets it through) for a victim's address emails the victim a
 * genuine Marktmorgen message whose token link points at that domain. The
 * creator who controls its DNS receives the token when the victim clicks.
 *
 * Expected (the defense lib/request-origin.ts linkOrigin documents): the link
 * uses SITE_URL whenever the host is neither this site nor the very store's
 * domain.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { rememberBuyers } from "@/lib/buyer-library";

import { rememberAffiliate } from "@/lib/affiliate-hub";
import { linkOrigin } from "@/lib/request-origin";
import { SITE_URL } from "@/lib/site-url";
import { POST as libraryRoute } from "@/app/api/library/route";
import { POST as affiliateRoute } from "@/app/api/affiliate/route";
import { POST as eraseRoute } from "@/app/api/privacy/erase/route";
import { POST as reportRoute } from "@/app/api/report/route";
import { POST as takedownRoute } from "@/app/api/takedown/route";
import { storeForHandle as readStore } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String([body.to].flat()[0]), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

async function paidStore(handle: string): Promise<Store> {
  const owner = `owner@${handle}.example`;
  await claimHandle(owner, handle, handle, "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, `acct_1${handle.replace(/[^a-z]/g, "").padEnd(14, "x").slice(0, 14)}`, true);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/[^a-z0-9]/g, "")}`, subscriptionId: `sub_${handle.replace(/[^a-z0-9]/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

/** What a script sends to a creator's connected domain: no Origin, no Sec-Fetch-Site. */
const ATTACKER_HOST = "mallory-shop.example";
let ip = 0;
function post(path: string, fields: Record<string, string>): NextRequest {
  ip += 1;
  return new NextRequest(`https://${ATTACKER_HOST}${path}`, {
    method: "POST",
    headers: { host: ATTACKER_HOST, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `198.51.100.${ip}` },
    body: new URLSearchParams(fields),
  });
}

const linkIn = (text: string) => text.match(/https?:\/\/[^\s]+token=[0-9a-f]{64}/)?.[0] ?? text.match(/https?:\/\/[^\s]+\/takedown\/[0-9a-f]{48}/)?.[0] ?? "";
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_erasure_scope_all_only_a_stand_in";
  const shop = await paidStore("victim-shop");
  const VICTIM = "victim-buyer@example.com";
  await rememberBuyers(shop.sid, [VICTIM]);
  await rememberAffiliate(shop.sid, VICTIM);

  is("control: linkOrigin on that same request would give this site", linkOrigin(post("/api/library", {})), SITE_URL);

  part("Buyer library (/api/library)");
  let from = sent.length;
  await libraryRoute(post("/api/library", { email: VICTIM }));
  let link = linkIn(sent.slice(from).map((m) => m.text).join("\n"));
  is("the victim was emailed a library link", link !== "", true);
  is("the library link points at this site, not at the host the request named", link.startsWith(`${SITE_URL}/`), true);

  part("Affiliate hub (/api/affiliate)");
  from = sent.length;
  await affiliateRoute(post("/api/affiliate", { email: VICTIM }));
  link = linkIn(sent.slice(from).map((m) => m.text).join("\n"));
  is("the victim was emailed an affiliate link", link !== "", true);
  is("the affiliate link points at this site", link.startsWith(`${SITE_URL}/`), true);

  part("Deletion (/api/privacy/erase)");
  from = sent.length;
  await eraseRoute(post("/api/privacy/erase", { action: "ask", email: VICTIM, scope: "all" }));
  await settle();
  link = linkIn(sent.slice(from).map((m) => m.text).join("\n"));
  is("the victim was emailed a deletion link", link !== "", true);
  is("the deletion link points at this site", link.startsWith(`${SITE_URL}/`), true);
  part("Notice to the support inbox (/api/report), whose link acts on any store");
  from = sent.length;
  const filed = await reportRoute(new NextRequest(`https://${ATTACKER_HOST}/api/report`, {
    method: "POST",
    headers: { host: ATTACKER_HOST, "content-type": "application/json", "x-forwarded-for": "198.51.100.200" },
    body: JSON.stringify({ kind: "other", url: `${SITE_URL}/@${shop.handle}`, work: "Synthetic notice for a test, nothing real here.", name: "Mallory", email: "mallory@example.com", signature: "Mallory", goodFaith: true, accurate: true }),
  }));
  is("the notice was filed", filed.status, 200);
  link = linkIn(sent.slice(from).map((m) => m.text).join("\n"));
  is("the support inbox got the takedown link", link !== "", true);
  is("the takedown link points at this site", link.startsWith(`${SITE_URL}/`), true);
  // Whoever reads the token off that host acts with it, no session asked:
  const token = link.split("/takedown/")[1] ?? "";
  const acted = await takedownRoute(new NextRequest(`${SITE_URL}/api/takedown`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, action: { type: "store", on: true } }),
  }));
  console.log("takedown with the leaked token:", acted.status, await acted.text(), "suspended:", (await readStore(shop.handle))?.suspended ?? null);
  console.log("links seen:", sent.map((m) => linkIn(m.text)).filter(Boolean));

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
