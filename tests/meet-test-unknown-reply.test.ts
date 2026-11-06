/**
 * A creator's test meeting (lib/meet-test.ts) is read only in its exact shape (CX-123 rule 24).
 *
 * Its record is the only way the studio knows which meeting it made on the creator's Zoom or Google account. A GET
 * reply that is not the record and not Redis's own null for "no key" is unknown, never "no test meeting":
 *   - makeTest refuses, instead of making a SECOND real meeting and writing its record over the first one's (the
 *     first would stay on the creator's account for good, out of reach of the studio);
 *   - moveTest refuses, instead of moving nothing (or moving by a missing time);
 *   - removeTest refuses, instead of answering "there was none" with the meeting still on the creator's account;
 *   - a DEL whose reply is not a count is said as not done;
 *   - the studio route answers an error, never { ok: true }.
 * Controls: the healthy make / move / remove and a confirmed absent key are unchanged.
 * Synthetic store and a stand-in Zoom only; no provider is reached.
 */
import { NextRequest } from "next/server";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { finishConsent, testKey } from "@/lib/meet-connect";
import { makeTest, moveTest, readTests, removeTest } from "@/lib/meet-test";
import { UnknownReplyError } from "@/lib/redis-reply";
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
const named = (e: unknown) => (e instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(e).slice(0, 60)}`);

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

/** Makes the GET of the test record answer `odd` (and, with `replies`, the whole pipeline answer that) until undone. */
function oddGet(key: string, odd: unknown, replies?: unknown): () => void {
  const real = redis.pipeline;
  redis.pipeline = async (cmds) => {
    const out = await real(cmds);
    if (!cmds.some((c) => c[0] === "GET" && c[1] === key)) return out;
    if (replies !== undefined) return replies as unknown[];
    return cmds.map((c, i) => (c[0] === "GET" && c[1] === key ? odd : out[i])) as unknown[];
  };
  return () => { redis.pipeline = real; };
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

  const shapes: [string, unknown][] = [
    ["undefined", undefined],
    ["{}", {}],
    ["1", 1],
    ['["x"]', ["x"]],
    ['"not json"', "not json"],
    ['""', ""],
    ["shapeless JSON", JSON.stringify({ id: 5, link: "https://x" })],
    ["a record without its times", JSON.stringify({ id: "86000000001", link: "https://us05web.zoom.us/j/86000000001" })],
  ];
  for (const [label, odd] of shapes) {
    part(`GET answers ${label}: refused, nothing made, moved or deleted, the first meeting kept`);
    const { shop, statsId } = await fresh();
    const first = await makeTest(shop, "zoom");
    const key = testKey(statsId, "zoom");
    const undo = oddGet(key, odd);
    seen.length = 0;
    const read = await readTests(statsId, ["zoom"]).then(() => "read", named);
    const removed = await removeTest(statsId, "zoom").then((r) => `answered ${r}`, named);
    const moved = await moveTest(shop, "zoom").then((r) => `answered ${JSON.stringify(r)}`, named);
    const made = await makeTest(shop, "zoom").then((r) => `answered ${r.id}`, named);
    const funded = await makeTest({ ...shop, period: { start: 1, end: 2, renews: true, funded: true } } as Store, "zoom").then((r) => `answered ${r.id}`, named);
    undo();
    is("readTests throws UnknownReplyError", read, "UnknownReplyError");
    is("removeTest refuses", removed, "UnknownReplyError");
    is("moveTest refuses", moved, "UnknownReplyError");
    is("makeTest refuses", made, "UnknownReplyError");
    is("makeTest on a paid period refuses on the read, before any paid window", funded, "UnknownReplyError");
    is("nothing reached Zoom's meetings", providerCalls(), []);
    is("the first meeting's record is untouched", (await readTests(statsId, ["zoom"])).zoom, first);
  }

  part("A pipeline answering the wrong number of replies is unknown too");
  for (const [label, replies] of [["[]", []], ["two replies", [null, null]], ["not a list", { result: null }]] as [string, unknown][]) {
    const { shop, statsId } = await fresh();
    const undo = oddGet(testKey(statsId, "zoom"), null, replies);
    seen.length = 0;
    const made = await makeTest(shop, "zoom").then((r) => `answered ${r.id}`, named);
    const removed = await removeTest(statsId, "zoom").then((r) => `answered ${r}`, named);
    undo();
    is(`${label}: makeTest and removeTest refuse, nothing made`, [made, removed, providerCalls()], ["UnknownReplyError", "UnknownReplyError", []]);
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
    is(`DEL answers ${label}: removeTest refuses`, removed, "UnknownReplyError");
    seen.length = 0;
    is("asked again with healthy replies: removed, the delete repeated safely", await removeTest(statsId, "zoom"), true);
    is("the same meeting, never another", providerCalls(), [`DELETE https://api.zoom.us/v2/meetings/${first.id}`]);
  }

  part("The studio route answers an error on an unknown reply, never ok");
  {
    const { shop, statsId } = await fresh();
    const first = await makeTest(shop, "zoom");
    const session = await openSession(OWNER);
    const send = (body: Record<string, unknown>) =>
      new NextRequest(`${ORIGIN}/api/integrations/meetings?store=${shop.sid}`, { method: "POST", headers: { host: HOST, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const undo = oddGet(testKey(statsId, "zoom"), {});
    seen.length = 0;
    const answers: { action: string; status: number; ok: unknown; error: unknown }[] = [];
    for (const action of ["test", "movetest", "untest"]) {
      const res = await meetings(send({ action, provider: "zoom" }));
      const body = (await res.json()) as { ok?: boolean; error?: string };
      answers.push({ action, status: res.status, ok: body.ok, error: body.error });
    }
    undo();
    is("each action answers 503 unavailable", answers, ["test", "movetest", "untest"].map((action) => ({ action, status: 503, ok: false, error: "unavailable" })));
    is("nothing reached Zoom's meetings", providerCalls(), []);
    is("the first meeting's record is untouched", (await readTests(statsId, ["zoom"])).zoom, first);
  }

  done();
}
main();
