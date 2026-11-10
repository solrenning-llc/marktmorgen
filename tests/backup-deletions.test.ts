/**
 * 273 [BK1], files part 3: the site writes an explicit deletion record when a
 * file it keeps for a store is deleted (lib/file-store.ts deleteFile,
 * lib/backup-deletions.ts), so the backup Worker removes its copy 30 days
 * later instead of holding it as an orphan for 90. Against a stand-in Vercel
 * Blob (tests/backup-deletions-world.ts), a mocked R2 answer, the in-memory
 * database and a synthetic review (tests/backup-files-review-fixture.ts).
 * Nothing real is reached.
 *
 * What fails here:
 *   - any record or database command while the backup files route is off
 *     (no route secret, or no review of its cost);
 *   - a record for a deletion that did not happen (the provider failed), or
 *     for a file the backup does not copy (a picture, outside a store's folder);
 *   - a record that is not exactly { source, key, recordedAt, reason }, or that
 *     holds anything but the object's key (no person, no address);
 *   - a deletion blocked, or made to fail, because its record could not be
 *     kept: it still happens, and the miss is logged without the key;
 *   - a record past the store's month ceiling; a list or count kept without
 *     its expiry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteFile } from "@/lib/file-store";
import { PERSON_DATA } from "@/lib/person-data";
import { FAMILIES } from "./store-data-registry";
import { setDeletionRecordsReview } from "./backup-files-review-fixture";
import { dropStamped } from "@/lib/pdf-stamp";
import { deletionWorld, resetDeletionWorld } from "./backup-deletions-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const F = "0123456789abcdef0123456789abcdef";
const G = "fedcba9876543210fedcba9876543210";
const SECRET = "route-secret-synthetic-0123456789abcdef";
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const dayList = () => `nl:backup:del:${today()}`;
const countKey = (folder: string) => `nl:backup:delcount:${folder}:${month()}`;

let commands: unknown[][] = [];
let inject: ((list: unknown[][]) => unknown) | null = null;
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (list: unknown[][]) => {
  commands.push(...list);
  if (inject) {
    const answer = inject(list);
    if (answer !== undefined) return answer;
  }
  return realPipeline(list as (string | number)[][]);
}) as typeof redis.pipeline;

let vaultDeletes: string[] = [];
let vaultStatus = 204;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if ((init.method ?? "GET") === "DELETE" && new URL(url).hostname.endsWith(".r2.cloudflarestorage.com")) {
    vaultDeletes.push(decodeURIComponent(new URL(url).pathname.split("/").slice(2).join("/")));
    return new Response(null, { status: vaultStatus });
  }
  throw new Error(`TEST: unexpected fetch ${url}`);
}) as typeof fetch;

let logged: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
};

function reset(on = true): void {
  resetDeletionWorld();
  redis.clear();
  commands = [];
  inject = null;
  vaultDeletes = [];
  vaultStatus = 204;
  logged = [];
  setDeletionRecordsReview(true);
  if (on) process.env.BACKUP_FILES_ROUTE_SECRET = SECRET;
  else delete process.env.BACKUP_FILES_ROUTE_SECRET;
  process.env.CRON_SECRET = "cron-secret-synthetic-0123456789abcdef";
  process.env.R2_ACCOUNT_ID = "a".repeat(32);
  process.env.R2_ACCESS_KEY_ID = "synthetic-access-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "synthetic-secret-access-key-0123456789abcdef";
  process.env.R2_BUCKET = "synthetic-bucket";
}

async function kept(key = dayList()): Promise<unknown[]> {
  const [list] = (await realPipeline([["LRANGE", key, 0, -1]])) as [string[]];
  return list.map((item) => JSON.parse(item));
}
async function ttl(key: string): Promise<number> {
  const [seconds] = (await realPipeline([["TTL", key]])) as [number];
  return seconds;
}

const blobFile = (folder: string, name: string) => `stores/${folder}/prod1/${name}`;
const vaultFile = (folder: string, name: string) => `vault/${folder}/prod1/0123456789abcdef-${name}`;

async function main(): Promise<void> {
  part("off: no record and no database command while the route has no secret");
  reset(false);
  await deleteFile([blobFile(F, "a.pdf"), vaultFile(F, "b.pdf")]);
  is("both files are deleted, as before", [deletionWorld.deleted, vaultDeletes], [[[blobFile(F, "a.pdf")]], [vaultFile(F, "b.pdf")]]);
  is("no database command at all", commands.length, 0);

  part("on: one record for each file deleted from a store's folder, after its deletion");
  reset();
  const before = Date.now();
  await deleteFile([blobFile(F, "a.pdf"), vaultFile(G, "b.pdf"), "images/0123456789abcdef01234567/p.webp", "community/x/y.webp"]);
  const records = (await kept()) as { source: string; key: string; recordedAt: number; reason: string }[];
  is("deleted as before, pictures included", [deletionWorld.deleted.flat().length, vaultDeletes], [3, [vaultFile(G, "b.pdf")]]);
  is(
    "two records, in the contract's exact shape, nothing but the key",
    records.map((r) => [Object.keys(r).join(","), r.source, r.key, r.reason]).sort(),
    [
      ["source,key,recordedAt,reason", "blob", blobFile(F, "a.pdf"), "creator_deleted"],
      ["source,key,recordedAt,reason", "r2", vaultFile(G, "b.pdf"), "creator_deleted"],
    ],
  );
  is("recorded at the time of the deletion", records.every((r) => r.recordedAt >= before && r.recordedAt <= Date.now()), true);
  is("no record for a picture or anything outside a store's folder", records.some((r) => r.key.startsWith("images/") || r.key.startsWith("community/")), false);
  const listTtl = await ttl(dayList());
  is("the day's list expires 14 days after its last write", listTtl > 14 * 86_400 - 60 && listTtl <= 14 * 86_400, true);
  const countTtl = await ttl(countKey(F));
  is("each store's month count expires within 35 days", countTtl > 0 && countTtl <= 35 * 86_400, true);
  is("each store's month count is the number of its records", (await realPipeline([["GET", countKey(F)], ["GET", countKey(G)]])), ["1", "1"]);

  part("a Blob address is recorded by its pathname, and a reason is kept as given");
  reset();
  await deleteFile(`https://synthetic.private.blob.vercel-storage.com/${blobFile(F, "c%20d.pdf")}`, "site_cleanup");
  is("the key is the pathname the listing names", ((await kept()) as { key: string; reason: string }[]).map((r) => [r.key, r.reason]), [[blobFile(F, "c d.pdf"), "site_cleanup"]]);

  part("no record for a deletion that did not happen");
  reset();
  deletionWorld.delFails = true;
  let thrown = false;
  await deleteFile([blobFile(F, "a.pdf"), vaultFile(F, "b.pdf")]).catch(() => { thrown = true; });
  is("Blob failed: the deletion still throws, as before", thrown, true);
  is("only the R2 file that was deleted is recorded", ((await kept()) as { source: string }[]).map((r) => r.source), ["r2"]);
  reset();
  vaultStatus = 500;
  thrown = false;
  await deleteFile([blobFile(F, "a.pdf"), vaultFile(F, "b.pdf")]).catch(() => { thrown = true; });
  is("R2 failed: throws before Blob is asked, and nothing is recorded", [thrown, deletionWorld.deleted.length, (await kept()).length], [true, 0, 0]);

  part("a record that cannot be kept never blocks or fails the deletion");
  reset();
  inject = () => { throw new Error("TEST: the database could not be reached"); };
  thrown = false;
  await deleteFile([blobFile(F, "a.pdf")]).catch(() => { thrown = true; });
  is("the database is down: deleted, no error to the caller", [thrown, deletionWorld.deleted.flat()], [false, [blobFile(F, "a.pdf")]]);
  is("the miss is logged with its count, never the key", [logged.some((l) => l.includes("deletion record") && l.includes("1")), logged.some((l) => l.includes(F) || l.includes("a.pdf"))], [true, false]);
  for (const [what, bad] of [
    ["the count answered as text", (list: unknown[][]) => (list[0][0] === "SET" ? [null, "1"] : undefined)],
    ["the push answered 0", (list: unknown[][]) => (list[0][0] === "RPUSH" ? [0, 1] : undefined)],
    ["the expiry not set", (list: unknown[][]) => (list[0][0] === "RPUSH" ? [1, 0] : undefined)],
    ["one reply missing", (list: unknown[][]) => (list[0][0] === "SET" ? ["OK"] : undefined)],
  ] as const) {
    reset();
    inject = bad;
    thrown = false;
    await deleteFile([blobFile(F, "a.pdf")]).catch(() => { thrown = true; });
    is(`${what} (rule 24): deleted, not thrown, the miss logged`, [thrown, deletionWorld.deleted.length, logged.some((l) => l.includes("deletion record"))], [false, 1, true]);
  }

  part("a store's month ceiling: 20,000 records, past it none, the deletion still done");
  reset();
  await realPipeline([["SET", countKey(F), "19999", "EX", 86_400]]);
  await deleteFile([blobFile(F, "a.pdf")]);
  is("the 20,000th is kept", (await kept()).length, 1);
  await deleteFile([blobFile(F, "b.pdf")]);
  is("the 20,001st is not, and is logged as missed", [(await kept()).length, deletionWorld.deleted.length, logged.some((l) => l.includes("deletion record"))], [1, 2, true]);
  await deleteFile([blobFile(G, "c.pdf")]);
  is("another store's records go on", (await kept()).length, 2);

  part("the site's own clean-up says so: a stamped copy is deleted as site_cleanup");
  reset();
  const original = { pathname: blobFile(F, "book.pdf"), name: "book.pdf", contentType: "application/pdf" };
  deletionWorld.pages = [{ blobs: [{ pathname: `stores/${F}/stamped/aaaa/one.pdf` }, { pathname: `stores/${F}/stamped/aaaa/two.pdf` }], hasMore: false }];
  await dropStamped(original);
  is("both copies deleted and recorded as the site's clean-up", ((await kept()) as { key: string; reason: string }[]).map((r) => r.reason), ["site_cleanup", "site_cleanup"]);


  part("the route on is not the records on: they have a review of their own (Claude 2, MEDIUM 2 on #3349)");
  reset();
  setDeletionRecordsReview(false);
  await deleteFile([blobFile(F, "a.pdf"), vaultFile(F, "b.pdf")]);
  is("no record review: both files deleted, no record and no database command", [deletionWorld.deleted.flat(), vaultDeletes, commands.length], [[blobFile(F, "a.pdf")], [vaultFile(F, "b.pdf")], 0]);

  part("a record never weighs more than RECORD_BYTES_MOST (Claude 2, MEDIUM 2 on #3349)");
  reset();
  const wide = `stores/${F}/prod1/${"é".repeat(500)}.pdf`;
  await deleteFile(wide);
  is("a key of 525 characters but more than 1,024 bytes: deleted, no record, logged as missed", [deletionWorld.deleted.flat(), (await kept()).length, logged.some((l) => l.includes("deletion record"))], [[wide], 0, true]);
  reset();
  const quoted = `stores/${F}/prod1/${'"'.repeat(300)}${"a".repeat(650)}.pdf`;
  await deleteFile(quoted);
  is("a key within 1,024 bytes whose record escapes past 1,200: deleted, no record", [deletionWorld.deleted.flat().length, (await kept()).length], [1, 0]);
  reset();
  const fits = `stores/${F}/prod1/${"a".repeat(974)}.pdf`;
  await deleteFile(fits);
  const one = (await realPipeline([["LRANGE", dayList(), 0, -1]])) as [string[]];
  is("a key of exactly 1,024 bytes is kept, its record within the bound", [one[0].length, Buffer.byteLength(one[0][0] ?? "", "utf8") <= 1_200], [1, true]);

  part("what the records hold about people is said, with its purpose and how long (Claude 2, MEDIUM 3 on #3349)");
  const line = PERSON_DATA.find((d) => d.file === "lib/backup-deletions.ts");
  is("lib/person-data.ts has a kept line for the records, with why", [line?.how, line && "why" in line && line.why.length > 20], ["kept", true]);
  is("it says what they carry and how long", !!line && /fingerprint/i.test(line.what) && /file name/i.test(line.what) && /14 days/.test(line.what) && /92 days/.test(line.what), true);
  const family = FAMILIES["nl:backup:del:@lib/backup-deletions.ts"];
  const familyText = JSON.stringify(family ?? null);
  is("the data registry no longer says a record holds no person", [familyText.includes("never a person"), /fingerprint/i.test(familyText)], [false, true]);

  part("each deletion is recorded with its own reason (Claude 2, LOW 1 on #3349)");
  const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
  is("a person's erasure: privacy_request", /deleteFile\(unique, "privacy_request"\)/.test(source("lib/person-erasure.ts")), true);
  is("the never-attached uploads' sweep: site_cleanup", /sweepTaskUploads\(\(paths\) => deleteFile\(paths, "site_cleanup"\)\)/.test(source("app/api/cron/courses/route.ts")), true);
  is("the task route's own refusals: site_cleanup, every one", [...source("app/api/store/course/task/route.ts").matchAll(/deleteFile\(path(?:, "(site_cleanup)")?\)/g)].map((m) => m[1] ?? "none"), ["site_cleanup", "site_cleanup", "site_cleanup", "site_cleanup"]);

  console.error = realError;
  done();
}

main().catch((error) => {
  console.error = realError;
  console.error(error);
  process.exitCode = 1;
});
