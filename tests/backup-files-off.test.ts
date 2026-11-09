/**
 * 273 [BK1], files part 1: the backup files route stays off on main. With
 * the real BACKUP_FILES_ROUTE_REVIEW (null until the owner approves the
 * cost), a call carrying the route's own secret is still a 404, and nothing
 * is listed, signed or counted. Only the owner records that review.
 */
import { GET } from "@/app/api/backup/files/route";
import { BACKUP_FILES_ROUTE_REVIEW } from "@/lib/backup-files-review";
import { deletionRecordsOn, recordDeletions } from "@/lib/backup-deletions";
import { blobWorld, resetBlobWorld } from "./backup-files-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE = "0123456789abcdef0123456789abcdef";
const SECRET = "route-secret-synthetic-0123456789abcdef";
let commands = 0;
const real = redis.pipeline;
redis.pipeline = (async (list: (string | number)[][]) => { commands += list.length; return real(list); }) as typeof redis.pipeline;

async function main(): Promise<void> {
  part("no review of the route's cost: off, even with its secret");
  resetBlobWorld();
  blobWorld.pages = [{ blobs: [], hasMore: false }];
  process.env.BACKUP_FILES_ROUTE_SECRET = SECRET;
  is("the review is null on main", BACKUP_FILES_ROUTE_REVIEW, null);
  const response = await GET(new Request(`https://marktmorgen.test/api/backup/files?source=blob&store=${STORE}`, { headers: { authorization: `Bearer ${SECRET}` } }));
  is("404", response.status, 404);
  is("nothing listed, signed or counted", [blobWorld.listCalls.length, blobWorld.tokenCalls.length, commands], [0, 0, 0]);
  is("no deletion record is kept either, even with the secret set", [deletionRecordsOn(), await recordDeletions([`stores/${STORE}/a.pdf`], "creator_deleted"), commands], [false, { kept: 0, missed: 0 }, 0]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
