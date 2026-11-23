/**
 * Existing-export behavioral RED: real finishConsent, makeTest and moveTest with a synthetic Zoom fetch.
 * The store is erased while the provider responds, OR immediately before the final Redis commit.
 * Codex L-20261120-1540 (#5010, meeting writers lane); the final write is lib/live-fence.ts KEEP_IF_STORE_LIVE.
 */
import { claimHandle, closeStoreRecord, ensureStatsId, ERASING_KEY, erasingField, storeRef, type Store } from "@/lib/store";
import { finishConsent, testKey } from "@/lib/meet-connect";
import { makeTest, moveTest, readTests, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/integrations/meetings/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
process.env.NIMBUS_DATA_KEY = "synthetic-meeting-test-erasure-key-not-for-production";
process.env.ZOOM_CLIENT_ID = "synthetic-client";
process.env.ZOOM_CLIENT_SECRET = "synthetic-secret";
process.env.ZOOM_WEBHOOK_SECRET_TOKEN = "synthetic-webhook-secret";
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let target = "";
let providerBoundary: (() => Promise<void>) | null = null;
let commitBoundary: (() => Promise<void>) | null = null;
let crossed = 0, number = 86_000_000_000;
let distortReply = false;
let atProvider: (() => void) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const writing = commands.some((c) => (c[0] === "SET" && c[1] === target) || (c[0] === "EVAL" && c[5] === target));
  if (writing && commitBoundary) {
    const hook = commitBoundary; commitBoundary = null; crossed += 1;
    await hook();
  }
  const result = await real(commands);
  return writing && distortReply ? [] : result;
}) as typeof redis.pipeline;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (status: number, value: unknown) => new Response(status === 204 ? null : JSON.stringify(value), { status });
  if (url.hostname === "zoom.us" && url.pathname === "/oauth/token") {
    return json(200, { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
      scope: "meeting:write:meeting meeting:read:meeting user:read:user" });
  }
  if (url.hostname === "api.zoom.us" && url.pathname === "/v2/users/me") {
    return json(200, { id: "synthetic-user", email: "provider@example.com", first_name: "Synthetic", last_name: "Owner" });
  }
  if (url.hostname === "api.zoom.us" &&
      ((url.pathname === "/v2/users/me/meetings" && method === "POST") || (/^\/v2\/meetings\/\d+$/.test(url.pathname) && method === "PATCH"))) {
    if (atProvider) atProvider();
    if (providerBoundary) { const hook = providerBoundary; providerBoundary = null; crossed += 1; await hook(); }
    if (method === "PATCH") return json(204, null);
    number += 1;
    return json(201, { id: number, join_url: `https://us05web.zoom.us/j/${number}?pwd=synthetic-private` });
  }
  if (url.hostname === "api.zoom.us" && /^\/v2\/meetings\/\d+$/.test(url.pathname) && method === "DELETE") return json(204, null);
  throw new Error("Unexpected external request in synthetic regression: " + url.hostname + url.pathname);
}) as typeof fetch;
const OWNER = "test-meeting-erasure@example.com";
async function fixture(): Promise<Store> {
  redis.clear(); providerBoundary = null; commitBoundary = null; crossed = 0; target = ""; distortReply = false;
  const claimed = await claimHandle(OWNER, "test-meeting-erasure", "Synthetic", "");
  if (!claimed.ok) throw new Error("claim failed");
  const store = (await ensureStatsId(OWNER))!;
  // Exercise the already-existing unfunded path. Never change funding approval or a feature flag.
  if (store.period?.funded === true) throw new Error("fixture unexpectedly funded");
  const consent = { statsId: store.statsId!, code: "synthetic", verifier: "v".repeat(43), by: OWNER,
    owner: { email: OWNER, handle: store.handle }, startedAt: Date.now(), sid: store.sid, ref: storeRef(store) };
  if (!(await finishConsent("zoom", consent)).ok) throw new Error("synthetic connection failed");
  target = testKey(store.statsId!, "zoom");
  return store;
}
async function erase(store: Store, state: "closed" | "erasing" | "legacy-replaced"): Promise<void> {
  await real([["DEL", target, `nl:meet:conn:${store.statsId}:zoom`]]);
  if (state === "erasing") {
    await real([["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"]]);
  } else {
    if (!(await closeStoreRecord(store))) throw new Error("close failed");
    if (state === "legacy-replaced") {
      if (!(await claimHandle(OWNER, "test-meeting-replacement", "Replacement", "")).ok) throw new Error("replacement failed");
      await ensureStatsId(OWNER);
    }
  }
}
async function main(): Promise<void> {
  part("Live create/move/read/remove still work, with the original persistent record");
  {
    const store = await fixture();
    const first = await makeTest(store, "zoom");
    const moved = await moveTest(store, "zoom");
    is("same private link/id survives a live move", [moved?.id, moved?.link], [first.id, first.link]);
    is("original persistent retention", (await real([["TTL", target]]))[0], -1);
    is("live read", (await readTests(store.statsId, ["zoom"])).zoom?.id, first.id);
    is("existing cleanup retained", await removeTest(store, "zoom"), true);
  }
  for (const operation of ["make", "move"] as const) for (const phase of ["provider", "commit"] as const)
    for (const state of ["closed", "erasing", "legacy-replaced"] as const) {
      part(operation + " / " + phase + " / " + state);
      const current = await fixture();
      if (operation === "move") await makeTest(current, "zoom");
      const snapshot = state === "legacy-replaced" ? { ...current, sid: "" } : current;
      const hook = () => erase(current, state);
      if (phase === "provider") providerBoundary = hook; else commitBoundary = hook;
      const outcome = await (operation === "make" ? makeTest(snapshot, "zoom") : moveTest(snapshot, "zoom")).catch((error) => error);
      is("actual boundary reached once", crossed, 1);
      is("does not confirm a link was kept", outcome instanceof TestMeetingUnavailable, true);
      is("no private link recreated", (await real([["EXISTS", target]]))[0], 0);
      is("no local test record exposed", await readTests(current.statsId, ["zoom"]), {});
    }
  part("A lost final write receipt never confirms that the private link was kept");
  {
    const store = await fixture();
    distortReply = true;
    const outcome = await makeTest(store, "zoom").catch((error) => error);
    is("unknown receipt is unavailable", outcome instanceof TestMeetingUnavailable, true);
    distortReply = false;
    // A timeout can follow a live write. Do not delete a legitimate live record by guessing it did not happen.
    is("the live write may have landed", (await readTests(store.statsId, ["zoom"])).zoom !== undefined, true);
  }
  // The whole route, as a creator presses it, against the units it takes before the provider is called (coordinator's
  // rules 964c and e931): a studio request ("settings") and an integration unit ("meet-manage"), both taken before the
  // create or move, checked at the provider's call. Every command sent counts, and the commands the stand-in's
  // scripts run inside an EVAL (the store-live keep's HGET, GET and SET among them), plus the take and lockedUntil
  // allowances the studio unit carries.
  part("The real test and move-test routes stay within the studio and integration units they take first");
  const allowed = (kind: string) => redis.keys().filter((k) => k.startsWith(`nl:allow:${kind}:`)).reduce((n, k) => n + Number(redis.run(["GET", k]) ?? 0), 0);
  // The commands the studio and integration units price (tests/plan-cost-registry.ts UNIT_COST), tied to the registry.
  const STUDIO_COMMANDS = 20 + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS, INTEGRATION_COMMANDS = 10 + TAKE_COMMANDS;
  const UNIT_COMMANDS = STUDIO_COMMANDS + INTEGRATION_COMMANDS;
  is("the studio unit is priced at these commands", request("studio", STUDIO_COMMANDS, 50_000), UNIT_COST.studio);
  is("the integration unit is priced at these commands", request("wait", INTEGRATION_COMMANDS, 21_024), UNIT_COST.integration);
  for (const action of ["test", "movetest"] as const) {
    const store = await fixture();
    if (action === "movetest") await makeTest(store, "zoom");
    const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
    let external = 0, keeps = 0;
    const counting = redis.pipeline;
    const before = redis.scriptCalls;
    const studioBefore = allowed("studio"), integrationBefore = allowed("integration");
    let takenFirst: [boolean, boolean] | null = null;
    atProvider = () => { takenFirst = [allowed("studio") > studioBefore, allowed("integration") > integrationBefore]; };
    redis.pipeline = (async (commands: Command[]) => {
      external += commands.length;
      keeps += commands.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-keep-live:v1\n")).length;
      return counting(commands);
    }) as typeof redis.pipeline;
    try {
      const response = await POST(new NextRequest("https://marktmorgen.com/api/integrations/meetings", { method: "POST", headers: { host: "marktmorgen.com", cookie, "content-type": "application/json", origin: "https://marktmorgen.com" }, body: JSON.stringify({ action, provider: "zoom" }) }));
      is(`${action}: the route answers`, response.status, 200);
      const measured = external + (redis.scriptCalls - before) + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
      console.log("TEST_MEETING_ROUTE_COST", action, JSON.stringify({ external, scriptCalls: redis.scriptCalls - before, keeps, measured }));
      is(`${action}: kept once, through the fence`, keeps, 1);
      is(`${action}: the studio and integration units are both taken before the provider is called`, takenFirst, [true, true]);
      // Held against the commands the two units price, not their dollars: the integration unit's dollars mostly price
      // its wait, which this route spends on the provider call, so a dollar check would let 74 commands pass where the
      // two units price 41 (Claude 4 AC's LEVE on #5221). Each figure is tied to UNIT_COST so a change there shows here.
      is(`${action}: inside those two units' commands (${measured} of ${UNIT_COMMANDS})`, measured <= UNIT_COMMANDS, true);
    } finally { redis.pipeline = counting; atProvider = null; }
  }

  redis.pipeline = real;
  done();
}
main().catch((error) => { redis.pipeline = real; console.error(error); process.exit(1); });
