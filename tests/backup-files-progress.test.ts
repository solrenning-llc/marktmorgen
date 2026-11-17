/**
 * Codex N1's LOW 2 on #3313: a provider listing slow enough to pass the route's cutoff before the first object was
 * looked at answered an empty "cutoff" page with the cursor it was given, so a Worker repeating it could spend the
 * day's pages without moving. Every page answered after a listing now looks at one object at least, and its cursor
 * goes on after the last object looked at, a key left out included: a walk always ends.
 */
import { backupFilesPage, decodeFilesCursor } from "@/lib/backup-files-source";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const STORE = "fedcba9876543210fedcba9876543210";
const PREFIX = `vault/${STORE}/`;

Object.assign(process.env, {
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET: "marktmorgen-files",
  R2_ACCESS_KEY_ID: "site-read-write-key-id-0000",
  R2_SECRET_ACCESS_KEY: "site-read-write-secret-0000000000000000",
  BACKUP_FILES_R2_READ_KEY_ID: "route-read-only-key-id-0000",
  BACKUP_FILES_R2_READ_SECRET: "route-read-only-secret-00000000000000000",
});
const contents = (key: string) =>
  `<Contents><Key>${key}</Key><LastModified>2026-11-08T00:00:00.000Z</LastModified><ETag>&quot;0123abcd&quot;</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents>`;
const listing = (keys: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>marktmorgen-files</Name><Prefix>${PREFIX}</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${keys.map(contents).join("")}</ListBucketResult>`;

/** A clock that is past the cutoff from its second reading on: the listing itself took the whole time. */
const slow = () => {
  let clock = 0;
  return { stopAt: 1, now: () => clock++ };
};

async function walk(keys: string[]): Promise<{ handed: string[]; calls: number; last: { complete: boolean; reason: string } | null; error: string }> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(listing(keys), { status: 200 })) as typeof fetch;
  const handed: string[] = [];
  let cursor: string | null = null;
  let last: { complete: boolean; reason: string } | null = null;
  let calls = 0;
  try {
    do {
      calls += 1;
      const page = await backupFilesPage({ source: "r2", store: STORE, cursor }, slow());
      handed.push(...page.entries.map((entry) => entry.key));
      last = { complete: page.complete, reason: page.reason };
      cursor = page.cursor;
    } while (cursor !== null && calls < 10);
    return { handed, calls, last, error: "" };
  } catch (error) {
    return { handed, calls, last, error: error instanceof Error ? error.message : String(error) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main(): Promise<void> {
  part("a listing that took the whole time still moves the walk on");
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(listing([`${PREFIX}a.pdf`, `${PREFIX}b.pdf`, `${PREFIX}c.pdf`]), { status: 200 })) as typeof fetch;
    try {
      const first = await backupFilesPage({ source: "r2", store: STORE, cursor: null }, slow());
      is("the page cut off by time still hands out one object", first.entries.map((entry) => entry.key), [`${PREFIX}a.pdf`]);
      is("and goes on after it", [first.reason, first.cursor === null ? null : decodeFilesCursor(first.cursor, "r2", STORE)?.after], ["cutoff", `${PREFIX}a.pdf`]);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  const plain = await walk([`${PREFIX}a.pdf`, `${PREFIX}b.pdf`, `${PREFIX}c.pdf`]);
  is("repeated, the walk ends with every object handed out once, in order", [plain.error, plain.handed, plain.last], ["", [`${PREFIX}a.pdf`, `${PREFIX}b.pdf`, `${PREFIX}c.pdf`], { complete: true, reason: "done" }]);
  is("in no more calls than objects", plain.calls <= 3, true);

  part("a key left out first does not hold the walk either");
  const leftOut = await walk([`${PREFIX}../x.pdf`, `${PREFIX}a.pdf`, `${PREFIX}b.pdf`]);
  is("the walk ends; the key that cannot be signed is never handed out, the others are", [leftOut.error, leftOut.handed], ["", [`${PREFIX}a.pdf`, `${PREFIX}b.pdf`]]);
  is("and its end says so: unsignable, never complete", leftOut.last, { complete: false, reason: "unsignable" });
  is("in no more calls than objects", leftOut.calls <= 3, true);

  part("a key the contract refuses, looked at first, never goes into the cursor (Claude 6's MEDIUM on #4840)");
  // A tab is legal in raw XML and in an S3 key, but the cursor refuses it (decodeFilesCursor), as it refuses a key
  // past 1,024 characters: a page cut off right after such a key must not carry it, or the next call is refused and
  // that store's walk never goes on.
  for (const [label, bad] of [
    ["a tab", `${PREFIX}b\tc.pdf`],
    ["a key past 1,024 characters", `${PREFIX}${"k".repeat(1100)}.pdf`],
  ] as const) {
    const walked = await walk([bad, `${PREFIX}a.pdf`, `${PREFIX}d.pdf`]);
    is(`${label}: the walk ends, the refused key never handed out, the others are`, [walked.error, walked.handed], ["", [`${PREFIX}a.pdf`, `${PREFIX}d.pdf`]]);
    is(`${label}: and its end says so: unsignable, never complete`, walked.last, { complete: false, reason: "unsignable" });
    is(`${label}: in no more calls than objects`, walked.calls <= 3, true);
  }
}

main()
  .catch((error) => {
    is("no error", String(error), "");
  })
  .finally(done);
