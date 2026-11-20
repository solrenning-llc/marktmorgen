/**
 * 273 [BK1], files part 1: the owner's review of what the backup files route
 * (app/api/backup/files/route.ts) may cost, without which it stays off.
 *
 * Null until the owner approves the cost of the files-and-videos backup
 * (docs/backup-costs-2026-11-08.md, sections 5a to 5c): only the owner fills
 * it, with the date and the source of the review. Each page kind has its own
 * figure, the most pages the route answers a UTC day for the whole site,
 * counted before the provider or the database is asked
 * (lib/backup-files-source.ts takeDayPage):
 *   - `maxPagesPerDay`, for each source's listing; the per-store figure of
 *     section 5b is 10 pages a source a store, so the owner sets it from the
 *     number of stores the review covers;
 *   - `maxStoresPagesPerDay`, for the stores page, whose worst page is
 *     priced by lib/backup-stores.ts backupStoresPageWorstMicroUsd (every SCAN
 *     and every record it may read, each at MAX_STORE_BYTES): the month is at
 *     most 31 times this figure times that price, a company cost;
 *   - `maxDeletionsPagesPerDay`, for the deletions page (one LRANGE a day
 *     kept, at most 1 MB a page).
 * Unknown cost is never zero: while this is null, or a figure is missing,
 * the route answers 404 even with its secret.
 */
export type BackupFilesRouteReview = { maxPagesPerDay: number; maxStoresPagesPerDay: number; maxDeletionsPagesPerDay: number; reviewedAt: string; source: string };

export const BACKUP_FILES_ROUTE_REVIEW: BackupFilesRouteReview | null = null;

/**
 * The owner's review of the deletion records the site writes when it deletes
 * a store's file (lib/backup-deletions.ts), without which none is written,
 * even with the route on, and the route's deletions page answers 503.
 *
 * Null until the owner prices them in each plan's worst month: per store, at
 * most BACKUP_DELETION_RECORDS_PER_MONTH records a UTC month, each at most
 * RECORD_BYTES_MOST bytes kept at most 15 days and read once by the route;
 * 4 database commands each deleteFile call makes for each store folder it
 * names (2 once that store's month ceiling is reached), so also the deletions
 * a plan lets a store make in a month. And only once the privacy page says
 * what the records and the backup keep after a deletion, and for how long
 * (tests/backup-files-off.test.ts fails otherwise). Unknown is never zero.
 */
export type BackupDeletionRecordsReview = { reviewedAt: string; source: string };

export const BACKUP_DELETION_RECORDS_REVIEW: BackupDeletionRecordsReview | null = null;
