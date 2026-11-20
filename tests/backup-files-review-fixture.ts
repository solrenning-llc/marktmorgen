/** Test-only: a synthetic review of the backup files route, so its tests can reach past the off switch. Not the owner's. */
export type BackupFilesRouteReview = { maxPagesPerDay: number; reviewedAt: string; source: string };
export const BACKUP_FILES_ROUTE_REVIEW: BackupFilesRouteReview | null = { maxPagesPerDay: 40, reviewedAt: "2026-11-08", source: "synthetic test review, not the owner's" };
