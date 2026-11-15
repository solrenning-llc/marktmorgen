/**
 * removeTest's DEL of one test-meeting key (same family as #4797; C7, 15 November 2026): a count read only for its
 * shape took 2 as done. One key deletes at most one; more is not known to be done, so removeTest refuses
 * (TestMeetingUnavailable), as for a reply that is not a count. Synthetic Zoom and the Redis stub.
 */
import { finishConsent } from "@/lib/meet-connect";
import { makeTest, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { claimHandle, ensureStatsId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Seen = { method: string; url: string };
const seen: Seen[] = [];
let meetingNumber = 86_000_000_000;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? "GET").toUpperCase();
  seen.push({ method, url: `${url.origin}${url.pathname}` });
  const json = (status: number, value: unknown) => new Response(status === 204 ? null : JSON.stringify(value), { status });
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") return json(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "meeting:write:meeting meeting:read:meeting user:read:user" });
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me") return json(200, { id: "zoomUser01", email: "host@example.com", first_name: "Jenny", last_name: "Park" });
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me/meetings" && method === "POST") {
    meetingNumber += 1;
    return json(201, { id: meetingNumber, join_url: `https://us05web.zoom.us/j/${meetingNumber}?pwd=abc` });
  }
  if (url.hostname === "api.zoom.us" && /^\/v2\/meetings\/\d+$/.test(url.pathname) && (method === "DELETE" || method === "PATCH")) return json(204, null);
  return json(404, { message: "no stand-in" });
}) as typeof fetch;

process.env.ZOOM_CLIENT_ID = "z-id";
process.env.ZOOM_CLIENT_SECRET = "z-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "z-token";
delete process.env.ZOOM_LIVE;

const OWNER = "meet-test-unknown@example.com";
const named = (e: unknown) => (e instanceof TestMeetingUnavailable ? "TestMeetingUnavailable" : `other: ${String(e).slice(0, 60)}`);

async function fresh(): Promise<{ shop: Store; statsId: string }> {
  redis.clear();
  seen.length = 0;
  const claimed = await claimHandle(OWNER, "harbor-test-meeting", "Harbor Kitchen", "");
  if (!claimed.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId as string;
  const connected = await finishConsent("zoom", { statsId, code: "code-1", verifier: "v".repeat(43), by: OWNER, owner: { email: OWNER, handle: shop.handle } });
  if (!connected.ok) throw new Error("not connected");
  return { shop, statsId };
}

async function main(): Promise<void> {
  part("removeTest reads its DEL of one key: 0 or 1, never more");
  for (const [label, odd, said] of [["2", 2, "TestMeetingUnavailable"], ["7", 7, "TestMeetingUnavailable"], ["1", 1, "answered true"]] as [string, number, string][]) {
    const { shop, statsId } = await fresh();
    await makeTest(shop, "zoom");
    const real = redis.pipeline;
    redis.pipeline = async (cmds) => (cmds.length === 1 && cmds[0][0] === "DEL" ? [odd] : real(cmds));
    const removed = await removeTest(statsId, "zoom").then((r) => `answered ${r}`, named);
    redis.pipeline = real;
    is(`DEL of one key answered ${label}`, removed, said);
  }
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
