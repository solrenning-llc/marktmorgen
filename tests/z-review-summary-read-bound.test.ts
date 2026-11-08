/** Proof only: actual summary producers, expired leases and failed cleanup. */
import { readFileSync } from "node:fs";
import { aiMonthKey } from "@/lib/ai";
import { KEEP_REVIEW_SUMMARY, makeReviewSummary, readReviewSummary, summaryReadKey } from "@/lib/review-ai-summary";
import { saveReview } from "@/lib/reviews";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { is, done } from "./check";
import { ROOM } from "./data-room";
import { store as redis, advance } from "./redis-stub";

type Command = (string | number)[];
type ReadObservation = { commands: Command[]; replyBytes: number; rows: number };
const titles = [
  "Clear lessons with useful pottery notes",
  "Friendly teacher and clear pottery steps",
  "Useful pottery notes and clear examples",
  "Clear pottery lessons and friendly tutor",
];
const answer = JSON.stringify({ themes: titles.map((title) => ({ title, reviews: [1, 2, 3, 4, 5, 6] })) });
let models = 0;
let modelJobKey = "";
let jobsBeforeDispatch: number[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") throw new Error("Unexpected provider in summary proof");
  jobsBeforeDispatch.push(Number((await redis.pipeline([["GET", modelJobKey]]))[0]));
  models += 1;
  return new Response(JSON.stringify({ content: [{ type: "text", text: answer }] }));
}) as typeof fetch;

async function fixture(mode: "serial" | "cleanup" | "lost-cleanup", producers = 16) {
  redis.clear();
  models = 0;
  jobsBeforeDispatch = [];
  // Reuse the repository's existing synthetic credential, never a supplier key.
  const existing = readFileSync("tests/review-ai-summary.test.ts", "utf8");
  process.env.ANTHROPIC_API_KEY = existing.match(/process\.env\.ANTHROPIC_API_KEY = "([^"]+)"/)![1];
  const owner = "summary-bound@example.test";
  await claimHandle(owner, "summarybound", "Summary Bound", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_SummaryBound", subscriptionId: "sub_SummaryBound", active: true, tier: "pro", period: paidPeriod() });
  const product = await addProduct(owner, "Pottery notes", "", "49");
  if (!product.ok) throw new Error("Fixture product refused");
  const store = (await storeForEmail(owner))!;
  const sid = store.statsId!;
  const pid = product.product.id;
  for (let i = 0; i < 6; i += 1) {
    await saveReview(sid, { productId: pid, email: `summary-bound-${i}@example.test`, reference: `cs_test_summarybound${i}`, pi: `pi_summarybound${i}`, rating: 5, text: titles.join(". "), name: "Fixture buyer" }, ROOM, Date.now() + i);
  }
  const key = summaryReadKey(sid, pid);
  const real = redis.pipeline.bind(redis);
  const now = Date.now();
  modelJobKey = aiMonthKey(store, new Date(now))!;
  const releases: (() => void)[] = [];
  let reached: (() => void) | undefined;
  let failedCleanups = 0;
  let keeps = 0;
  let observedRead: ReadObservation | null = null;
  const lastRead = (): ReadObservation | null => observedRead;
  redis.pipeline = async (commands: Command[]) => {
    if (commands.some((c) => c[0] === "EVAL" && c[1] === KEEP_REVIEW_SUMMARY)) {
      keeps += 1;
      if (mode !== "serial") {
        // Suspend after the real producer read its snapshot, before its writes.
        // The next producer starts only after this one's real lease expires.
        await new Promise<void>((resolve) => { releases.push(resolve); reached!(); });
      }
    }
    if (mode === "lost-cleanup" && commands.length === 1 && commands[0][0] === "ZREM" && commands[0][1] === key) {
      failedCleanups += 1;
      // A complete cleanup request fails before dispatch, not a forged reply.
      throw new Error("Summary cleanup transport unavailable before dispatch");
    }
    const reply = await real(commands);
    if (commands.some((c) => c[0] === "ZRANGEBYSCORE" && c[1] === key)) {
      const index = commands.findIndex((c) => c[0] === "ZRANGEBYSCORE" && c[1] === key);
      observedRead = { commands: commands.map((c) => [...c]), replyBytes: Buffer.byteLength(JSON.stringify(reply)), rows: (reply[index] as string[]).length };
    }
    return reply;
  };
  const pending: Promise<Awaited<ReturnType<typeof makeReviewSummary>>>[] = [];
  const results: Awaited<ReturnType<typeof makeReviewSummary>>[] = [];
  try {
    if (mode === "serial") {
      for (let i = 0; i < producers; i += 1) results.push(await makeReviewSummary(store, pid, now));
    } else {
      for (let i = 0; i < producers; i += 1) {
        const atWrite = new Promise<void>((resolve) => { reached = resolve; });
        const next = makeReviewSummary(store, pid, now);
        // Surface setup/admission failure instead of waiting indefinitely.
        await Promise.race([atWrite, next.then((value) => { throw new Error(`Producer did not reach keeping: ${JSON.stringify(value)}`); })]);
        pending.push(next);
        if (i < producers - 1) advance(121_000);
      }
      for (const [i, release] of releases.entries()) {
        release();
        results.push(await pending[i]);
      }
    }
    const entries = (await real([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[];
    const count = (await real([["GET", aiMonthKey(store, new Date(now))!]]))[0];
    const summary = await readReviewSummary(sid, pid);
    return { mode, producers, maximumSuspensionMs: mode === "serial" ? 0 : (producers - 1) * 121_000, models, jobsBeforeDispatch: [...jobsBeforeDispatch], keeps, failedCleanups, jobs: Number(count), kept: results.filter((r) => r.ok && r.fresh).length, failed: results.filter((r) => !r.ok).length, entries: entries.length, themesPerEntry: entries.map((raw) => (JSON.parse(raw) as { themes: unknown[] }).themes.length), storedBytes: entries.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0), read: lastRead(), summaryThemes: summary?.themes.length };
  } finally {
    redis.pipeline = real;
    for (const release of releases) release();
    await Promise.allSettled(pending);
  }
}

async function main() {
  const serial = await fixture("serial");
  console.log("SERIAL", JSON.stringify(serial));
  is("healthy serial requests keep one summary and debit one model job", [serial.models, serial.jobs, serial.kept, serial.entries, serial.summaryThemes], [1, 1, 1, 1, 4]);
  const cleanup = await fixture("cleanup");
  console.log("CLEANUP", JSON.stringify(cleanup));
  is("expired snapshots with working cleanup retain only the current summary", [cleanup.models, cleanup.jobs, cleanup.kept, cleanup.failed, cleanup.entries, cleanup.summaryThemes], [16, 16, 1, 15, 1, 4]);
  const short = await fixture("lost-cleanup", 4);
  console.log("FOUR_PRODUCERS", JSON.stringify(short));
  is("four expired producers remain individually debited", [short.models, short.jobs, short.kept, short.failedCleanups, short.summaryThemes], [4, 4, 1, 3, 4]);
  is("the registered cardinality holds even with four expired producers", short.entries <= 3, true);
  const lost = await fixture("lost-cleanup");
  console.log("LOST_CLEANUP", JSON.stringify(lost));
  is("each dispatched model was debited, without pretending the calls were free", [lost.models, lost.jobs, lost.kept, lost.failed, lost.failedCleanups], [16, 16, 1, 15, 15]);
  is("the real writing counter is charged before every mocked provider dispatch", lost.jobsBeforeDispatch, Array.from({ length: 16 }, (_, i) => i + 1));
  is("all retained entries were emitted by actual summary producers", lost.themesPerEntry, Array(16).fill(4));
  is("registry's three-entry ceiling holds after expired snapshots and transport failure", lost.entries <= 3, true);
  is("actual stored themes stay inside the registered four KiB capacity", lost.storedBytes <= 4096, true);
  is("the real summary read stays inside its registered four KiB ceiling", (lost.read?.replyBytes ?? Infinity) <= 4096, true);
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
