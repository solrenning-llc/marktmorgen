/**
 * 273 [BK1], files part 1: a key the route cannot sign is left out, never the whole page (Claude 5's MEDIUM on #3313,
 * 6907350980).
 *
 * The site writes Blob names that keep "%", "#" and "?" (lib/sold-file-upload.ts through safeFileName, which ownsPath
 * accepts: "50% off guide.pdf", "Workbook #2.pdf"). Blob signs the raw pathname and puts it into the address as it is,
 * so the signed address does not lead to that key, and the route refuses to hand it out (leadsTo, Claude 7's LEVE).
 * That refusal used to throw the whole page: the other 999 entries never left, the cursor never moved, and each retry
 * from the same cursor took one more of the day's pages, a ceiling of the whole site.
 *
 * What fails here:
 *   - a page with such a key answered as a 503, or as "done" / complete;
 *   - that key handed out at all, signed or not;
 *   - the other entries of the page, or of the next provider page, not handed out;
 *   - a listing that refused a key anywhere called complete at its end (the Worker must alarm and apply no orphan end);
 *   - a retry that spends more than its one page;
 *   - the contract accepting "unsignable" with a cursor, or as complete.
 *
 * Synthetic only: the stand-in Blob (tests/backup-files-world.ts), the in-memory database, a synthetic review.
 */
import * as route from "@/app/api/backup/files/route";
import { parseFilesPage, type BackupFilesPage } from "@/lib/backup-files-contract";
import { blobWorld, resetBlobWorld } from "./backup-files-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE = "0123456789abcdef0123456789abcdef";
const SECRET = "route-secret-synthetic-0123456789abcdef";
const PREFIX = `stores/${STORE}/`;
const DAY = () => `nl:backup:files:day:${new Date().toISOString().slice(0, 10)}:blob`;

const item = (pathname: string, n: number) => ({ pathname, size: 100 + n, etag: `"e${n}"`, url: "https://x", downloadUrl: "https://x", uploadedAt: new Date(0) });
const blobs = (from: number, count: number) => Array.from({ length: count }, (_, i) => item(`${PREFIX}file-${String(from + i).padStart(5, "0")}.pdf`, from + i));
const listing = (items: unknown[], more: string | null = null) => ({ blobs: items, hasMore: more !== null, ...(more !== null ? { cursor: more } : {}) });

function reset(): void {
  resetBlobWorld();
  redis.clear();
  process.env.BACKUP_FILES_ROUTE_SECRET = SECRET;
  process.env.CRON_SECRET = "cron-secret-synthetic-0123456789abcdef";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_synthetic_write_token_0123456789";
}

async function call(query: string): Promise<{ status: number; page: BackupFilesPage | null; text: string }> {
  const response = await route.GET(new Request(`https://marktmorgen.test/api/backup/files${query}`, { headers: { authorization: `Bearer ${SECRET}` } }));
  const text = await response.text();
  let page: BackupFilesPage | null = null;
  try {
    page = response.status === 200 ? parseFilesPage(text) : null;
  } catch {
    page = null;
  }
  return { status: response.status, page, text };
}
const dayCount = async () => Number((await redis.pipeline([["GET", DAY()]]))[0] ?? 0);

async function main(): Promise<void> {
  for (const name of ["50% off guide.pdf", "Workbook #2.pdf"]) {
    part(`a page of 1,000 with "${name}" in its middle: the 999 others go out, the page is incomplete for good`);
    reset();
    const bad = `${PREFIX}${name}`;
    const items = [...blobs(0, 500), item(bad, 9_999), ...blobs(500, 499)];
    blobWorld.pages = [listing(items)];
    const answer = await call(`?source=blob&store=${STORE}`);
    is("answered as a page, not a 503", answer.status, 200);
    is("the 999 others are handed out", answer.page?.entries.length, 999);
    is("the key that cannot be signed is nowhere in the answer", answer.text.includes(encodeURIComponent(name)) || answer.text.includes(name), false);
    is("never complete: reason unsignable, no cursor", [answer.page?.complete, answer.page?.reason, answer.page?.cursor], [false, "unsignable", null]);
    is("it took one of the day's pages, once", await dayCount(), 1);
  }

  // Claude 3's MEDIUM on #3313 (6910034581): a name that signs as itself but breaks the contract's own key rule (a
  // C0 control or DEL, which the URL parser percent-encodes and leadsTo decodes back; or a name over 1,024 characters)
  // reached parseFilesPage and threw the whole page, again on every retry. It is refused like an unsignable key.
  for (const [label, name] of [
    ["DEL", "a\u007fb.pdf"],
    ["U+0001", "a\u0001b"],
    ["a name over 1,024 characters", `${"n".repeat(1_100)}.pdf`],
  ] as const) {
    part(`a page of 1,000 with ${label} in a name in its middle: the 999 others go out, the page is incomplete for good`);
    reset();
    const bad = `${PREFIX}${name}`;
    blobWorld.pages = [listing([...blobs(0, 500), item(bad, 9_997), ...blobs(500, 499)])];
    const answer = await call(`?source=blob&store=${STORE}`);
    is("answered as a page, not a 503", answer.status, 200);
    is("the 999 others are handed out", answer.page?.entries.length, 999);
    is("the refused name is nowhere in the answer", answer.page?.entries.some((e) => e.key === bad) ?? true, false);
    is("never complete: reason unsignable, no cursor", [answer.page?.complete, answer.page?.reason, answer.page?.cursor], [false, "unsignable", null]);
    is("it took one of the day's pages, once", await dayCount(), 1);
  }

  part("the refused key on the first provider page: the listing goes on, and its end is still never complete");
  reset();
  blobWorld.pages = [listing([item(`${PREFIX}What #1.pdf`, 9_998), ...blobs(0, 999)], "provider-cursor-2"), listing(blobs(999, 10))];
  const first = await call(`?source=blob&store=${STORE}`);
  is("the first page goes on, with a cursor", [first.status, first.page?.reason, first.page?.entries.length, typeof first.page?.cursor], [200, "more", 999, "string"]);
  const second = await call(`?source=blob&store=${STORE}&cursor=${first.page?.cursor ?? ""}`);
  is("the next page's entries go out", [second.status, second.page?.entries.length], [200, 10]);
  is("and the listing's end says a key was refused: incomplete, no cursor", [second.page?.complete, second.page?.reason, second.page?.cursor], [false, "unsignable", null]);

  part("a listing with no such key still completes");
  reset();
  blobWorld.pages = [listing(blobs(0, 3))];
  const plain = await call(`?source=blob&store=${STORE}`);
  is("done and complete, as before", [plain.status, plain.page?.complete, plain.page?.reason, plain.page?.entries.length], [200, true, "done", 3]);

  part("the contract: unsignable is never complete and carries no cursor");
  const page = (over: Record<string, unknown>) => ({ version: 1, kind: "files", source: "blob", store: STORE, entries: [], cursor: null, complete: false, reason: "unsignable", ...over });
  const refused = (value: unknown) => {
    try {
      parseFilesPage(JSON.stringify(value));
      return false;
    } catch {
      return true;
    }
  };
  is("unsignable, incomplete, no cursor: read", refused(page({})), false);
  is("unsignable called complete: refused", refused(page({ complete: true })), true);
  is("unsignable with a cursor: refused", refused(page({ cursor: "abc" })), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
