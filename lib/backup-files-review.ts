/**
 * 273 [BK1], files part 1: the owner's review of what the backup files route
 * (app/api/backup/files/route.ts) may cost, without which it stays off.
 *
 * Null until the owner approves the cost of the files-and-videos backup
 * (docs/backup-costs-2026-11-08.md, sections 5a to 5c): only the owner fills
 * it, with the date and the source of the review. `maxPagesPerDay` is the
 * most pages the route answers a UTC day for each source, for the whole site,
 * counted before any provider is asked (lib/backup-files-source.ts); the
 * per-store figure of section 5b is 10 pages a source a store, so the owner
 * sets it from the number of stores the review covers. Unknown cost is never
 * zero: while this is null the route answers 404 even with its secret.
 */
export type BackupFilesRouteReview = { maxPagesPerDay: number; reviewedAt: string; source: string };

export const BACKUP_FILES_ROUTE_REVIEW: BackupFilesRouteReview | null = null;
