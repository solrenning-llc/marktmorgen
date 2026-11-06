/** Residual C4 P1 root: the exact job snapshot is followed by a loose HGET. */
import { runPreorderReleases } from "@/lib/preorders";
import { importedFor } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import type { Listing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { is, done } from "./check";

const SID = "c2preorderproof";
const PID = "prod00000001";
const SESSION = "cs_test_c2preorderproof000001";
const ENTRY = `nl:pre:${SID}:${PID}`;
const JOB = `${SID}|${PID}|synthetic`;
const VALUE = JSON.stringify({ to: "buyer@example.test", at: 1_700_000_000, pi: "" });
const store = { statsId: SID, sid: "", handle: "synthetic", stripeAccountId: "acct_test_c2pre", pastBuyers: true, name: "Synthetic", language: "en", email: "owner@example.test", previousHandles: [], releasedHandles: [] } as unknown as Store;
const product = { id: PID, title: "Synthetic release", course: null } as unknown as Listing;
const deps = { base: "https://example.test", from: "Synthetic <test@example.test>", ordersLink: async () => null, recordStart: async () => {} };
const pipeline = redis.pipeline.bind(redis);

async function main() {
  let total = 0;
  for (const mode of ["healthy", "throw", "missing", "undefined", "false", "brokenJSON", "extra", "sparse"] as const) {
    redis.clear();
    let commands = 0;
    redis.pipeline = async (batch: (string | number)[][]) => {
      commands += batch.length; total += batch.length;
      if (commands > 5_000 || total > 40_000) throw new Error("Synthetic command ceiling exceeded before dispatch");
      if (batch[0]?.[0] === "HGET" && batch[0]?.[1] === ENTRY && batch[0]?.[2] === SESSION) {
        if (mode === "throw") throw new Error("Synthetic record outage");
        if (mode === "missing") return [];
        if (mode === "undefined") return [undefined];
        if (mode === "false") return [false];
        if (mode === "brokenJSON") return ["{"];
        if (mode === "extra") return [VALUE, "extra"];
        if (mode === "sparse") return Array<unknown>(1);
      }
      return pipeline(batch);
    };
    try {
      await redis.pipeline([["SADD", "nl:pre:jobs", JOB], ["HSET", ENTRY, SESSION, VALUE]]);
      const given = await runPreorderReleases(async () => store, async () => product, () => deps, Date.now() + 5_000);
      const [jobs, raw] = await redis.pipeline([["SMEMBERS", "nl:pre:jobs"], ["HGETALL", ENTRY]]);
      const rows = await importedFor(store, "buyer@example.test");
      const record = Array.isArray(raw) ? JSON.parse(String(raw[1])) as { given?: number } : null;
      console.log(JSON.stringify({ mode, given, jobs, grants: rows.length, recordedGiven: Boolean(record?.given), commands }));
      if (mode === "healthy") {
        is("healthy: exactly one delivery is recorded", [given, rows.length], [1, 1]);
        is("healthy: the completed job is removed", jobs, []);
        is("healthy: its original pre-order records delivery", Boolean(record?.given), true);
      } else {
        is(`${mode}: unknown record evidence cannot create a delivery`, [given, rows.length], [0, 0]);
        is(`${mode}: the paid release remains queued for recovery`, jobs, [JOB]);
        is(`${mode}: unknown evidence cannot mark the original order given`, Boolean(record?.given), false);
      }
    } finally { redis.pipeline = pipeline; }
  }
  is("the complete synthetic exercise remains inside its predeclared ceiling", total <= 40_000, true);
  done();
}
void main().catch((error) => { console.error(error); process.exitCode = 2; });
