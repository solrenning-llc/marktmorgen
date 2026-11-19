/**
 * 273 [BK1], files part 1: the backup files route stays off on main. With
 * the real BACKUP_FILES_ROUTE_REVIEW (null until the owner approves the
 * cost), a call carrying the route's own secret is still a 404, and nothing
 * is listed, signed or counted. Only the owner records that review.
 */
import { GET } from "@/app/api/backup/files/route";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as reviews from "@/lib/backup-files-review";
import { BACKUP_FILES_ROUTE_REVIEW } from "@/lib/backup-files-review";
import { deletionRecordsOn, recordDeletions } from "@/lib/backup-deletions";
import { keptLines, linesOf } from "@/lib/person-data";
import { copyMarks } from "@/lib/person-copy";
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

  part("the deletion records have a review of their own, null on main (Claude 2, MEDIUMs 2 and 3 on #3349)");
  const records = (reviews as unknown as Record<string, unknown>).BACKUP_DELETION_RECORDS_REVIEW;
  is("BACKUP_DELETION_RECORDS_REVIEW exists and is null on main", records, null);
  const privacy = readFileSync(join(process.cwd(), "app/privacy/page.tsx"), "utf8");
  is("it is filled only once the privacy page says what the backup keeps after a deletion", records === null || /backup/i.test(privacy), true);

  part("while the records are off, no creator or person is told about them (Claude 1 and Claude 1 cloud, MEDIUM on #3349, VR item 2)");
  const aboutBackup = (text: string) => /backup/i.test(text);
  const shown = [...keptLines(), ...keptLines("team"), ...keptLines("person")].map((l) => `${l.what} ${l.why}`);
  is("no kept line in \"Delete this person\" speaks of the backup while its review is null", records === null ? shown.some(aboutBackup) : true, records === null ? false : true);
  is("a person's copy names no backup mark while its review is null", records === null ? copyMarks().some(aboutBackup) : true, records === null ? false : true);
  is("no line says \"Built but off\"", (["erased", "kept", "expires", "none", "open", "suppression"] as const).flatMap((how) => linesOf(how)).some((line) => /built but off/i.test(line)) || shown.some((line) => /built but off/i.test(line)) || copyMarks().some((line) => /built but off/i.test(line)), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
