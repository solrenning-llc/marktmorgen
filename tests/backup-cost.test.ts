/**
 * 273 [BK1]: the backup's worst month (lib/backup-cost.ts) and its line among
 * the LLC fixed costs (lib/llc-fixed-costs.ts), inbox C4-38 and C4-44. The
 * expected figures are worked out by hand below from the rates the repository
 * records, not by the code under test.
 *
 * What fails here:
 *   - a line missing or lighter than its worst case: R2 at retention + 3 sets
 *     with a GB-month of rounding, 32 runs (a run marked before a midnight writes after it), a Class A for each object written and each
 *     deleted by the lifecycle rule, a Class B for each read-back, a million of
 *     each class of rounding, every Upstash command and byte the caps allow,
 *     the route's whole duration, the 10% provider allowance;
 *   - a free quota credited;
 *   - a figure for a review the run would refuse;
 *   - the backup missing from the LLC fixed costs, or its ceiling filled while
 *     anything it depends on is unknown.
 */
import { BACKUP_COST_UNKNOWNS, backupWorstMonth } from "@/lib/backup-cost";
import type { BackupCostReview } from "@/lib/backup-run";
import { CURRENT_LLC_FIXED_COST_CEILINGS, FIXED_COST_SOURCE_OBSERVATIONS, LLC_FIXED_COST_IDS, allocateEntireLlcFixedCosts } from "@/lib/llc-fixed-costs";
import { done, is, part } from "./check";

// The design as built: one part of at most 4 MiB, 10,000 keys, 20,202 commands (20,000 for the copy, 200 SCAN pages,
// the two marks), 30 days kept. One set's stored bound: 4,194,304 + one part's seal room 65,536 + the manifest's
// 160 + 65,536 = 4,325,536 bytes; 33 sets (30 days, the lifecycle rule's day, the day written, a run that wrote past
// its midnight) = 142,742,688 bytes. 32 runs a month: a run marked before a midnight writes after it.
const builtAsIs: BackupCostReview = {
  maxRows: 10_000,
  maxCommands: 20_202,
  maxBytes: 4_194_304,
  maxParts: 1,
  maxRunBytes: 4_194_304,
  retentionDays: 30,
  maxStoredBytes: 142_742_688,
  reviewedAt: "2026-11-04",
  source: "synthetic: the design as built, priced in docs/backup-cost-2026-11-04.md",
};

part("The worst month of the design as built, line by line (micro-dollars)");
const month = backupWorstMonth(builtAsIs, 300);
const line = (id: string) => month?.lines.find((l) => l.id === id)?.microUsd ?? -1;
// (0.142742688 GB + 1 GB-month of rounding) × 15,000 = 17,141.14 → 17,142.
is("R2 storage: 33 sets at the daily peak, plus a GB-month of rounding", line("r2-storage"), 17_142);
// 32 runs × 2 objects × 2 = 128 operations; (128 / 1,000,000 + 1) × 4,500,000 = 4,500,576.
is("R2 Class A: each object written and deleted, plus a million of rounding", line("r2-class-a"), 4_500_576);
// 32 × 2 = 64; (64 / 1,000,000 + 1) × 360,000 = 360,023.04 → 360,024.
is("R2 Class B: each object read back, plus a million of rounding", line("r2-class-b"), 360_024);
// 32 × (20,202 + 2) = 646,528 commands × 2 = 1,293,056.
is("Upstash commands: every one the caps allow and the report's two reads", line("upstash-commands"), 1_293_056);
// A run: 20,202 × 500 × 1,024 = 10,343,424,000 + 4,194,304 + 10,000 × 2,112 + 5 × 1,024 = 10,368,743,424 bytes;
// × 32 = 331.799789568 GB × 30,000 = 9,953,993.69 → 9,953,994.
is("Upstash bytes: every command a full SCAN page, every copied byte, each name sent twice, the marks", line("upstash-transfer"), 9_953_994);
// 5 marks (three days' marks, the last good copy, the last failure) × 1,024 bytes = 0.00000512 GB × 250,000 = 1.28 → 2.
is("Upstash storage: the backup's five marks", line("upstash-storage"), 2);
// 32 × (2 × 300/3,600 × 10,600 + 300/3,600 × 128,000 + 0.6) = 32 × 12,433.93 = 397,885.87 → 397,886.
is("Vercel: the whole 300 s at 2 GB, CPU all along", line("vercel"), 397_886);
// 16,522,680 × 10% = 1,652,268.
is("the provider allowance on all of it", line("provider-allowance"), 1_652_268);
is("the month: $18.17", month?.knownMicroUsd, 18_174_948);
is("no free quota anywhere: storage, operations and bytes all above zero", [line("r2-storage"), line("r2-class-a"), line("r2-class-b"), line("upstash-transfer")].every((n) => n > 0), true);

part("Larger caps cost more, never less");
const parts64: BackupCostReview = { ...builtAsIs, maxRows: 640_000, maxCommands: 1_292_802, maxParts: 64, maxRunBytes: 268_435_456, maxStoredBytes: 33 * (268_435_456 + 64 * 65_536 + 64 * 160 + 65_536) };
const bigger = backupWorstMonth(parts64, 300);
is("64 parts of 4 MiB: a review the run accepts", bigger !== null, true);
is("and each line at least the one-part figure", (bigger?.lines ?? []).every((l) => l.microUsd >= line(l.id)), true);
is("a longer route costs more", (backupWorstMonth(builtAsIs, 800)?.knownMicroUsd ?? 0) > (month?.knownMicroUsd ?? Infinity), true);

part("Nothing priced for what the run would refuse");
is("a storage ceiling below retention + 3 sets", backupWorstMonth({ ...builtAsIs, maxStoredBytes: 142_742_687 }, 300), null);
is("a review with no date", backupWorstMonth({ ...builtAsIs, reviewedAt: "" }, 300), null);
is("no route duration", backupWorstMonth(builtAsIs, 0), null);
is("a duration past Vercel's longest", backupWorstMonth(builtAsIs, 801), null);

part("A line of the LLC fixed costs, still unknown");
is("the backup is one of the LLC's fixed costs (FX275: 100% Marktmorgen)", (LLC_FIXED_COST_IDS as readonly string[]).includes("backup"), true);
const current = CURRENT_LLC_FIXED_COST_CEILINGS.find((l) => l.id === "backup");
is("its reviewed ceiling is unknown while anything it depends on is", [current?.fullMonthlyUsdCents, current?.fullAnnualUsdCents, current?.reserveReviewed, BACKUP_COST_UNKNOWNS.length > 0], [null, null, false, true]);
is("its observation names the model and is not an approved ceiling", [FIXED_COST_SOURCE_OBSERVATIONS.backup.model, FIXED_COST_SOURCE_OBSERVATIONS.backup.approvedCeiling], ["lib/backup-cost.ts", false]);
is("the LLC total stays unknown without it", allocateEntireLlcFixedCosts(CURRENT_LLC_FIXED_COST_CEILINGS), null);

done();
