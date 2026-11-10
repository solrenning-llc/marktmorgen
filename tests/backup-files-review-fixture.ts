/** Test-only: synthetic reviews of the backup files route and of its deletion records, so their tests can reach past the off switches. Not the owner's. */
export type BackupFilesRouteReview = { maxPagesPerDay: number; maxStoresPagesPerDay: number; maxDeletionsPagesPerDay: number; reviewedAt: string; source: string };
export const BACKUP_FILES_ROUTE_REVIEW: BackupFilesRouteReview | null = { maxPagesPerDay: 40, maxStoresPagesPerDay: 30, maxDeletionsPagesPerDay: 40, reviewedAt: "2026-11-08", source: "synthetic test review, not the owner's" };

export type BackupDeletionRecordsReview = { reviewedAt: string; source: string };
const RECORDS_REVIEW: BackupDeletionRecordsReview = { reviewedAt: "2026-11-10", source: "synthetic test review of the deletion records, not the owner's" };
// A live binding: a test turns the records' own review off while the route's stays on.
export let BACKUP_DELETION_RECORDS_REVIEW: BackupDeletionRecordsReview | null = RECORDS_REVIEW;
export function setDeletionRecordsReview(on: boolean): void {
  BACKUP_DELETION_RECORDS_REVIEW = on ? RECORDS_REVIEW : null;
}
