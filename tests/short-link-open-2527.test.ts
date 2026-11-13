/**
 * #2527's rules on #3330's open path (adopted by Claude 3, nuvem E; coordinator, 13/11/2026): with the open paid by the
 * store (lib/short-link-open.ts, payShortLinkOpen), a store confirmed gone still ends the link, and a link read that
 * comes back empty or garbled never ends it. Each case uses a code no earlier request has seen, with the instance's
 * memory cleared, so nothing remembered can answer for it. Synthetic Redis only.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "@/app/l/[code]/route";
import { addLink } from "@/lib/short-links";
import { forgetShortLinkOpenMemory } from "@/lib/short-link-open";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
let sid = "", statsId = "";
const open = (code: string) => GET(new Request(`https://example.test/l/${code}`) as never, { params: Promise.resolve({ code }) });
const make = async (name: string) => {
  const made = await addLink({ sid, statsId }, { name, place: "other", target: { kind: "store" } }, () => true, 1000);
  if (!made.ok) throw new Error("fixture link unavailable");
  return made.link.code;
};

beforeEach(async () => {
  redis.pipeline = pipeline;
  redis.clear();
  forgetShortLinkOpenMemory();
  await claimHandle("owner2527@example.com", "harbor2527", "Harbor", "");
  await ensureStoreId("owner2527@example.com");
  await ensureStatsId("owner2527@example.com");
  const store = (await storeForEmail("owner2527@example.com"))!;
  sid = store.sid;
  statsId = store.statsId!;
});
afterEach(() => { redis.pipeline = pipeline; });

test("a store confirmed gone ends its link (302 to the ended page), read in the open's own batch", async () => {
  const code = await make("gone-store");
  // Every read of the store's record says "none", wherever in a batch it is asked.
  redis.pipeline = async (commands) => {
    const replies = await pipeline(commands);
    return commands.map((c, i) => (c[0] === "GET" && c[1] === `nl:store:id:${sid}` ? null : replies[i]));
  };
  const response = await open(code);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /\/l\/ended$/);
});

for (const reply of [[], [null, null], [undefined], [0]]) {
  test(`a link read answered ${JSON.stringify(reply)}, on a code never seen, never ends the link`, async () => {
    const code = await make(`unseen-${String(reply.length)}-${String(reply[0])}`);
    redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:slink:${code}` ? reply : pipeline(commands));
    const response = await open(code);
    assert.notEqual(response.headers.get("location")?.endsWith("/l/ended") ?? false, true);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
}
