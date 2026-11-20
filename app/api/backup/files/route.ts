import { BACKUP_FILES_SOURCES, type BackupFilesSource } from "@/lib/backup-files-contract";
import { BACKUP_FILES_ROUTE_REVIEW } from "@/lib/backup-files-review";
import {
  BACKUP_FILES_CUTOFF_MS,
  BACKUP_FILES_REQUEST_MS,
  admitFilesReview,
  backupFilesPage,
  backupFilesRouteSecret,
  backupFilesSourceOff,
  decodeFilesCursor,
  secretMatches,
  takeDayPage,
} from "@/lib/backup-files-source";
import { withCutoff } from "@/lib/fetch-timeout";
import { isRedisConfigured } from "@/lib/redis";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * 273 [BK1], files part 1: the page the backup Worker reads, one source of
 * one store at a time, each object with a read URL that lasts 15 minutes
 * (lib/backup-files-source.ts, lib/backup-files-contract.ts). Only GET is
 * here: the route lists and signs, and nothing else.
 *
 *   GET /api/backup/files?source=blob&store=<folder>[&cursor=<cursor>]
 *   GET /api/backup/files?page=deletions
 *   GET /api/backup/files?page=stores
 *   Authorization: Bearer <BACKUP_FILES_ROUTE_SECRET>
 *
 * A 404, with nothing listed and nothing counted, while its own secret is
 * unset or not the one sent, and while the owner's review of its cost is
 * missing (lib/backup-files-review.ts, null on main). Nothing schedules it:
 * the Worker that calls it does not exist yet.
 */
const NO_STORE = { "Cache-Control": "no-store" };
const notFound = () => new Response("Not Found", { status: 404, headers: NO_STORE });
const refuse = (status: number, error: string, more: Record<string, string> = {}) =>
  Response.json({ version: 1, error, ...more }, { status, headers: NO_STORE });

export async function GET(request: Request): Promise<Response> {
  const started = Date.now();
  const secret = backupFilesRouteSecret();
  const review = admitFilesReview(BACKUP_FILES_ROUTE_REVIEW);
  if (!secret || !review || !secretMatches(request.headers.get("authorization"), secret)) return notFound();

  const params = new URL(request.url).searchParams;
  const names = [...params.keys()];
  if (new Set(names).size !== names.length) return refuse(400, "bad_request");
  if (params.get("page") === "deletions" && names.length === 1) {
    // No deletion record is kept by the site yet (docs/backup-costs-2026-11-08.md, section 7a, items 2 and 6):
    // an empty page would read as "nothing was deleted", which is not known.
    return refuse(503, "deletions_unavailable");
  }
  if (params.get("page") === "stores" && names.length === 1) {
    // The stores to copy, each with the room R of its plan (docs/backup-costs-2026-11-08.md, 5b), are not listed by the
    // site yet: an empty page would read as "no store to copy", which is not known.
    return refuse(503, "stores_unavailable");
  }
  if (!names.every((name) => ["source", "store", "cursor"].includes(name))) return refuse(400, "bad_request");
  const source = params.get("source") ?? "";
  const store = params.get("store") ?? "";
  const cursor = params.get("cursor");
  if (!(BACKUP_FILES_SOURCES as readonly string[]).includes(source) || !/^[0-9a-f]{32}$/.test(store)) return refuse(400, "bad_request");
  const which = source as BackupFilesSource;
  if (cursor !== null && !decodeFilesCursor(cursor, which, store)) return refuse(400, "bad_request");
  const off = backupFilesSourceOff(which);
  if (off) return refuse(503, "source_off", { source: which, why: off });
  if (!isRedisConfigured()) return refuse(503, "unavailable");

  const taken = await takeDayPage(which, review, started);
  if (taken === "over") return refuse(429, "day_ceiling");
  if (taken !== "ok") return refuse(503, "unavailable");
  try {
    const page = await withCutoff(started + BACKUP_FILES_REQUEST_MS, () =>
      backupFilesPage({ source: which, store, cursor }, { stopAt: started + BACKUP_FILES_CUTOFF_MS }),
    );
    return Response.json(page, { headers: NO_STORE });
  } catch (error) {
    console.error("backup files: a listing could not be read", error instanceof Error ? error.name : "unknown");
    return refuse(503, "listing_unavailable");
  }
}
