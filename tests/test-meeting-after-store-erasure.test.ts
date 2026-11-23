/**
 * Existing-export behavioral RED: real finishConsent, makeTest and moveTest with a synthetic Zoom fetch.
 * The store is erased while the provider responds, OR immediately before the final Redis commit.
 * Codex L-20261120-1540 (#5010, meeting writers lane); the final write is lib/live-fence.ts KEEP_IF_STORE_LIVE.
 */
import { claimHandle, closeStoreRecord, ensureStatsId, ERASING_KEY, erasingField, storeRef, type Store } from "@/lib/store";
import { finishConsent, testKey } from "@/lib/meet-connect";
import { makeTest, moveTest, readTests, removeTest, TestMeetingUnavailable } from "@/lib/meet-test";
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
  redis.pipeline = real;
  done();
}
main().catch((error) => { redis.pipeline = real; console.error(error); process.exit(1); });
