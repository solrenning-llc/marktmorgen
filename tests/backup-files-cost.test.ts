/**
 * The backup files route's worst month, a company cost (273 [BK1] files part 1; Claude 7's MÉDIO on #3313): every
 * admitted page is a function call held to the route's maxDuration, its answer of up to BACKUP_FILES_PAGE_BYTES, the
 * day's count (INCR + EXPIRE NX, lib/window-count.ts), one provider listing and, for Blob, one signing token, each at the dearest price
 * read in docs/backup-costs-2026-11-08.md section 2, with no free quota, R2's billing rounded up a block, and 10% room.
 * The ceiling is the owner's review: maxPagesPerDay pages a UTC day for each source that is on, 32 UTC days a billing
 * month. With no review the route answers 404 before any command, so nothing is spent; a source turned on whose
 * listing price is not read (Bunny Stream) makes the month unknown, never zero.
 */
import { readFileSync } from "node:fs";
import * as contract from "@/lib/backup-files-contract";
import { BACKUP_FILES_PAGE_BYTES } from "@/lib/backup-files-contract";
import { BACKUP_FILES_PAGE_MICRO_USD, BACKUP_FILES_ROUTE_SECONDS, backupFilesRouteWorstMonth } from "@/lib/backup-files-source";
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

const BACKUP_FILES_DAY_CEILING_REFUSALS = (contract as Record<string, unknown>).BACKUP_FILES_DAY_CEILING_REFUSALS as number;
const review = (maxPagesPerDay: number) => ({ maxPagesPerDay, maxStoresPagesPerDay: 30, maxDeletionsPagesPerDay: 40, reviewedAt: "2026-11-15", source: "synthetic" });

part("One admitted page, at the dearest prices");
// gru1 CPU $0.221 an hour and memory $0.0183 a GB-hour at 2 GB for the route's 10 s; $0.60 a million calls; Fast Origin
// Transfer $0.43 a GB on a full page; two Upstash commands at $2.00 a million; Blob list and token as Advanced Operations,
// $7.00 a million each (the dearer listing of the two sources on).
const cpu = (221_000 * 10) / 3600;
const memory = (18_300 * 2 * 10) / 3600;
// The answer as Fast Origin Transfer and Fast Data Transfer ($0.43 + $0.35 a GB) and one CDN Request ($3.20 a million);
// a page of Upstash bandwidth ($0.03 a GB). docs/backup-costs-2026-11-08.md, section 5b: $0.00154736 a call.
const answer = (BACKUP_FILES_PAGE_BYTES / 1e9) * (430_000 + 350_000) + 3.2;
const bandwidth = (BACKUP_FILES_PAGE_BYTES / 1e9) * 30_000;
const exact = 0.6 + cpu + memory + answer + 2 * 2 + bandwidth + 7 + 7;
is("never under what a page can cost", BACKUP_FILES_PAGE_MICRO_USD >= exact, true);
is("never under the dated review's ceiling per call, $0.00154736 (Claude 7's MÉDIO on #3313)", BACKUP_FILES_PAGE_MICRO_USD >= 1548, true);
is("held no longer than the route's own maxDuration", readFileSync("app/api/backup/files/route.ts", "utf8").includes(`export const maxDuration = ${BACKUP_FILES_ROUTE_SECONDS};`), true);
is("rounded up to a whole micro-dollar, no more", BACKUP_FILES_PAGE_MICRO_USD, Math.ceil(exact));

part("The month: the review's ceiling, each source on, 32 UTC days, R2's block, 10% room");
is("no review: the route answers 404 before any command, nothing spent", backupFilesRouteWorstMonth(null), 0);
const month = backupFilesRouteWorstMonth(review(40));
// Codex N1's LOW 1 on #3313: a call refused past the day's ceiling still runs the count (INCR, EXPIRE NX) and is a call;
// the Worker stops a source for the rest of the UTC day at its first day_ceiling (BACKUP_FILES_DAY_CEILING_REFUSALS),
// so one refused call a source a day is priced, at a whole page's ceiling, which is more than a refusal can cost.
is("the Worker's contract: one refused call a source a day at most", BACKUP_FILES_DAY_CEILING_REFUSALS, 1);
const pages = 2 * (40 + BACKUP_FILES_DAY_CEILING_REFUSALS) * 32;
is("two sources on (Bunny is off), forty pages a day each and the day's one refusal", month, Math.ceil((pages * BACKUP_FILES_PAGE_MICRO_USD + 4_500_000) * 1.1));
is("more pages a day, more cost", (backupFilesRouteWorstMonth(review(41)) ?? 0) > (month ?? 0), true);
is("a review that is not a whole page count is unknown", [backupFilesRouteWorstMonth(review(0)), backupFilesRouteWorstMonth(review(1.5))], [null, null]);
const source = readFileSync("lib/backup-files-source.ts", "utf8");
is("a source turned on without its listing price read makes it unknown (Bunny)", /SOURCE_OFF\.bunny\s*===\s*null\)\s*return null/.test(source), true);

part("The registry prices it, never only 'unknown'");
const pagesNote = (NOT_A_COST as Record<string, string>).BACKUP_FILES_PAGES_PER_STORE ?? "";
is("the route's note names the priced month", pagesNote.includes("backupFilesRouteWorstMonth"), true);
is("and no longer leaves the route's cost at 'unknown'", /until then it is unknown/.test(pagesNote), false);
const objectsNote = (NOT_A_COST as Record<string, string>).BACKUP_FILES_OBJECTS_PER_MONTH ?? "";
is("the Worker's copies: nothing in the code spends them yet, and its line comes with it", /nothing in this code spends/i.test(objectsNote), true);

done();
