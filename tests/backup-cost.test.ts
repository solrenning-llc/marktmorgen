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

// The design as built: one part of at most 4 MiB, 10,000 keys, 20,210 commands (20,000 for the copy, 200 SCAN pages,
// the run's ten: the lock, the day's count (SET NX and INCRBY), the last good copy's GET, its outcome, three at the
// most, and the lock let go only if it is its own, a script and the GET and DEL inside it), 30 days kept. One set's stored bound: 4,194,304 + one part's seal room 65,536 + the manifest's 160 + 65,536 =
// 4,325,536 bytes; 30 + 2 + 3 = 35 sets (lib/backup-run.ts, backupPeakSets: the retention, two more and the 3 months'
// copies, inbox C1-20261108-2021-C4-37) = 151,393,760 bytes. 64 runs a month: 2 a day on each of 32 UTC days.
const builtAsIs: BackupCostReview = {
  maxRows: 10_000,
  maxCommands: 20_210,
  maxBytes: 4_194_304,
  maxParts: 1,
  maxRunBytes: 4_194_304,
  retentionDays: 30,
  maxStoredBytes: 151_393_760,
  reviewedAt: "2026-11-04",
  source: "synthetic: the design as built, priced in docs/backup-cost-2026-11-04.md",
};

part("The worst month of the design as built, line by line (micro-dollars)");
is("64 runs a month: a run and one new try on each of 32 UTC days", BACKUP_RUNS_PER_MONTH, 64);
const month = backupWorstMonth(builtAsIs, 300);
const line = (id: string) => month?.lines.find((l) => l.id === id)?.microUsd ?? -1;
// (0.15139376 GB, the review's ceiling, + 1 GB-month of rounding) × 15,000 = 17,270.91 → 17,271.
is("R2 storage: the review's ceiling of 35 sets, plus a GB-month of rounding", line("r2-storage"), 17_271);
// One listing page: 35 sets × 3 objects (a part, the manifest, a month's mark) = 105 names, under 1,000. 64 runs × (3
// objects × 2 + 2 listings of 1 page) = 512, and the deletion of every object alive when the month starts (105): 617;
// (617 / 1,000,000 + 1) × 4,500,000 = 4,502,776.5 → 4,502,777.
is("R2 Class A: each object written and deleted, those alive at the month's start deleted, two listings a run, plus a million of rounding", line("r2-class-a"), 4_502_777);
// 64 × (2 read-backs (the part and the manifest; a mark is never read) + up to 105 reads to find the verified copies,
// when the last good copy is lost) = 6,848; (6,848 / 1,000,000 + 1) × 360,000 = 362,465.28 → 362,466.
is("R2 Class B: each object read back, every object the bucket holds read when the last good copy is lost, plus a million of rounding", line("r2-class-b"), 362_466);
// 64 × 20,210 + 32 × 2 = 1,293,504 commands × 2 = 2,587,008.
is("Upstash commands: every one the caps allow and the report's two reads a day", line("upstash-commands"), 2_587_008);
// A run: 200 pages × 500 × 1,024 = 102,400,000 + 4,194,304 + 10,000 × 2,112 + 6 × 1,024 = 127,720,448 bytes;
// × 64 = 8.174108672 GB × 30,000 = 245,223.26 → 245,224.
is("Upstash bytes: at most 200 full SCAN pages, every copied byte, each name sent twice, the marks", line("upstash-transfer"), 245_224);
// 6 marks (three days' counts, the last good copy, the last failure, the lock) × 1,024 bytes = 0.000006144 GB × 250,000 = 1.536 → 2.
is("Upstash storage: the backup's six marks", line("upstash-storage"), 2);
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
// The batch read before the byte cap refuses it: the run's 100 keys (lib/backup-run.ts, BACKUP_DUMP_BATCH), each at
// Upstash's record cap of 100 MB read as 100 MiB, the dearer reading: 104,857,600 bytes, as base64 ⌈/3⌉ × 4 =
// 139,810,136; 64 × 100 × 139,810,136 = 894,784,870,400 bytes = 894.7848704 GB × 30,000 = 26,843,546.11 → 26,843,547.
is("the batch of oversized keys read before the cap refuses it, each at Upstash's record cap", line("upstash-overshoot"), 26_843_547);
// Every byte the function moves, at Vercel's dearest transfer rate ($0.43 a GB): a run's Upstash bytes 127,720,448 +
// the oversized batch 13,981,013,600 + the set written and read back 2 × 4,325,536 + up to 105 objects read to find
// the verified copies, each at most manifestBound(10,000 parts) = 1,665,536 bytes (174,881,280) = 14,292,266,400;
// × 64 = 914,705,049,600 bytes = 914.7050496 GB × 430,000 = 393,323,171.33 → 393,323,172.
is("every byte the function moves, at Vercel's dearest transfer rate", line("vercel-transfer"), 393_323_172);
for (const id of ["vercel-region", "billing-blocks", "upstash-overshoot", "vercel-transfer"]) {
  is(`${id}: in the worst month and above zero, never left out`, (month?.lines ?? []).some((l) => l.id === id && l.microUsd > 0), true);
}
// 8,510,520 + 578,134 + 719,300 + 26,843,547 + 393,323,172 = 429,974,673; × 10% = 42,997,467.3 → 42,997,468.
is("the provider allowance on all of it", line("provider-allowance"), 42_997_468);
// 429,974,673 + 42,997,468 = 472,972,141: $472.97 a month.
is("the month: $472.97", month?.knownMicroUsd, 472_972_141);
// The overshoot follows the run's own batch: a smaller batch in lib/backup-run.ts lowers it, and only then.
const dumpBatch = (backupRun as Record<string, unknown>).BACKUP_DUMP_BATCH as number;
is("the overshoot is priced at the batch the run sends", [dumpBatch, line("upstash-overshoot") === Math.ceil((64 * dumpBatch * 139_810_136 * 30_000) / 1_000_000_000), readFileSync("lib/backup-run.ts", "utf8").includes("batch: BACKUP_DUMP_BATCH")], [100, true, true]);
// The quote at the route's own maxDuration (Claude 5's LOW 1 on #3293, 6732268011): the Vercel lines at 800 s, not 300.
// Vercel: 64 × (2 × 800/3,600 × 10,600 + 800/3,600 × 128,000 + 0.6) = 2,121,994; gru1: 64 × 24,088.89 = 1,541,688.9 →
// 1,541,689. 17,271 + 4,502,777 + 362,466 + 2,587,008 + 245,224 + 2 + 2,121,994 + 1,541,689 + 719,300 + 26,843,547 +
// 393,323,172 = 432,264,450; + 43,226,445 = 475,490,895 (until 9 November 2026, without the four lines, 10,820,417).
const routeSeconds = (backupCost as Record<string, unknown>).BACKUP_ROUTE_SECONDS as number;
const atRoute = backupWorstMonth(builtAsIs, routeSeconds);
is("at the route's maxDuration (800 s): $475.49 a month", [routeSeconds, atRoute?.knownMicroUsd], [800, 475_490_895]);
is("at 800 s, the four lines are in too", ["vercel-region", "billing-blocks", "upstash-overshoot", "vercel-transfer"].every((id) => (atRoute?.lines ?? []).some((l) => l.id === id && l.microUsd > 0)), true);
is("docs/backup.md quotes the month at the route's 800 s with the four lines, not the old figure", [readFileSync("docs/backup.md", "utf8").includes("475,490,895"), readFileSync("docs/backup.md", "utf8").includes("worst month at a 300 s route")], [true, false]);
is("no free quota anywhere: storage, operations and bytes all above zero", [line("r2-storage"), line("r2-class-a"), line("r2-class-b"), line("upstash-transfer")].every((n) => n > 0), true);
// With fewer commands than the page cap, the walk can read only what its commands allow: 30 - 10 = 20 pages.
const fewCommands = backupWorstMonth({ ...builtAsIs, maxRows: 2, maxCommands: 30 }, 300)?.lines.find((l) => l.id === "upstash-transfer")?.basis ?? "";
is("the SCAN pages priced are the fewer of the cap and what the commands allow", fewCommands.includes(" 20 SCAN pages"), true);

part("Larger caps cost more, never less");
const parts64: BackupCostReview = { ...builtAsIs, maxRows: 640_000, maxCommands: 1_292_810, maxParts: 64, maxRunBytes: 268_435_456, maxStoredBytes: 35 * (268_435_456 + 64 * 65_536 + 64 * 160 + 65_536) };
const bigger = backupWorstMonth(parts64, 300);
is("64 parts of 4 MiB: a review the run accepts", bigger !== null, true);
is("and each line at least the one-part figure", (bigger?.lines ?? []).every((l) => l.microUsd >= line(l.id)), true);
is("a longer route costs more", (backupWorstMonth(builtAsIs, 800)?.knownMicroUsd ?? 0) > (month?.knownMicroUsd ?? Infinity), true);

part("Nothing priced for what the run would refuse");
is("a storage ceiling below retention + 2 + 3 sets", backupWorstMonth({ ...builtAsIs, maxStoredBytes: 151_393_759 }, 300), null);
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
