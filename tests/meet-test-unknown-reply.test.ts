/**
 * removeTest (lib/meet-test.ts) reads the reply of the DEL that forgets a creator's test meeting in its exact shape
 * (CX-123 rule 24).
 *
 * The GET of the record is already read exactly on main (#3121, tests/meet-test-exact-read.test.ts). What was left: the
 * DEL that forgets the record after the meeting was deleted on the creator's Zoom or Google account. A reply that is
 * not a count is not known to be done, so removeTest throws TestMeetingUnavailable and the studio route answers 503
 * "try again in a moment", never { ok: true } over a record that may still be there. Asking again deletes the same
 * meeting (never another) and forgets it.
 * Controls: the healthy make / move / remove and a confirmed absent key are unchanged.
 * Synthetic store and a stand-in Zoom only; no provider is reached.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { finishConsent, testKey } from "@/lib/meet-connect";
import { makeTest, moveTest, readTests, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { POST as meetings } from "@/app/api/integrations/meetings/route";
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
const HOST = "marktmorgen.com";
const ORIGIN = `https://${HOST}`;
const providerCalls = () => seen.filter((s) => s.url.startsWith("https://api.zoom.us/v2/meetings") || s.url.endsWith("/users/me/meetings")).map((s) => `${s.method} ${s.url}`);
const named = (e: unknown) => (e instanceof TestMeetingUnavailable ? "TestMeetingUnavailable" : `other: ${String(e).slice(0, 60)}`);

async function fresh(): Promise<{ shop: Store; statsId: string }> {
  redis.clear();
  seen.length = 0;
  const claimed = await claimHandle(OWNER, "harbor-test-meeting", "Harbor Kitchen", "");
  if (!claimed.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  const shop = (await storeForEmail(OWNER))!;
  const statsId = shop.statsId as string;
  const connected = await finishConsent("zoom", { statsId, code: "code-1", verifier: "v".repeat(43), by: OWNER, owner: { email: OWNER, handle: shop.handle }, startedAt: Date.now() });
  if (!connected.ok) throw new Error("not connected");
  return { shop, statsId };
}

async function main(): Promise<void> {
  part("Control: a confirmed absent key means no test meeting");
  {
    const { shop, statsId } = await fresh();
    is("readTests: none", await readTests(statsId, ["zoom"]), {});
    is("removeTest: false, nothing deleted on Zoom", [await removeTest(statsId, "zoom"), providerCalls()], [false, []]);
    is("moveTest: null, nothing moved on Zoom", [await moveTest(shop, "zoom"), providerCalls()], [null, []]);
  }

  part("Control: the healthy make / give back / move / remove");
  {
    const { shop, statsId } = await fresh();
    const first = await makeTest(shop, "zoom");
    is("one meeting made on Zoom", providerCalls(), ["POST https://api.zoom.us/v2/users/me/meetings"]);
    is("its record is read back", (await readTests(statsId, ["zoom"])).zoom, first);
    seen.length = 0;
    is("asked again: the same meeting, none made", [(await makeTest(shop, "zoom")).id, providerCalls()], [first.id, []]);
    const moved = await moveTest(shop, "zoom");
    is("moved an hour later", [moved?.id, moved ? moved.start - first.start : null, providerCalls()], [first.id, 3_600_000, [`PATCH https://api.zoom.us/v2/meetings/${first.id}`]]);
    seen.length = 0;
    is("removed: deleted on Zoom and forgotten", [await removeTest(statsId, "zoom"), providerCalls(), await readTests(statsId, ["zoom"])], [true, [`DELETE https://api.zoom.us/v2/meetings/${first.id}`], {}]);
  }

  part("removeTest reads its DEL: a reply that is not a count is said as not done");
  for (const [label, odd] of [["undefined", undefined], ['"OK"', "OK"], ["-1", -1]] as [string, unknown][]) {
    const { shop, statsId } = await fresh();
    const first = await makeTest(shop, "zoom");
    const real = redis.pipeline;
    // The DEL is not carried out and its reply is lost: the record stays, as after a cut-off write.
    redis.pipeline = async (cmds) => (cmds.some((c) => c[0] === "DEL") ? cmds.map(() => odd) : real(cmds));
    const removed = await removeTest(statsId, "zoom").then((r) => `answered ${r}`, named);
    redis.pipeline = real;
    is(`DEL answers ${label}: removeTest refuses`, removed, "TestMeetingUnavailable");
    seen.length = 0;
    is("asked again with healthy replies: removed, the delete repeated safely", await removeTest(statsId, "zoom"), true);
    is("the same meeting, never another", providerCalls(), [`DELETE https://api.zoom.us/v2/meetings/${first.id}`]);
  }

  part("The studio route answers 503 when the DEL's reply is not a count, never ok");
  {
    const { shop, statsId } = await fresh();
    const first = await makeTest(shop, "zoom");
    const session = await openSession(OWNER);
    const send = (body: Record<string, unknown>) =>
      new NextRequest(`${ORIGIN}/api/integrations/meetings?store=${shop.sid}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const real = redis.pipeline;
    redis.pipeline = async (cmds) => (cmds.some((c) => c[0] === "DEL" && c[1] === testKey(statsId, "zoom")) ? cmds.map(() => "OK") : real(cmds));
    seen.length = 0;
    const res = await meetings(send({ action: "untest", provider: "zoom" }));
    const body = (await res.json()) as { ok?: boolean; error?: string };
    redis.pipeline = real;
    is("untest answers 503 unavailable", [res.status, body.ok, body.error], [503, false, "unavailable"]);
    is("the record is still there to be removed again", (await readTests(statsId, ["zoom"])).zoom, first);
  }

  done();
}
main();
