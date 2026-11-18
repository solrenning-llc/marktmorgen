/**
 * Codex N1's LOW 3 on #3313: an R2 key holding one of the characters encodeURIComponent leaves as they are
 * (`!`, `'`, `(`, `)`, `*`) came back from the SigV4 signer with a different pathname, so presignR2Get threw a plain
 * error and the whole page of the store answered 503. Such a key is signed for exactly itself, and a key whose
 * address still would not lead to it is left out alone (the page's end "unsignable", never complete), as a Blob key
 * already is; the other objects of the page are still handed out.
 */
import { presignR2Get } from "@/lib/backup-files-r2";
import { backupFilesPage } from "@/lib/backup-files-source";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const STORE = "fedcba9876543210fedcba9876543210";
const PREFIX = `vault/${STORE}/`;
const config = {
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  bucket: "marktmorgen-files",
  key: { accessKeyId: "route-read-only-key-id-0000", secretAccessKey: "route-read-only-secret-00000000000000000" },
};
const at = new Date("2026-11-08T22:00:00Z");

function exactly(key: string): "exact" | "another" | "refused" {
  try {
    const signed = new URL(presignR2Get(config, key, 900, at));
    const decoded = signed.pathname.split("/").map((piece) => decodeURIComponent(piece)).join("/");
    return decoded === `/${config.bucket}/${key}` && signed.hash === "" && !signed.searchParams.has("x-id") ? "exact" : "another";
  } catch {
    return "refused";
  }
}

async function main(): Promise<void> {
  part("a key with ! ' ( ) or * is signed for exactly itself");
  for (const name of ["a(b).pdf", "it's.pdf", "wow!.pdf", "x*y.pdf", "(all) of 'them'!*.pdf"]) {
    is(`${JSON.stringify(name)}: signed, for exactly that key`, exactly(`${PREFIX}${name}`), "exact");
  }
  is("control: a plain key is signed for exactly itself", exactly(`${PREFIX}owner/abc/f a.pdf`), "exact");
  is("control: a dot segment is still refused", exactly(`${PREFIX}../x.pdf`), "refused");

  part("on a page, such a key never takes the other objects down");
  Object.assign(process.env, {
    R2_ACCOUNT_ID: ACCOUNT,
    R2_BUCKET: config.bucket,
    R2_ACCESS_KEY_ID: "site-read-write-key-id-0000",
    R2_SECRET_ACCESS_KEY: "site-read-write-secret-0000000000000000",
    BACKUP_FILES_R2_READ_KEY_ID: config.key.accessKeyId,
    BACKUP_FILES_R2_READ_SECRET: config.key.secretAccessKey,
  });
  const contents = (key: string) =>
    `<Contents><Key>${key}</Key><LastModified>2026-11-08T00:00:00.000Z</LastModified><ETag>&quot;0123abcd&quot;</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents>`;
  const listing = (keys: string[]) =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${config.bucket}</Name><Prefix>${PREFIX}</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${keys.map(contents).join("")}</ListBucketResult>`;
  const realFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  try {
    body = listing([`${PREFIX}a.pdf`, `${PREFIX}a(b).pdf`, `${PREFIX}c.pdf`]);
    let page: Awaited<ReturnType<typeof backupFilesPage>> | null = null;
    let threw = "";
    try {
      page = await backupFilesPage({ source: "r2", store: STORE, cursor: null }, { stopAt: Number.POSITIVE_INFINITY });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    is("the page is answered, not lost to one key", threw, "");
    is("all three objects handed out, each for exactly its key", page?.entries.map((entry) => entry.key), [`${PREFIX}a.pdf`, `${PREFIX}a(b).pdf`, `${PREFIX}c.pdf`]);
    is("and the listing is done", [page?.complete, page?.reason], [true, "done"]);

    body = listing([`${PREFIX}a.pdf`, `${PREFIX}../x.pdf`, `${PREFIX}c.pdf`]);
    page = null;
    threw = "";
    try {
      page = await backupFilesPage({ source: "r2", store: STORE, cursor: null }, { stopAt: Number.POSITIVE_INFINITY });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    is("a key R2 cannot sign as itself (a dot segment): the page is still answered", threw, "");
    is("that one key left out, the others handed out", page?.entries.map((entry) => entry.key), [`${PREFIX}a.pdf`, `${PREFIX}c.pdf`]);
    is("and the end says so: unsignable, never complete", [page?.complete, page?.reason, page?.cursor], [false, "unsignable", null]);
  } finally {
    globalThis.fetch = realFetch;
  }
}

main()
  .catch((error) => {
    is("no error", String(error), "");
  })
  .finally(done);
