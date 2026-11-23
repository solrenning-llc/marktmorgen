import { test } from "node:test";
import assert from "node:assert/strict";
import { hostSync, hostCalendarKeys, removeHostIcs } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { seal } from "@/lib/secret-box";
import { type Store, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { state } from "./host-calendar-late-refresh-world";
process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
const email = "late-calendar@example.com";
const host = hostId(email);
const [cfg, good, err] = hostCalendarKeys(host);
const store = { statsId: "late-calendar-stats", sid: "", email: "" };
/** The live store the host serves: removeHostIcs writes only while it is live (#5010 rows 54 to 56). */
let live: Store;
async function seed() {
  redis.clear();
  await claimHandle(email, "latecalendarshop", "Late calendar", "");
  await ensureStatsId(email);
  live = (await storeForEmail(email))!;
  state.fails = false;
  state.during = async () => {};
  await redis.pipeline([["SET", cfg, JSON.stringify({email, source:"ics", read:[], write:"", ics:seal("https://calendar.example.test/private.ics", `hostcal|${host}|ics`), icsAddedAt:"2026-11-20"})]]);
}
for (const outcome of ["success", "failure"] as const) {
  for (const action of ["unchanged", "remove", "erased"] as const) {
    test(`late host refresh ${outcome}: ${action}`, async () => {
      await seed();
      state.fails = outcome === "failure";
      state.during = async () => {
        if (action === "remove") await removeHostIcs(live, email);
        // Same four-key deletion as the last-store calendar cleanup.
        if (action === "erased") await redis.pipeline([["DEL", ...hostCalendarKeys(host)]]);
      };
      const reading = await hostSync(store, email, "UTC", {now:state.now, force:true});
      const kept = await redis.pipeline([["GET", good], ["GET", err]]);
      if (action === "unchanged") {
        assert.equal(reading.state, outcome === "success" ? "ok" : "failed");
        assert.equal(typeof kept[outcome === "success" ? 0 : 1], "string");
      } else {
        assert.deepEqual(kept, [null, null], "a forgotten calendar's reading and error stay absent");
        assert.deepEqual(reading.busy, [], "late private busy intervals are not answered after removal");
        assert.equal(reading.state, "failed");
      }
    });
  }
}

for (const reply of [[], [null], ["1"], [1, 0], Array(1)]) {
  test(`unconfirmed reading fence ${JSON.stringify(reply)} never answers busy intervals`, async () => {
    await seed();
    const run = redis.pipeline.bind(redis);
    let commits = 0;
    redis.pipeline = (async (commands) => {
      if (commands[0]?.[0] === "EVAL" && String(commands[0][1]).includes("host-reading-current:v1")) { commits++; return reply; }
      return run(commands);
    }) as typeof redis.pipeline;
    try {
      const reading = await hostSync(store, email, "UTC", {now:state.now, force:true});
      assert.equal(reading.state, "failed");
      assert.deepEqual(reading.busy, []);
      assert.equal(commits, 1, "an unconfirmed commit does not buy a second error write");
    } finally { redis.pipeline = run; }
  });
}
