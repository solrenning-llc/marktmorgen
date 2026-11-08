/**
 * 273 [BK1], files part 1: the route the backup Worker calls to list a
 * store's files and get short-lived read URLs (app/api/backup/files/route.ts,
 * lib/backup-files-source.ts), against a stand-in Vercel Blob
 * (tests/backup-files-world.ts), the in-memory database and a synthetic
 * review (tests/backup-files-review-fixture.ts). Nothing real is reached.
 *
 * What fails here:
 *   - any answer but 404 while the route's own secret is unset, too short,
 *     the same as another secret of the site, or not the one sent; or any
 *     provider call or database command before the secret is checked;
 *   - a method that could write or delete (only GET is exported);
 *   - more than ONE token call for a page, a token that is not get-only for
 *     "*", or the token's clientSigningToken, the Blob write token or the
 *     route's secret anywhere in an answer;
 *   - an unreadable or malformed listing answered as a page (rule 24): it is
 *     a 503, never an empty, complete page;
 *   - a page past its cutoff or 1 MB answered as complete, or a resume that
 *     loses or repeats an entry;
 *   - a store with more objects than its pages can list called complete;
 *   - a call past the day's reviewed pages, or one whose count could not be
 *     read, that reaches the provider;
 *   - R2 or bunny answered as a listing while their provider details are
 *     unconfirmed, and deletion records answered while none are kept.
 */
import * as route from "@/app/api/backup/files/route";
import { BACKUP_FILES_PAGES_PER_STORE, BACKUP_FILES_URL_SECONDS, parseFilesPage, type BackupFilesPage } from "@/lib/backup-files-contract";
import { backupFilesPage, backupFilesRouteSecret, decodeFilesCursor } from "@/lib/backup-files-source";
import { blobWorld, resetBlobWorld } from "./backup-files-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STORE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const SECRET = "route-secret-synthetic-0123456789abcdef";
const PREFIX = `stores/${STORE}/`;

const blobs = (from: number, count: number, key = (n: number) => `${PREFIX}file-${String(n).padStart(5, "0")}.pdf`) =>
  Array.from({ length: count }, (_, i) => ({ pathname: key(from + i), size: 100 + from + i, etag: `"e${from + i}"`, url: "https://x", downloadUrl: "https://x", uploadedAt: new Date(0) }));
const listing = (items: unknown[], more: string | null = null) => ({ blobs: items, hasMore: more !== null, ...(more !== null ? { cursor: more } : {}) });

let commands: unknown[][] = [];
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (list: unknown[][]) => {
  commands.push(...list);
  return realPipeline(list as (string | number)[][]);
}) as typeof redis.pipeline;

function reset(): void {
  resetBlobWorld();
  commands = [];
  redis.clear();
  process.env.BACKUP_FILES_ROUTE_SECRET = SECRET;
  process.env.CRON_SECRET = "cron-secret-synthetic-0123456789abcdef";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_synthetic_write_token_0123456789";
}

async function call(query: string, auth: string | null = `Bearer ${SECRET}`, method = "GET"): Promise<{ status: number; text: string; json: unknown }> {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  const response = await route.GET(new Request(`https://marktmorgen.test/api/backup/files${query}`, { method, headers }));
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}
const nothingReached = () => [blobWorld.listCalls.length, blobWorld.tokenCalls.length, blobWorld.presignCalls.length, commands.length];

async function main(): Promise<void> {
  part("off without its own secret: 404, with no listing and nothing reached");
  reset();
  delete process.env.BACKUP_FILES_ROUTE_SECRET;
  blobWorld.pages = [listing(blobs(0, 3))];
  let answer = await call(`?source=blob&store=${STORE}`);
  is("no secret set", [answer.status, answer.text.includes("stores/")], [404, false]);
  is("nothing listed, signed or counted", nothingReached(), [0, 0, 0, 0]);
  process.env.BACKUP_FILES_ROUTE_SECRET = "short";
  is("a secret under 32 characters counts as unset", (await call(`?source=blob&store=${STORE}`, "Bearer short")).status, 404);
  for (const other of ["CRON_SECRET", "BLOB_READ_WRITE_TOKEN"]) {
    process.env.BACKUP_FILES_ROUTE_SECRET = process.env[other];
    is(`a secret equal to ${other} counts as unset`, [(await call(`?source=blob&store=${STORE}`, `Bearer ${process.env[other]}`)).status, backupFilesRouteSecret()], [404, null]);
  }
  reset();
  blobWorld.pages = [listing(blobs(0, 3))];
  for (const auth of [null, "Bearer wrong-secret-of-the-same-length-000000", `Bearer ${SECRET}x`, SECRET, `Basic ${SECRET}`]) {
    is(`a call with ${auth === null ? "no" : "a wrong"} authorization is a 404`, (await call(`?source=blob&store=${STORE}`, auth)).status, 404);
  }
  is("still nothing listed, signed or counted", nothingReached(), [0, 0, 0, 0]);

  part("only lists and signs: no method that writes or deletes");
  is("GET is the only handler", Object.keys(route).filter((name) => /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(name)).sort(), ["GET"]);

  part("a page of 1,000 entries: exactly one token call, get-only, for '*'");
  reset();
  const before = Date.now();
  blobWorld.pages = [listing(blobs(0, 1000))];
  answer = await call(`?source=blob&store=${STORE}`);
  const full = parseFilesPage(answer.json) as BackupFilesPage;
  is("answered 200, complete, 1,000 entries", [answer.status, full.complete, full.reason, full.cursor, full.entries.length], [200, true, "done", null, 1000]);
  is("one listing call, of the store's folder, 1,000 at most", blobWorld.listCalls.map((c) => [c.prefix, c.limit, c.cursor]), [[PREFIX, 1000, undefined]]);
  is("exactly ONE token call", blobWorld.tokenCalls.length, 1);
  const token = blobWorld.tokenCalls[0];
  const until = Number(token.validUntil);
  is("get only, every pathname, 15 minutes at most", [token.operations, token.pathname, until > before, until <= Date.now() + BACKUP_FILES_URL_SECONDS * 1000], [["get"], "*", true, true]);
  is("one local signature per entry, each a private get", [blobWorld.presignCalls.length, blobWorld.presignCalls.every((c) => (c.options as Record<string, unknown>).operation === "get" && (c.options as Record<string, unknown>).access === "private")], [1000, true]);
  is("each entry is the listed object, its etag and size, and its signed URL", full.entries[7], { source: "blob", key: `${PREFIX}file-00007.pdf`, etag: '"e7"', size: 107, url: full.entries[7].url, expiresAt: full.entries[7].expiresAt });
  is("each URL expires when the token does, or sooner", full.entries.every((e) => e.expiresAt <= until && e.url.startsWith("https://")), true);
  is("no clientSigningToken, Blob write token or route secret in the answer", [answer.text.includes("client-signing-secret-synthetic"), answer.text.includes("vercel_blob_rw_"), answer.text.includes(SECRET)], [false, false, false]);
  is("the database: the day's count only (SET NX EX, INCRBY)", commands.map((c) => c[0]), ["SET", "INCRBY"]);

  part("an empty folder: no token call, complete only because the listing said so");
  reset();
  blobWorld.pages = [listing([])];
  answer = await call(`?source=blob&store=${STORE}`);
  is("complete, empty, no token", [answer.status, (answer.json as BackupFilesPage).complete, (answer.json as BackupFilesPage).entries.length, blobWorld.tokenCalls.length], [200, true, 0, 0]);

  part("an unreadable or malformed listing is a 503, never an empty, complete page (rule 24)");
  const broken: [string, () => void][] = [
    ["the store cannot be reached", () => { blobWorld.listFails = true; }],
    ["no answer", () => { blobWorld.pages = [null]; }],
    ["blobs not a list", () => { blobWorld.pages = [{ blobs: {}, hasMore: false }]; }],
    ["hasMore missing", () => { blobWorld.pages = [{ blobs: blobs(0, 2) }]; }],
    ["hasMore true without a cursor", () => { blobWorld.pages = [{ blobs: blobs(0, 2), hasMore: true }]; }],
    ["more than 1,000 entries", () => { blobWorld.pages = [listing(blobs(0, 1001))]; }],
    ["an entry without its etag", () => { blobWorld.pages = [listing([{ pathname: `${PREFIX}a`, size: 1 }])]; }],
    ["an entry outside the store's folder", () => { blobWorld.pages = [listing(blobs(0, 1, () => `stores/${OTHER}/a`))]; }],
    ["a size that is not a count", () => { blobWorld.pages = [listing([{ pathname: `${PREFIX}a`, size: "1", etag: "e" }])]; }],
    ["the same object twice", () => { blobWorld.pages = [listing([...blobs(0, 1), ...blobs(0, 1)])]; }],
    ["the token cannot be issued", () => { blobWorld.pages = [listing(blobs(0, 2))]; blobWorld.tokenFails = true; }],
    ["a token without its signing key", () => { blobWorld.pages = [listing(blobs(0, 2))]; blobWorld.token = { delegationToken: "d", validUntil: Date.now() + 600_000 }; }],
    ["a token that has run out", () => { blobWorld.pages = [listing(blobs(0, 2))]; blobWorld.token = { delegationToken: "d", clientSigningToken: "c", validUntil: Date.now() - 1 }; }],
  ];
  for (const [what, arrange] of broken) {
    reset();
    arrange();
    const got = await call(`?source=blob&store=${STORE}`);
    is(`${what}: 503 with no entries`, [got.status, got.text.includes("entries")], [503, false]);
  }

  part("pages: a cursor to go on from, and a store over its pages is never complete");
  reset();
  blobWorld.pages = [listing(blobs(0, 1000), "p1")];
  const first = (await call(`?source=blob&store=${STORE}`)).json as BackupFilesPage;
  is("first page: incomplete, more, with a cursor", [first.complete, first.reason, typeof first.cursor], [false, "more", "string"]);
  blobWorld.pages = [listing(blobs(1000, 5))];
  const second = (await call(`?source=blob&store=${STORE}&cursor=${first.cursor}`)).json as BackupFilesPage;
  is("the cursor asks the provider for its own next page", blobWorld.listCalls[1].cursor, "p1");
  is("second page: the rest, complete", [second.complete, second.entries.length, second.entries[0].key], [true, 5, `${PREFIX}file-01000.pdf`]);
  reset();
  let cursor: string | null = null;
  let last: BackupFilesPage | null = null;
  for (let n = 0; n < BACKUP_FILES_PAGES_PER_STORE; n += 1) {
    blobWorld.pages = [listing(blobs(n * 1000, 1000), `p${n + 1}`)];
    last = (await call(`?source=blob&store=${STORE}${cursor ? `&cursor=${cursor}` : ""}`)).json as BackupFilesPage;
    cursor = last.cursor;
  }
  is("the 10th page with more behind it: over_bound, incomplete, no cursor", [last?.complete, last?.reason, last?.cursor, last?.entries.length], [false, "over_bound", null, 1000]);

  part("the internal cutoff: an incomplete page with a cursor, and a resume that loses and repeats nothing");
  reset();
  let clock = 0;
  blobWorld.pages = [listing(blobs(0, 10))];
  const cut = await backupFilesPage({ source: "blob", store: STORE, cursor: null }, { stopAt: 1_000, now: () => (clock += 150) });
  is("stopped while signing: incomplete, cutoff, with a cursor", [cut.complete, cut.reason, typeof cut.cursor, cut.entries.length > 0 && cut.entries.length < 10], [false, "cutoff", "string", true]);
  blobWorld.pages = [listing(blobs(0, 10))];
  const rest = await backupFilesPage({ source: "blob", store: STORE, cursor: cut.cursor }, { stopAt: Number.POSITIVE_INFINITY });
  const keys = [...cut.entries, ...rest.entries].map((e) => e.key);
  is("together, every entry once", [rest.complete, keys.length, new Set(keys).size, keys[0], keys[9]], [true, 10, 10, `${PREFIX}file-00000.pdf`, `${PREFIX}file-00009.pdf`]);
  is("the resume read the same provider page again", blobWorld.listCalls.map((c) => c.cursor), [undefined, undefined]);
  reset();
  clock = 0;
  const late = await backupFilesPage({ source: "blob", store: STORE, cursor: null }, { stopAt: 0, now: () => (clock += 1) });
  is("past the cutoff before listing: nothing asked, incomplete with a cursor", [late.complete, late.reason, late.entries.length, typeof late.cursor, blobWorld.listCalls.length], [false, "cutoff", 0, "string", 0]);
  reset();
  blobWorld.pages = [listing(blobs(0, 1000, (n) => `${PREFIX}${"k".repeat(900)}-${n}`))];
  const heavy = await backupFilesPage({ source: "blob", store: STORE, cursor: null }, { stopAt: Number.POSITIVE_INFINITY });
  is("long names: stopped under 1 MB, incomplete with a cursor", [heavy.complete, heavy.reason, Buffer.byteLength(JSON.stringify(heavy)) <= 1_000_000, heavy.entries.length < 1000], [false, "page_bytes", true, true]);
  is("and the page still parses", parseFilesPage(JSON.stringify(heavy)).reason, "page_bytes");

  part("the day's reviewed pages: counted before the provider, and refused past them");
  reset();
  for (let n = 0; n < 40; n += 1) await redis.pipeline([["INCRBY", `nl:backup:files:day:${new Date().toISOString().slice(0, 10)}:blob`, 1]]);
  commands = [];
  blobWorld.pages = [listing(blobs(0, 2))];
  answer = await call(`?source=blob&store=${STORE}`);
  is("past the review's 40 a day: 429, nothing listed", [answer.status, blobWorld.listCalls.length], [429, 0]);
  reset();
  redis.pipeline = (async (list: unknown[][]) => { commands.push(...list); return ["OK", "1"]; }) as typeof redis.pipeline;
  blobWorld.pages = [listing(blobs(0, 2))];
  answer = await call(`?source=blob&store=${STORE}`);
  is("a count that does not read as a whole number: 503, nothing listed", [answer.status, blobWorld.listCalls.length], [503, 0]);
  redis.pipeline = (async () => { throw new Error("TEST: the database is down"); }) as typeof redis.pipeline;
  answer = await call(`?source=blob&store=${STORE}`);
  is("a database that cannot be reached: 503, nothing listed", [answer.status, blobWorld.listCalls.length], [503, 0]);
  redis.pipeline = (async (list: unknown[][]) => { commands.push(...list); return realPipeline(list as (string | number)[][]); }) as typeof redis.pipeline;

  part("sources whose provider details are unconfirmed stay off; deletion records are not kept yet");
  reset();
  for (const source of ["r2", "bunny"]) {
    answer = await call(`?source=${source}&store=${STORE}`);
    is(`${source}: 503 source_off, nothing listed or counted`, [answer.status, (answer.json as { error?: string }).error, blobWorld.listCalls.length, commands.length], [503, "source_off", 0, 0]);
  }
  answer = await call("?page=deletions");
  is("deletion records: 503, never an empty, complete page", [answer.status, (answer.json as { error?: string }).error, answer.text.includes("records")], [503, "deletions_unavailable", false]);

  part("a request it does not understand is refused before any work");
  reset();
  const forged = Buffer.from(JSON.stringify({ v: 1, s: "blob", st: OTHER, p: 1, c: "p1", a: null })).toString("base64url");
  for (const [what, query] of [
    ["no source", `?store=${STORE}`],
    ["an unknown source", `?source=s3&store=${STORE}`],
    ["a store that is not a folder", "?source=blob&store=../x"],
    ["an unknown parameter", `?source=blob&store=${STORE}&delete=1`],
    ["a cursor that is not one", `?source=blob&store=${STORE}&cursor=%7B%7D`],
    ["a cursor of another store", `?source=blob&store=${STORE}&cursor=${forged}`],
    ["a cursor past the store's pages", `?source=blob&store=${STORE}&cursor=${Buffer.from(JSON.stringify({ v: 1, s: "blob", st: STORE, p: 10, c: "p", a: null })).toString("base64url")}`],
  ] as const) {
    is(`${what}: 400`, (await call(query)).status, 400);
  }
  is("nothing listed or counted for any of them", [blobWorld.listCalls.length, commands.length], [0, 0]);
  is("a good cursor reads back as itself", decodeFilesCursor(Buffer.from(JSON.stringify({ v: 1, s: "blob", st: STORE, p: 2, c: "p2", a: null })).toString("base64url"), "blob", STORE), { page: 2, provider: "p2", after: null });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
