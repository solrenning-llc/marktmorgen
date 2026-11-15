/**
 * "Start in Zoom" spends one of the store's host links (30 per 10 minutes)
 * on a GET, and the site-wide guard checks the sender only on other methods
 * (proxy.ts, guardApi). A page on another site could send a signed-in owner's
 * browser there 30 times and leave the real button "limited" when the creator
 * needs to start a booked call (#4587). A cross-site request now goes back to
 * the studio before the counter is touched and before Zoom is asked; the
 * button in the studio (same-origin) still works.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureStatsId, setProductCall, setSubscription, storeForEmail } from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { GET as host } from "@/app/api/integrations/zoom/host/route";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
process.env.ZOOM_LIVE = "1";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";

const OWNER = "zoom-host-site@example.com";
const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;

const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  asked.push(`${url.hostname}${url.pathname}`);
  return new Response(JSON.stringify({ error: "not in this test" }), { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []],
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

/** Every key the host-link counter wrote for this store. */
async function counted(): Promise<string[]> {
  const [scan] = (await redis.pipeline([["SCAN", "0", "MATCH", "*meet-host*", "COUNT", "1000"]])) as [[string, string[]]];
  return scan[1];
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  await claimHandle(OWNER, "zoom-host-site", "Zoom Host Site", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ZoomHostSite01", subscriptionId: "sub_ZoomHostSite01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const made = await addProduct(OWNER, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(OWNER, made.product.id, weekly);
  const store = (await storeForEmail(OWNER))!;
  if (!store.callsId) throw new Error("no calls id");
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const scope = `c:${store.callsId}:b:session0001`;
  const ask = (headers: Record<string, string>) =>
    host(new NextRequest(`${ORIGIN}/api/integrations/zoom/host?store=${store.sid}&scope=${encodeURIComponent(scope)}`, { headers: { host: HOST, cookie, ...headers } }));

  part("A request from another site");
  const before = asked.length;
  const away = await ask({ "sec-fetch-site": "cross-site" });
  is("goes back to the studio", [away.status, (away.headers.get("location") ?? "").startsWith(`${ORIGIN}/studio`)], [303, true]);
  is("spends none of the store's host links", await counted(), []);
  is("and Zoom is never asked", asked.slice(before), []);
  const sameSite = await ask({ "sec-fetch-site": "same-site" });
  is("another subdomain is another site too", [sameSite.status, await counted()], [303, []]);
  const foreign = await ask({ origin: "https://attacker.example" });
  is("so is a foreign Origin", [foreign.status, await counted()], [303, []]);

  part("The button in the studio");
  await ask({ "sec-fetch-site": "same-origin" });
  is("is counted as before", (await counted()).length > 0, true);

  done();
}

void main();
