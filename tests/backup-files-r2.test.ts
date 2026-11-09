/**
 * 273 [BK1], files part 1: listing the production R2 bucket with a token of
 * its own and presigning one GET (lib/backup-files-r2.ts), against a
 * stand-in fetch. Nothing real is reached. The route lists R2 only once its
 * own read-only key is set (lib/backup-files-source.ts); that the
 * ListObjectsV2 answer carries each object's ETag is shown on Cloudflare's
 * own R2 example pages (lib/backup-files-r2.ts), and an entry without one
 * still fails closed here.
 *
 * What fails here:
 *   - the site's own read-write key (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)
 *     used, or accepted as the route's read key;
 *   - a listing that is not exactly a ListBucketResult with a Key, Size and
 *     ETag in each entry read as anything but a failure (rule 24); an entry
 *     outside the prefix; a truncated listing without its token; an XML
 *     escape it does not know;
 *   - a presigned URL that is not a GET of one object, or that lasts longer
 *     than asked; any request that is not a signed GET.
 */
import { backupFilesR2Config, listR2Page, presignR2Get } from "@/lib/backup-files-r2";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const STORE = "fedcba9876543210fedcba9876543210";
const PREFIX = `vault/${STORE}/`;
const env = {
  R2_ACCOUNT_ID: ACCOUNT,
  R2_BUCKET: "marktmorgen-files",
  R2_ACCESS_KEY_ID: "site-read-write-key-id-0000",
  R2_SECRET_ACCESS_KEY: "site-read-write-secret-0000000000000000",
  BACKUP_FILES_R2_READ_KEY_ID: "route-read-only-key-id-0000",
  BACKUP_FILES_R2_READ_SECRET: "route-read-only-secret-00000000000000000",
};

async function main(): Promise<void> {
  part("its own read-only key, never the site's");
  const config = backupFilesR2Config(env);
  is("set up from the read-only key", [config?.key.accessKeyId, config?.endpoint, config?.bucket], ["route-read-only-key-id-0000", `https://${ACCOUNT}.r2.cloudflarestorage.com`, "marktmorgen-files"]);
  is("off without it", backupFilesR2Config({ ...env, BACKUP_FILES_R2_READ_KEY_ID: "", BACKUP_FILES_R2_READ_SECRET: "" }), null);
  is("off when the read key is the site's read-write key", [backupFilesR2Config({ ...env, BACKUP_FILES_R2_READ_KEY_ID: env.R2_ACCESS_KEY_ID }), backupFilesR2Config({ ...env, BACKUP_FILES_R2_READ_SECRET: env.R2_SECRET_ACCESS_KEY })], [null, null]);
  // Claude 2's LOW 2 (6732231752): the backup bucket's own key is no read-only key of the files bucket either.
  is("off when the read key is the backup bucket's key", [backupFilesR2Config({ ...env, BACKUP_R2_ACCESS_KEY_ID: env.BACKUP_FILES_R2_READ_KEY_ID }), backupFilesR2Config({ ...env, BACKUP_R2_SECRET_ACCESS_KEY: env.BACKUP_FILES_R2_READ_SECRET })], [null, null]);
  is("off with a malformed account or bucket", [backupFilesR2Config({ ...env, R2_ACCOUNT_ID: "x" }), backupFilesR2Config({ ...env, R2_BUCKET: "A_B" })], [null, null]);

  part("a presigned GET of one object, for the time asked");
  const at = new Date("2026-11-08T22:00:00Z");
  const url = new URL(presignR2Get(config!, `${PREFIX}owner/abc/f a.pdf`, 900, at));
  is("the object, signed, 900 s, with the read-only key's id", [url.origin, url.pathname, url.searchParams.get("X-Amz-Expires"), url.searchParams.get("X-Amz-Credential")?.startsWith("route-read-only-key-id-0000/20261108/auto/s3/"), url.searchParams.has("X-Amz-Signature")], [`https://${ACCOUNT}.r2.cloudflarestorage.com`, `/marktmorgen-files/${PREFIX}owner/abc/f%20a.pdf`, "900", true, true]);
  is("the site's key and both secrets are not in it", [url.toString().includes(env.R2_ACCESS_KEY_ID), url.toString().includes(env.R2_SECRET_ACCESS_KEY), url.toString().includes(env.BACKUP_FILES_R2_READ_SECRET)], [false, false, false]);

  part("a key the signed address would change is refused, never signed as another object (Claude 2's LOW 1)");
  {
    const other = "0123456789abcdef0123456789abcdef";
    const outcome = (key: string) => {
      try {
        const signed = new URL(presignR2Get(config!, key, 900, at));
        const exact = signed.pathname.split("/").map((piece) => decodeURIComponent(piece)).join("/") === `/${config!.bucket}/${key}`;
        return exact && !signed.searchParams.has("x-id") && signed.hash === "" ? "exact" : "another";
      } catch {
        return "refused";
      }
    };
    for (const key of [`${PREFIX}../${other}/secret.pdf`, `${PREFIX}%2e%2e/${other}/secret.pdf`, `${PREFIX}./a.pdf`, `${PREFIX}a?x-id=PutObject`, `${PREFIX}a#frag`, `${PREFIX}a\\b.pdf`]) {
      is(`${JSON.stringify(key.slice(PREFIX.length))}: refused, or signed for exactly that key`, outcome(key) !== "another", true);
    }
    is("control: a plain key is signed for exactly itself", outcome(`${PREFIX}owner/abc/f a.pdf`), "exact");
  }

  part("a listing read in its exact shape, or not at all");
  const calls: { method: string; url: string; auth: string }[] = [];
  let body = "";
  let status = 200;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", url: String(input), auth: headers.get("authorization") ?? "" });
    return new Response(body, { status });
  }) as typeof fetch;
  const contents = (key: string, size = "10", etag = "&quot;0123abcd&quot;") => `<Contents><Key>${key}</Key><LastModified>2026-11-08T00:00:00.000Z</LastModified><ETag>${etag}</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
  const result = (inner: string, truncated = "false", next = "") =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>marktmorgen-files</Name><Prefix>${PREFIX}</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>${truncated}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${inner}</ListBucketResult>`;
  body = result(contents(`${PREFIX}a&amp;b.pdf`) + contents(`${PREFIX}c.pdf`, "20", "&quot;ffff-2&quot;"), "true", "tok1");
  const listed = await listR2Page(config!, PREFIX, null);
  is("two objects, their etags and sizes, and the token to go on", listed, { objects: [{ key: `${PREFIX}a&b.pdf`, etag: "0123abcd", size: 10 }, { key: `${PREFIX}c.pdf`, etag: "ffff-2", size: 20 }], next: "tok1" });
  const asked = new URL(calls[0].url);
  is("one signed GET, list-type 2, the prefix, 1,000 at most", [calls[0].method, asked.searchParams.get("list-type"), asked.searchParams.get("prefix"), asked.searchParams.get("max-keys"), calls[0].auth.startsWith("AWS4-HMAC-SHA256 Credential=route-read-only-key-id-0000/")], ["GET", "2", PREFIX, "1000", true]);
  await listR2Page(config!, PREFIX, "tok1");
  is("the token is sent back", new URL(calls[1].url).searchParams.get("continuation-token"), "tok1");
  body = result("");
  is("an empty folder, confirmed", await listR2Page(config!, PREFIX, null), { objects: [], next: null });

  const fails = async (arrange: () => void): Promise<boolean> => {
    arrange();
    try {
      await listR2Page(config!, PREFIX, null);
      return false;
    } catch {
      return true;
    } finally {
      status = 200;
    }
  };
  for (const [what, arrange] of [
    ["a refusal (403)", () => { status = 403; body = "<Error/>"; }],
    ["a store that is down (503)", () => { status = 503; body = ""; }],
    ["not a listing", () => { body = "<html>hello</html>"; }],
    ["a listing cut short", () => { body = result(contents(`${PREFIX}a`)).slice(0, -20); }],
    ["no IsTruncated", () => { body = result(contents(`${PREFIX}a`)).replace("<IsTruncated>false</IsTruncated>", ""); }],
    ["truncated without its token", () => { body = result(contents(`${PREFIX}a`), "true"); }],
    ["an entry without its ETag", () => { body = result(`<Contents><Key>${PREFIX}a</Key><Size>1</Size></Contents>`); }],
    ["an entry with two keys", () => { body = result(`<Contents><Key>${PREFIX}a</Key><Key>${PREFIX}b</Key><ETag>e</ETag><Size>1</Size></Contents>`); }],
    ["an entry outside the prefix", () => { body = result(contents(`vault/${ACCOUNT}/a`)); }],
    ["a size that is not a count", () => { body = result(contents(`${PREFIX}a`, "-1")); }],
    ["an escape it does not know", () => { body = result(contents(`${PREFIX}a&#x41;`)); }],
    ["a key count that does not match", () => { body = result(contents(`${PREFIX}a`)).replace("<MaxKeys>", "<KeyCount>2</KeyCount><MaxKeys>"); }],
    ["the same key twice", () => { body = result(contents(`${PREFIX}a`) + contents(`${PREFIX}a`)); }],
    // Codex Z's LOW 2 (5820335923) and Claude 2's confirmation: text before the listing, or an element left open or
    // closed out of turn, is not a whole listing.
    ["text before the listing", () => { body = `garbage${result("")}`; }],
    ["an element left open", () => { body = result("<Unclosed>"); }],
    ["an element left open, with text", () => { body = result("<Unclosed>é"); }],
    ["an element closed out of turn", () => { body = result("<Owner></Name></Owner>"); }],
  ] as const) {
    is(`${what}: a failure, never an empty listing`, await fails(arrange), true);
  }
  is("every request was a signed GET", calls.every((c) => c.method === "GET" && c.auth.startsWith("AWS4-HMAC-SHA256")), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
