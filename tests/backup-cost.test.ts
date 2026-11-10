/**
 * 273 [BK1]: the backup's worst month (lib/backup-cost.ts) and its line among
 * the LLC fixed costs (lib/llc-fixed-costs.ts), inbox C4-38, C4-44, C4-46 and
 * C4-49. The expected figures are worked out by hand below from the rates the
 * repository records, not by the code under test.
 *
 * What fails here:
 *   - a line missing or lighter than its worst case: R2 at the review's
 *     ceiling (retention + 2 sets and the 3 months' copies at the least; the run
 *     writes only below it, inbox C4-53, C1-20261108-2021-C4-37) with a GB-month of rounding, 64 runs (a run and a new try
 *     on each of 32 UTC days), a Class A for each object written and each
 *     deleted (a month's mark among them), those alive at the month's start, and two listings a run, a
 *     Class B for each read-back and one manifest read a run, a million of each class of
 *     rounding, every Upstash command and byte the caps allow (at most 200
 *     SCAN pages a run), the route's whole duration, the 10% provider allowance;
 *   - one of the four lines docs/backup-costs-2026-11-08.md (section 3, items 2, 3, 4 and 8; on #3271) priced
 *     outside the code until 9 November 2026 missing or at zero: Vercel at its dearest region (gru1), one more
 *     billing block of each Upstash and Vercel unit, the batch of oversized keys read before the byte cap refuses
 *     it, and every byte the function moves at Vercel's dearest transfer rate;
 *   - a free quota credited;
 *   - a figure for a review the run would refuse, or one read through a getter,
 *     inherited, or that throws when read;
 *   - the backup missing from the LLC fixed costs, or its ceiling filled while
 *     anything it depends on is unknown.
 */
import { BACKUP_COST_UNKNOWNS, BACKUP_RUNS_PER_MONTH, backupWorstMonth } from "@/lib/backup-cost";
import * as backupCost from "@/lib/backup-cost";
import * as backupRun from "@/lib/backup-run";
import { readFileSync } from "node:fs";
import type { BackupCostReview } from "@/lib/backup-run";
import { CURRENT_LLC_FIXED_COST_CEILINGS, FIXED_COST_SOURCE_OBSERVATIONS, LLC_FIXED_COST_IDS, allocateEntireLlcFixedCosts } from "@/lib/llc-fixed-costs";
import { done, is, part } from "./check";

// The design as built since 9 November 2026 (C1-20261109-1525-C4-68): one key a request (BACKUP_DUMP_BATCH 1), a copy
// that stops at its deadline and goes on in the day's next run. 10,000 keys; 4 MiB copied in at most two parts (one
// by size, and the part a pause closes: a copy spans at most the day's two runs); 20,212 commands (20,000 for the copy,
// 200 SCAN pages, the run's twelve: the lock, the day's count (SET NX and INCRBY), the progress's GET, the last good
// copy's GET, its outcome, four at the most with the progress kept or let go, and the lock let go only if it is its
// own, a script and the GET and DEL inside it); 30 days kept. One set's stored bound: 4,194,304 + two parts' seal room
// 131,072 + the manifest's 2 × 160 + 65,536 = 4,391,232 bytes; 30 + 2 + 3 = 35 sets (lib/backup-run.ts,
// backupPeakSets: the retention, two more and the 3 months' copies, inbox C1-20261108-2021-C4-37) = 153,693,120 bytes.
// 64 runs a month: 2 a day on each of 32 UTC days, a resumed run among them, each at its full caps.
const builtAsIs: BackupCostReview = {
  maxRows: 10_000,
  maxCommands: 20_212,
  maxBytes: 4_194_304,
  maxParts: 2,
  maxRunBytes: 4_194_304,
  retentionDays: 30,
  maxStoredBytes: 153_693_120,
  reviewedAt: "2026-11-09",
  source: "synthetic: the design as built, one key a request, resumed the same day",
};

part("The worst month of the design as built, line by line (micro-dollars)");
is("64 runs a month: a run and one new try on each of 32 UTC days", BACKUP_RUNS_PER_MONTH, 64);
const month = backupWorstMonth(builtAsIs, 300);
const line = (id: string) => month?.lines.find((l) => l.id === id)?.microUsd ?? -1;
// (0.15369312 GB, the review's ceiling, + 1 GB-month of rounding) × 15,000 = 17,305.40 → 17,306.
is("R2 storage: the review's ceiling of 35 sets, plus a GB-month of rounding", line("r2-storage"), 17_306);
// One listing page: 35 sets × 4 objects (two parts, the manifest, a month's mark) = 140 names, under 1,000. 64 runs × (4
// objects × 2 + 2 listings of 1 page) = 640, and the deletion of every object alive when the month starts (140): 780;
// (780 / 1,000,000 + 1) × 4,500,000 = 4,503,510.
is("R2 Class A: each object written and deleted, those alive at the month's start deleted, two listings a run, plus a million of rounding", line("r2-class-a"), 4_503_510);
// 64 × (3 read-backs (the two parts and the manifest; a mark is never read) + up to 140 reads to find the verified
// copies, when the last good copy is lost) = 9,152; (9,152 / 1,000,000 + 1) × 360,000 = 363,294.72 → 363,295.
is("R2 Class B: each object read back, every object the bucket holds read when the last good copy is lost, plus a million of rounding", line("r2-class-b"), 363_295);
// 64 × 20,212 + 32 × 2 = 1,293,632 commands × 2 = 2,587,264.
is("Upstash commands: every one the caps allow and the report's two reads a day", line("upstash-commands"), 2_587_264);
// A run: 200 pages × 500 × 1,024 = 102,400,000 + 4,194,304 + 10,000 × 2,112 + 6 × 1,024 + the progress read and
// written, 2 × manifestBound(2 parts) = 2 × 65,856 = 127,852,160 bytes; × 64 = 8.18253824 GB × 30,000 = 245,476.15 → 245,477.
is("Upstash bytes: at most 200 full SCAN pages, every copied byte, each name sent twice, the marks, the progress", line("upstash-transfer"), 245_477);
// 6 marks (three days' counts, the last good copy, the last failure, the lock) × 1,024 bytes + the progress at its
// bound, 65,856 = 72,000 bytes = 0.000072 GB × 250,000 = 18.
is("Upstash storage: the backup's six marks and a paused copy's progress", line("upstash-storage"), 18);
// 64 × (2 × 300/3,600 × 10,600 + 300/3,600 × 128,000 + 0.6) = 64 × 12,433.93 = 795,771.73 → 795,772.
is("Vercel: the whole 300 s at 2 GB, CPU all along", line("vercel"), 795_772);
// The four lines docs/backup-costs-2026-11-08.md (#3271, section 3) kept outside the code until 9 November 2026, each
// from the rates that document cites with their dates (Vercel functions pricing, last_updated 2026-06-16, and its
// regional and transfer pages; Upstash billing; all read 2026-11-08).
// Vercel at gru1, the dearest region ($0.221 a CPU-hour, $0.0183 a GB-hour), less the iad1 rates the line above uses:
// 64 × (2 × 300/3,600 × (18,300 - 10,600) + 300/3,600 × (221,000 - 128,000)) = 64 × 9,033.33 = 578,133.33 → 578,134.
is("Vercel at its dearest region (gru1), above the repository's iad1 rates", line("vercel-region"), 578_134);
// One more block of each unit, as R2's rounding: 100,000 Upstash commands (200,000), 1 GB of Upstash bandwidth
// (30,000), 1 GB-month of Upstash storage (250,000), 1 CPU-hour (221,000) and 1 GB-hour (18,300) at gru1 = 719,300.
is("one more billing block of each Upstash and Vercel unit", line("billing-blocks"), 719_300);
// The batch read before the byte cap refuses it: the run's one key (lib/backup-run.ts, BACKUP_DUMP_BATCH, 100 until
// 9 November 2026), at Upstash's record cap of 100 MB read as 100 MiB, the dearer reading: 104,857,600 bytes, as base64
// ⌈/3⌉ × 4 = 139,810,136; 64 × 1 × 139,810,136 = 8,947,848,704 bytes = 8.947848704 GB × 30,000 = 268,435.46 → 268,436.
is("the one key read before the cap refuses it, at Upstash's record cap", line("upstash-overshoot"), 268_436);
// Every byte the function moves, at Vercel's dearest transfer rate ($0.43 a GB): a run's Upstash bytes 127,852,160 +
// the oversized key 139,810,136 + the set written and read back 2 × 4,391,232 + up to 140 objects read to find the
// verified copies, each at most manifestBound(10,000 parts) = 1,665,536 bytes (233,175,040) = 509,619,800;
// × 64 = 32,615,667,200 bytes = 32.6156672 GB × 430,000 = 14,024,736.90 → 14,024,737.
is("every byte the function moves, at Vercel's dearest transfer rate", line("vercel-transfer"), 14_024_737);
for (const id of ["vercel-region", "billing-blocks", "upstash-overshoot", "vercel-transfer"]) {
  is(`${id}: in the worst month and above zero, never left out`, (month?.lines ?? []).some((l) => l.id === id && l.microUsd > 0), true);
}
// 17,306 + 4,503,510 + 363,295 + 2,587,264 + 245,477 + 18 + 795,772 + 578,134 + 719,300 + 268,436 + 14,024,737 =
// 24,103,249; × 10% = 2,410,324.9 → 2,410,325.
is("the provider allowance on all of it", line("provider-allowance"), 2_410_325);
// 24,103,249 + 2,410,325 = 26,513,574: $26.51 a month at 300 s.
is("the month at 300 s: $26.51", month?.knownMicroUsd, 26_513_574);
// The overshoot follows the run's own batch: one key since 9 November 2026 (C1-20261109-1525-C4-68 item 2).
const dumpBatch = (backupRun as Record<string, unknown>).BACKUP_DUMP_BATCH as number;
is("the overshoot is priced at the batch the run sends, one key", [dumpBatch, line("upstash-overshoot") === Math.ceil((64 * dumpBatch * 139_810_136 * 30_000) / 1_000_000_000), readFileSync("lib/backup-run.ts", "utf8").includes("batch: BACKUP_DUMP_BATCH")], [1, true, true]);
// The quote at the route's own maxDuration (Claude 5's LOW 1 on #3293, 6732268011): the Vercel lines at 800 s, not 300.
// Vercel: 64 × (2 × 800/3,600 × 10,600 + 800/3,600 × 128,000 + 0.6) = 2,121,994; gru1: 64 × 24,088.89 = 1,541,688.9 →
// 1,541,689. 17,306 + 4,503,510 + 363,295 + 2,587,264 + 245,477 + 18 + 2,121,994 + 1,541,689 + 719,300 + 268,436 +
// 14,024,737 = 26,393,026; + 2,639,303 = 29,032,329: $29.03 a month, $348.39 a year (batch 100 until 9 November 2026:
// 475,490,895; batch 100 without the four lines, 10,820,417).
const routeSeconds = (backupCost as Record<string, unknown>).BACKUP_ROUTE_SECONDS as number;
const atRoute = backupWorstMonth(builtAsIs, routeSeconds);
is("at the route's maxDuration (800 s): $29.03 a month", [routeSeconds, atRoute?.knownMicroUsd], [800, 29_032_329]);
is("at 800 s, the four lines are in too", ["vercel-region", "billing-blocks", "upstash-overshoot", "vercel-transfer"].every((id) => (atRoute?.lines ?? []).some((l) => l.id === id && l.microUsd > 0)), true);
is("docs/backup.md quotes the month at the route's 800 s at one key a request, and the batch-100 figure only as superseded", [readFileSync("docs/backup.md", "utf8").includes("29,032,329"), /475,490,895[^.]*superseded/.test(readFileSync("docs/backup.md", "utf8"))], [true, true]);
is("no free quota anywhere: storage, operations and bytes all above zero", [line("r2-storage"), line("r2-class-a"), line("r2-class-b"), line("upstash-transfer")].every((n) => n > 0), true);
// With fewer commands than the page cap, the walk can read only what its commands allow: 30 - 12 = 18 pages.
const fewCommands = backupWorstMonth({ ...builtAsIs, maxRows: 2, maxCommands: 30 }, 300)?.lines.find((l) => l.id === "upstash-transfer")?.basis ?? "";
is("the SCAN pages priced are the fewer of the cap and what the commands allow", fewCommands.includes(" 18 SCAN pages"), true);

part("Larger caps cost more, never less");
const parts64: BackupCostReview = { ...builtAsIs, maxRows: 640_000, maxCommands: 1_292_810, maxParts: 64, maxRunBytes: 268_435_456, maxStoredBytes: 35 * (268_435_456 + 64 * 65_536 + 64 * 160 + 65_536) };
const bigger = backupWorstMonth(parts64, 300);
is("64 parts of 4 MiB: a review the run accepts", bigger !== null, true);
is("and each line at least the one-part figure", (bigger?.lines ?? []).every((l) => l.microUsd >= line(l.id)), true);
is("a longer route costs more", (backupWorstMonth(builtAsIs, 800)?.knownMicroUsd ?? 0) > (month?.knownMicroUsd ?? Infinity), true);

part("Nothing priced for what the run would refuse");
is("a storage ceiling below retention + 2 + 3 sets", backupWorstMonth({ ...builtAsIs, maxStoredBytes: 153_693_119 }, 300), null);
is("a review with no date", backupWorstMonth({ ...builtAsIs, reviewedAt: "" }, 300), null);
is("no route duration", backupWorstMonth(builtAsIs, 0), null);
is("a duration past Vercel's longest", backupWorstMonth(builtAsIs, 801), null);

part("Priced only from the review as it is, read once (Codex G on #2175, inbox C4-49)");
{
  let reads = 0;
  const getter = { ...builtAsIs } as BackupCostReview;
  Object.defineProperty(getter, "maxCommands", { enumerable: true, get: () => (reads++ === 0 ? builtAsIs.maxCommands : 1) });
  is("a cap behind a getter: not priced (unknown), the getter never run", [backupWorstMonth(getter, 300), reads], [null, 0]);
  is("a review inherited from another object: not priced", backupWorstMonth(Object.create(builtAsIs) as BackupCostReview, 300), null);
  const { proxy, revoke } = Proxy.revocable(builtAsIs, {});
  revoke();
  const revoked = (() => {
    try {
      return backupWorstMonth(proxy, 300);
    } catch {
      return "threw";
    }
  })();
  is("a revoked proxy: unknown, never an exception", revoked, null);
  let gets = 0;
  const shifting = new Proxy(builtAsIs, { get: (target, name) => (name === "maxCommands" && gets++ > 0 ? 1 : Reflect.get(target, name)) });
  is("a proxy whose reads change: priced from one reading of each field, as the review itself", backupWorstMonth(shifting, 300)?.knownMicroUsd, month?.knownMicroUsd);
}

part("A line of the LLC fixed costs, still unknown");
is("the backup is one of the LLC's fixed costs (FX275: 100% Marktmorgen)", (LLC_FIXED_COST_IDS as readonly string[]).includes("backup"), true);
const current = CURRENT_LLC_FIXED_COST_CEILINGS.find((l) => l.id === "backup");
is("its reviewed ceiling is unknown while anything it depends on is", [current?.fullMonthlyUsdCents, current?.fullAnnualUsdCents, current?.reserveReviewed, BACKUP_COST_UNKNOWNS.length > 0], [null, null, false, true]);
is("its observation names the model and is not an approved ceiling", [FIXED_COST_SOURCE_OBSERVATIONS.backup.model, FIXED_COST_SOURCE_OBSERVATIONS.backup.approvedCeiling], ["lib/backup-cost.ts", false]);
// Claude 6's NIT on #3293 (6728760434): the line prices the database copy only, and says so.
is("its observation says it covers the database copy only", /database copy only/.test(String((FIXED_COST_SOURCE_OBSERVATIONS.backup as Record<string, unknown>).covers ?? "")), true);
is("the LLC total stays unknown without it", allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);

done();
