import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "@/app/l/[code]/route";
import { addLink } from "@/lib/short-links";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
let code: string, sid: string;
beforeEach(async () => {
  redis.pipeline = pipeline;
  redis.clear();
  await claimHandle("owner@example.com", "harbor", "Harbor", "");
  await ensureStoreId("owner@example.com");
  await ensureStatsId("owner@example.com");
  const store = (await storeForEmail("owner@example.com"))!;
  sid = store.sid;
  const made = await addLink({ sid, statsId: store.statsId! }, { name: "post", place: "other", target: { kind: "store" } }, () => true, 1000);
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("fixture link unavailable");
  code = made.link.code;
});
afterEach(() => { redis.pipeline = pipeline; });
const open = () => GET(new Request(`https://example.test/l/${code}`) as never, { params: Promise.resolve({ code }) });

test("confirmed active store still opens its landing page", async () => {
  const response = await open();
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /\/@harbor\?/);
});
test("explicit null store pointer still confirms the existing ended behavior", async () => {
  redis.pipeline = commands => commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${sid}` ? Promise.resolve([null]) : pipeline(commands);
  const response = await open();
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /\/l\/ended$/);
});
for (const stage of ["pointer", "owner-record"] as const) test(`partial ${stage} lookup must not cache an ended link`, async () => {
  let intercepted = 0;
  redis.pipeline = async commands => {
    const key = String(commands[0][1]);
    const target = stage === "pointer" ? key === `nl:store:id:${sid}` : key.startsWith("nl:store:") && !key.startsWith("nl:store:id:");
    if (commands[0][0] === "GET" && target) { intercepted += 1; return []; }
    return pipeline(commands);
  };
  const response = await open();
  assert.equal(intercepted, 1, "the real store reader received the partial reply");
  assert.deepEqual({ status: response.status, location: response.headers.get("location"), cache: response.headers.get("cache-control") }, { status: 503, location: null, cache: "no-store" });
});
test("a thrown store pointer lookup is already handled as retryable", async () => {
  redis.pipeline = async commands => {
    if (commands[0][0] === "GET" && commands[0][1] === `nl:store:id:${sid}`) throw new Error("synthetic transport loss");
    return pipeline(commands);
  };
  const response = await open();
  assert.deepEqual([response.status, response.headers.get("location"), response.headers.get("cache-control")], [503, null, "no-store"]);
});
