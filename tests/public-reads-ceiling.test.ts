/**
 * Two public reads that grow with the store, paid for before they read
 * (4 November 2026, lib/public-read-rules.ts), against the in-memory Redis
 * double, a stubbed Stripe and synthetic stores only:
 *
 *   - an affiliate program's book is worked out once for all its affiliates
 *     and kept (lib/affiliate-book-snapshot.ts): fifty affiliates loading
 *     their page ten times each pay for working it out once, and every other
 *     load pays for its own part; a load that finds another working it out
 *     reads the last one kept; what each affiliate sees is what their own
 *     book always said;
 *   - an affiliate waiting or declined sees no book and is a public page;
 *     one removed and still owed is an approved affiliate's load, refresh
 *     included, and one removed who never sold never refreshes;
 *   - working it out is not held against the asking connection's share of
 *     the day, which alone it can pass; the loads are;
 *   - a kept book is measured in UTF-8 bytes, as Redis counts them; two
 *     refreshes that overlap (a lock run out) never share a draft, and the
 *     one no longer holding the lock keeps and marks nothing; a person
 *     deleted while the book is worked out is never kept in it, and a
 *     deletion tried again still deletes the book; after a few incomplete
 *     books, once a day until a complete one; the page promises a daily
 *     refresh only when there is one;
 *   - a refused load reads nothing of the book;
 *   - the store's map counts its posts with one command and takes
 *     sitemapUnits before reading a listing or a post; refused, it reads
 *     nothing and tells the crawler to come back.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { answering } from "./security/next-headers";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { type Affiliate, bookSize, readBook } from "@/lib/affiliates";
import { admitAffiliatePage, affiliatePageCost } from "@/lib/affiliate-page-admission";
import {
  AFFILIATE_PAGE_MAX_SECONDS, BOOK_FRESH_SECONDS, BOOK_KEEP_SECONDS, BOOK_LOCK_SECONDS, BOOK_READ_SECONDS, BOOK_SHORT_SECONDS, BOOK_SHORT_TRIES, BOOK_SNAPSHOT_MAX_BYTES,
  BOOK_ATTEMPT, BOOK_BEGIN, BOOK_COMMIT, BOOK_FORGET, BOOK_MARK, BOOK_ROUND, BOOK_UNDO,
  beginAttempt, bookSlice, claimRefresh, forgetBookSnapshot, keptSlice, readBookVersion, releaseRefresh, snapshotState, undoAttempt, writeSnapshot,
} from "@/lib/affiliate-book-snapshot";
import { PERSON_DATA } from "@/lib/person-data";
import { forgetLeadPerson, leadId } from "@/lib/affiliate-leads";
import { affiliateLoadUnits, sitemapUnits } from "@/lib/public-read-rules";
import { paidStoreSitemap, sitemapSize, storeSitemap } from "@/lib/store-sitemap";
import { savePost } from "@/lib/store-blog";
import { clientDayShare, requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { PUBLIC_LISTING_BYTES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_public_reads_only";
const NOW = Math.floor(Date.now() / 1000);
let stripeCalls = 0;
let refundsDown = false;
// A slow Stripe: every call takes its whole 20 seconds, on a clock the check moves, and there is always another page.
let slowStripe = false;
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
globalThis.fetch = (async (input: string | URL | Request) => {
  stripeCalls += 1;
  if (slowStripe) {
    skew += 20_000;
    return new Response(JSON.stringify({ object: "list", data: [{ id: `obj_${stripeCalls}` }], has_more: true }), { status: 200 });
  }
  if (refundsDown && new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/refunds") return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

/** Every command sent while `run` runs, the bytes of the replies, and the window's requests taken. */
async function watched<T>(run: () => Promise<T>): Promise<{ value: T; names: string[]; bytes: number; taken: number }> {
  const original = redis.pipeline;
  const names: string[] = [];
  let bytes = 0;
  let taken = 0;
  try {
    redis.pipeline = async (commands) => {
      for (const c of commands) {
        names.push(String(c[0]));
        if (c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:")) taken += Number(c[2]);
      }
      const replies = await original.call(redis, commands);
      bytes += JSON.stringify(replies ?? null).length;
      return replies;
    };
    const value = await run();
    return { value, names, bytes, taken };
  } finally {
    redis.pipeline = original;
  }
}
const count = (names: string[], name: string) => names.filter((n) => n === name).length;

const idOf = (i: number) => (i === 0 ? "aaaaaaaaaaaa" : i.toString(16).padStart(12, "b"));
const person = (id: string, email: string, code: string, status = "approved", by: string | null = null) =>
  JSON.stringify({ id, email, code, status, appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", ...(by ? { by: { id: by, percent: 5 } } : {}) });
const sale = (ref: string, aff: string, at = NOW - 3600) =>
  JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "prod01", title: "Bread course", base: 2000, total: 2000, currency: "usd", rate: 30, self: false, how: "click" });

async function paidStore(owner: string, handle: string, account: string) {
  await claimHandle(owner, handle, `${handle} shop`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "creator", period: paidPeriod() });
  await setAffiliateSetting(owner, { ...NO_AFFILIATES, enabled: true, percent: 30, secondTier: 5 });
  return (await storeForEmail(owner))!;
}

/** A program of `n` approved affiliates (the second brought by the first), `sales` sales among them, one waiting and two removed. */
async function program(statsId: string, n: number, sales: number): Promise<void> {
  const people: string[] = [];
  for (let i = 0; i < n; i += 1) people.push(idOf(i), person(idOf(i), `p${i}@example.com`, `code${i}`, "approved", i === 1 ? idOf(0) : null));
  people.push("cccccccccccc", person("cccccccccccc", "waits@example.com", "waits", "pending"));
  // Two removed: one still owed for five sales, one who never sold.
  people.push("dddddddddddd", person("dddddddddddd", "gone@example.com", "gone", "removed"));
  people.push("eeeeeeeeeeee", person("eeeeeeeeeeee", "never@example.com", "never", "removed"));
  const sold: string[] = [];
  for (let i = 0; i < sales; i += 1) sold.push(`ref${i}`, sale(`ref${i}`, idOf(i % n)));
  for (let i = 0; i < 5; i += 1) sold.push(`gone${i}`, sale(`gone${i}`, "dddddddddddd"));
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ...people],
    ["HSET", `nl:aff:${statsId}:sales`, ...sold],
    ["HSET", `nl:aff:${statsId}:clicks`, idOf(0), 90],
    // A sign-up credited to the first affiliate, with the person's address.
    ["HSET", `nl:aff:${statsId}:leads`, leadId(statsId, LEAD_EMAIL), JSON.stringify({ id: leadId(statsId, LEAD_EMAIL), aff: idOf(0), kind: "signup", at: NOW - 7_200, email: LEAD_EMAIL, cents: 100, currency: "usd", hold: 0, daily: 10, budget: 10_000, state: "open", title: "" })],
  ]);
}
const LEAD_EMAIL = "lena.buyer@example.com";

const as = (id: string, status: Affiliate["status"] = "approved") => ({ id, status, share: null }) as Pick<Affiliate, "id" | "status" | "share">;
const shownOf = (got: Awaited<ReturnType<typeof admitAffiliatePage>>) => (got.admitted && got.book && got.book !== "soon" ? got.book : null);

/** Writes a book as one refresh would: under its own lock, from the version it read. */
async function writeHeld(shop: Parameters<typeof writeSnapshot>[0], book: Parameters<typeof writeSnapshot>[1], at: number) {
  const held = await claimRefresh(shop);
  if (!held) throw new Error("the refresh lock is taken");
  try {
    const tries = await beginAttempt(shop, held, at);
    if (tries === null) throw new Error("the refresh could not be counted");
    return await writeSnapshot(shop, book, at, held, await readBookVersion(shop), tries);
  } finally {
    await releaseRefresh(held);
  }
}

/** Every key of the kept book's family now in the in-memory Redis. */
async function bookKeys(statsId: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = (await redis.pipeline([["SCAN", cursor, "MATCH", `nl:aff:${statsId}:book*`, "COUNT", 1000]]))[0] as [string, string[]];
    found.push(...keys);
    cursor = String(next);
  } while (cursor !== "0");
  return found.sort();
}

/**
 * The files that call takePublicRequest with a fifth argument (its `from`,
 * where `shared` lives), or that use it other than by calling it, read with
 * the TypeScript parser: a call over several lines, `{ shared }` from a
 * variable or options passed whole are all found.
 */
function sharedCallers(sources: { file: string; text: string }[]): string[] {
  const ts = createRequire(resolve("package.json"))("typescript") as typeof import("typescript");
  const found = new Set<string>();
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: import("typescript").Node): void => {
      if (ts.isIdentifier(node) && node.text === "takePublicRequest") {
        const parent = node.parent;
        const declared = (ts.isFunctionDeclaration(parent) && parent.name === node) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
        const called = ts.isCallExpression(parent) && parent.expression === node;
        if (called && parent.arguments.length >= 5) found.add(file);
        if (!declared && !called) found.add(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
}

/** Every TypeScript file under the folders, read as it is listed: no check first, so nothing can change between a check and the read. */
function sourcesUnder(...dirs: string[]): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const file = join(entry.parentPath, entry.name);
      try {
        out.push({ file, text: readFileSync(file, "utf8") });
      } catch {
        // Gone since it was listed: nothing of it to read.
      }
    }
  }
  return out;
}

/**
 * HSTRLEN and the kept book's scripts, which the in-memory Redis
 * (lib/redis-memory.ts, reserved elsewhere today) does not answer: done here
 * with the commands it does, step for step as each script's Lua reads, one
 * script at a time. The Lua itself runs on a real Redis in
 * tests/security/affiliate-book.redis-run.ts.
 */
const memory = redis.pipeline.bind(redis);
const one = async (command: (string | number)[]) => (await memory([command]))[0];
const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
async function rename(from: string, to: string): Promise<void> {
  const [fields, ttl] = await memory([["HGETALL", from], ["PTTL", from]]);
  const flat = Array.isArray(fields) ? (fields as string[]) : [];
  if (!flat.length) throw new Error("ERR no such key");
  await memory([["DEL", to], ["HSET", to, ...flat], ...(Number(ttl) > 0 ? [["PEXPIRE", to, Number(ttl)]] : []), ["DEL", from]]);
}
const holds = async (k: string[], a: string[]) => text(await one(["GET", k[0]])) === a[0] && text(await one(["GET", k[1]])) === a[1];
const written = async (k: string[], a: string[]) => {
  if (a[3] === "1") await one(["DEL", k[5]]);
  await one(["DEL", k[6]]);
};
const SCRIPTS = new Map<string, (k: string[], a: string[]) => Promise<number>>([
  [BOOK_ATTEMPT, async (k, a) => {
    if (text(await one(["GET", k[0]])) !== a[0]) return 0;
    const tries = Number(await one(["INCR", k[1]]));
    await memory([["EXPIRE", k[1], a[2]], ["SET", k[2], a[1], "EX", a[3]]]);
    return tries;
  }],
  [BOOK_UNDO, async (k, a) => {
    if (text(await one(["GET", k[0]])) !== a[0] || text(await one(["GET", k[2]])) !== a[1]) return 0;
    if (Number(await one(["DECR", k[1]])) <= 0) await one(["DEL", k[1]]);
    await one(["DEL", k[2]]);
    return 1;
  }],
  [BOOK_BEGIN, async (k, a) => {
    if (!(await holds(k, a))) return 0;
    await memory([["DEL", k[3], k[4]], ["SET", k[2], a[0], "EX", a[2]]]);
    return 1;
  }],
  [BOOK_ROUND, async (k, a) => {
    if (!(await holds(k, a))) return 0;
    await memory([["HSET", k[2], ...a.slice(3)], ["EXPIRE", k[2], a[2]]]);
    return 1;
  }],
  [BOOK_COMMIT, async (k, a) => {
    if (!(await holds(k, a))) return (await one(["DEL", k[2]])), 0;
    if (text(await one(["HGET", k[3], "_by"])) === a[0]) return 1;
    await memory([["HSET", k[2], ...a.slice(4)], ["EXPIRE", k[2], a[2]]]);
    await rename(k[2], k[3]);
    await one(["DEL", k[4]]);
    await written(k, a);
    return 1;
  }],
  [BOOK_MARK, async (k, a) => {
    if (!(await holds(k, a))) return (await one(["DEL", k[2]])), 0;
    if (text(await one(["HGET", k[3], "_by"])) === a[0]) return (await one(["DEL", k[2]])), 2;
    await memory([["DEL", k[2], k[3], k[4]], ["HSET", k[3], ...a.slice(4)], ["EXPIRE", k[3], a[2]]]);
    await written(k, a);
    return 1;
  }],
  [BOOK_FORGET, async (k, a) => {
    if (text(await one(["GET", k[3]])) !== a[0]) return 2;
    await memory([["DEL", k[0], k[1]], ["INCR", k[2]], ["EXPIRE", k[2], a[1]]]);
    return 1;
  }],
]);
redis.pipeline = async (commands) => {
  const out: unknown[] = [];
  for (const c of commands) {
    const run = c[0] === "EVAL" ? SCRIPTS.get(String(c[1])) : undefined;
    if (run) {
      const n = Number(c[2]);
      const args = c.slice(3).map(String);
      out.push(await run(args.slice(0, n), args.slice(n)));
    } else if (c[0] === "HSTRLEN") {
      const [value] = await memory([["HGET", c[1], c[2]]]);
      out.push(typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0);
    } else {
      out.push(...(await memory([c])));
    }
  }
  return out;
};

async function main(): Promise<void> {
  redis.clear();
  answering(null);

  part("The program's book is counted before it is worked out");
  let shop = await paidStore("aff-owner@example.com", "breadshop", "acct_1TestBreadshop1");
  const statsId = shop.statsId!;
  await program(statsId, 50, 1_000);
  shop = (await storeForEmail("aff-owner@example.com"))!;
  const counted = await watched(() => bookSize(shop));
  is("eight commands, none of which reads a record", [counted.names.length, counted.names.every((n) => n === "HLEN" || n === "ZCARD")], [8, true]);
  is("its size: every field of the program's records", counted.value, { fields: 53 + 1_005 + 1 + 1, rows: 1 });
  const full = (await affiliatePageCost(shop))!;

  part("Fifty affiliates, ten loads each, in one period");
  stripeCalls = 0;
  const loads = await watched(async () => {
    const seen: unknown[] = [];
    for (let round = 0; round < 10; round += 1) for (let i = 0; i < 50; i += 1) {
      const got = await admitAffiliatePage(shop, as(idOf(i)));
      seen.push(got.admitted ? got.book : "refused");
    }
    return seen;
  });
  const load = affiliateLoadUnits({ sliceBytes: 1, listings: 0, codes: null });
  is("all five hundred admitted, each with its own figures", loads.value.every((b) => b !== "refused" && b !== null && b !== "soon"), true);
  is("the book worked out once: one read of each of its seven hashes", count(loads.names, "HGETALL"), 7);
  is(`and Stripe asked for it once (${stripeCalls} calls: its invoices, refunds and disputes)`, stripeCalls <= 23, true);
  // The first load found no book kept: its own part, and the book in full, once.
  is(`one charge in full (${full}), and every load its own part (${load} each)`, loads.taken, full + 500 * load);
  console.log(`  fifty affiliates loading ten times: ${loads.taken} requests, against ${500 * full} when each load worked the book out`);

  part("What an affiliate sees is what their own book said");
  const whole = await readBook(shop);
  for (const id of [idOf(0), idOf(1), idOf(7)]) {
    const own = await readBook(shop, id);
    const kept = await admitAffiliatePage(shop, as(id));
    const shown = kept.admitted && kept.book && kept.book !== "soon" ? kept.book.book : null;
    const kept2 = keptSlice(own);
    is(`affiliate ${id}: the same row, lines and payouts, as the page shows them`, shown && { rows: shown.rows, lines: shown.lines, payouts: shown.payouts }, { rows: kept2.rows, lines: kept2.lines, payouts: kept2.payouts });
    is("and the slice of the whole book is the same", bookSlice(whole, id).rows, own.rows);
  }

  part("One refresh at a time");
  const later = Date.now() + (BOOK_FRESH_SECONDS + 60) * 1000;
  const other = await claimRefresh(shop);
  is("another load holds the refresh", other !== null, true);
  const waiting = await watched(() => admitAffiliatePage(shop, as(idOf(3)), later));
  is("this load reads the last book kept, and works nothing out", [waiting.value.admitted && waiting.value.book !== null && waiting.value.book !== "soon", count(waiting.names, "HGETALL")], [true, 0]);
  is("and pays only its own part", waiting.taken, load);
  await releaseRefresh(other!);
  const refreshed = await watched(() => admitAffiliatePage(shop, as(idOf(3)), later));
  is("the lock let go, the next load past a day works it out again, once", [count(refreshed.names, "HGETALL"), refreshed.taken], [7, load + full]);

  part("An affiliate not approved sees no book");
  const pending = await watched(() => admitAffiliatePage(shop, as("cccccccccccc", "pending")));
  is("admitted as a public page, no book, nothing of it read", [pending.value, count(pending.names, "HGETALL"), count(pending.names, "HSTRLEN")], [{ admitted: true, book: null }, 0, 0]);
  for (const status of ["declined", "removed"] as const) {
    is(`${status} with nothing kept: no book`, await admitAffiliatePage(shop, as("cccccccccccc", status)), { admitted: true, book: null });
  }

  part("Removed, and still owed");
  const stale = later + (BOOK_FRESH_SECONDS + 60) * 1000;
  const gone = await watched(() => admitAffiliatePage(shop, as("dddddddddddd", "removed"), stale));
  const goneBook = gone.value.admitted && gone.value.book && gone.value.book !== "soon" ? gone.value.book.book : null;
  is("a removed affiliate with a balance sees it: five sales at $6.00", [goneBook?.rows[0]?.affiliate.id, goneBook?.rows[0]?.owed, goneBook?.rows[0]?.sales], ["dddddddddddd", 3_000, 5]);
  is("the book out of date, they work it out once, as an approved affiliate would, paid the same", [count(gone.names, "HGETALL"), gone.taken], [7, load + full]);
  const again = await watched(() => admitAffiliatePage(shop, as("dddddddddddd", "removed"), stale));
  is("a second load the same day reads the kept book and pays its own part", [again.value.admitted && again.value.book !== null && again.value.book !== "soon", count(again.names, "HGETALL"), again.taken], [true, 0, load]);
  const never = await watched(() => admitAffiliatePage(shop, as("eeeeeeeeeeee", "removed"), stale + (BOOK_FRESH_SECONDS + 60) * 1000));
  is("a removed affiliate who never sold: no book, the page as it was, and no refresh though the book is out of date", [never.value, count(never.names, "HGETALL"), count(never.names, "SET")], [{ admitted: true, book: null }, 0, 0]);

  const declined = await admitAffiliatePage(shop, as("dddddddddddd", "declined"), stale);
  is("declined after being approved, and still owed: sees their own part, as one removed does", declined.admitted && declined.book && declined.book !== "soon" ? declined.book.book.rows[0]?.owed : null, 3_000);

  part("Only what the page shows is kept, and deleting the person deletes it");
  const raw = JSON.stringify(await redis.pipeline([["HGETALL", `nl:aff:${statsId}:book`]]));
  is("the lead's full address is not in the kept book; its masked form is", [raw.includes(LEAD_EMAIL), raw.includes("l•••@example.com")], [false, true]);
  is("nor any affiliate's own address", raw.includes("p0@example.com") || raw.includes("gone@example.com"), false);
  is("the person deleted", await forgetLeadPerson(shop, LEAD_EMAIL), 1);
  is("the kept book with them is gone; the next load works it out again", await redis.pipeline([["EXISTS", `nl:aff:${statsId}:book`]]), [0]);
  const rebuilt = await watched(() => admitAffiliatePage(shop, as(idOf(0)), stale));
  is("worked out again, without the address", [count(rebuilt.names, "HGETALL"), JSON.stringify(await redis.pipeline([["HGETALL", `nl:aff:${statsId}:book`]])).includes("l•••@")], [7, false]);

  part("A book written whole, or only its time");
  const whole2 = await readBook(shop);
  await writeHeld(shop, { ...whole2, rows: whole2.rows.filter((r) => r.affiliate.id !== idOf(9)) }, Math.floor(stale / 1000));
  is("a newer book replaces the older whole: no part of the old one stays behind", (await snapshotState(shop, idOf(9)))?.sliceBytes, 0);
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "EVAL" && c[1] === BOOK_COMMIT)) throw new Error("synthetic write failure");
    return original.call(redis, commands);
  };
  const markOnly = await writeHeld(shop, whole2, Math.floor(stale / 1000));
  redis.pipeline = original;
  const marked = await snapshotState(shop, idOf(2));
  is("a book that could not be kept still marks when it was worked out", [markOnly?.kept, marked?.at, marked?.kept, marked?.sliceBytes], [false, Math.floor(stale / 1000), false, 0]);
  is("and leaves no draft behind", await bookKeys(statsId), [`nl:aff:${statsId}:book`, `nl:aff:${statsId}:book:ver`]);
  answering(new Request("https://marktmorgen.com/@breadshop/affiliates", { headers: { "x-forwarded-for": "203.0.113.20" } }));
  try {
    const own = await watched(() => admitAffiliatePage(shop, as(idOf(2)), stale));
    is("so the next load that day does not refresh it for everybody: it works out its own book", [own.value.admitted && own.value.book !== null && own.value.book !== "soon", count(own.names, "HGETALL"), count(own.names, "SET")], [true, 7, 0]);
    is("paid in full from its own connection's share of the day", [own.taken, own.names.includes("HINCRBY")], [load + full, true]);
    is("and the page promises no daily refresh for it: the figures are this load's own", shownOf(own.value)?.refresh, null);
    const goneOwn = await watched(() => admitAffiliatePage(shop, as("dddddddddddd", "removed"), stale));
    const goneRow = shownOf(goneOwn.value)?.book.rows[0];
    is("one removed and still owed, with no part kept, works out their own book the same way and sees what they are owed", [goneRow?.affiliate.id, goneRow?.owed, shownOf(goneOwn.value)?.refresh, count(goneOwn.names, "HGETALL")], ["dddddddddddd", 3_000, null, 7]);
    is("paid from their own connection's share: their load and the book", [goneOwn.taken, goneOwn.names.includes("HINCRBY")], [affiliateLoadUnits({ sliceBytes: 0, listings: 0, codes: null }) + full, true]);
    is("one removed who never sold still sees no book", await admitAffiliatePage(shop, as("eeeeeeeeeeee", "removed"), stale), { admitted: true, book: null });
  } finally {
    answering(null);
  }

  part("An incomplete book is worked out again sooner, a few times");
  refundsDown = true;
  const soonest = await watched(() => admitAffiliatePage(shop, as(idOf(2)), stale + (BOOK_FRESH_SECONDS + 60) * 1000));
  const shortState = await snapshotState(shop, idOf(2));
  is("refunds not all read: in date for a quarter of an hour, and the page says so", [count(soonest.names, "HGETALL"), shortState?.freshFor, shownOf(soonest.value)?.refresh], [7, BOOK_SHORT_SECONDS, "short"]);
  let at = stale + (BOOK_FRESH_SECONDS + 60) * 1000;
  for (let i = 1; i < BOOK_SHORT_TRIES + 1; i += 1) {
    at += (BOOK_SHORT_SECONDS + 60) * 1000;
    await admitAffiliatePage(shop, as(idOf(2)), at);
  }
  is(`after ${BOOK_SHORT_TRIES} times running, once a day like any other`, (await snapshotState(shop, idOf(2)))?.freshFor, BOOK_FRESH_SECONDS);
  for (let day = 0; day < 3; day += 1) {
    at += (BOOK_FRESH_SECONDS + 60) * 1000;
    const next = await admitAffiliatePage(shop, as(idOf(2)), at);
    is(`still incomplete a day later (day ${day + 1}): once a day, with no new run of short refreshes, and the page says once a day`, [(await snapshotState(shop, idOf(2)))?.freshFor, shownOf(next)?.refresh], [BOOK_FRESH_SECONDS, "daily"]);
  }
  refundsDown = false;
  at += (BOOK_FRESH_SECONDS + 60) * 1000;
  await admitAffiliatePage(shop, as(idOf(2)), at);
  is("a complete book kept sets the count back", [(await redis.pipeline([["EXISTS", `nl:aff:${statsId}:book:tries`]]))[0], (await snapshotState(shop, idOf(2)))?.freshFor], [0, BOOK_FRESH_SECONDS]);
  refundsDown = true;
  at += (BOOK_FRESH_SECONDS + 60) * 1000;
  await admitAffiliatePage(shop, as(idOf(2)), at);
  is("so a later incomplete one is worked out again soon once more", (await snapshotState(shop, idOf(2)))?.freshFor, BOOK_SHORT_SECONDS);
  refundsDown = false;

  part("One refresh's lock is its own");
  const first = await claimRefresh(shop);
  await redis.pipeline([["DEL", `nl:aff:${statsId}:book:lock`]]);
  const second = await claimRefresh(shop);
  await releaseRefresh(first!);
  is("a load whose lock ran out cannot let go of the next one's", [second !== null, await claimRefresh(shop)], [true, null]);
  await releaseRefresh(second!);

  part("A kept book is measured in bytes, as Redis counts them");
  const base = await readBook(shop);
  const baseBytes = base.rows
    .map((row) => [row.affiliate.id, JSON.stringify({ at: 1, book: keptSlice(bookSlice(base, row.affiliate.id)) })])
    .reduce((sum, [id, value]) => sum + Buffer.byteLength(id) + Buffer.byteLength(value), 0);
  const titled = (chars: number) => ({ ...base, lines: base.lines.map((line, i) => (i === 0 ? { ...line, title: "書".repeat(chars) } : line)) });
  // Each "書" is one UTF-16 unit and three UTF-8 bytes: a book its length says fits but its bytes do not.
  const over = Math.ceil((BOOK_SNAPSHOT_MAX_BYTES - baseBytes) / 3) + 1_000;
  is(`a book of ${over} such characters is under the cap by its length, over it by its bytes`, [over + baseBytes < BOOK_SNAPSHOT_MAX_BYTES, 3 * over + baseBytes > BOOK_SNAPSHOT_MAX_BYTES], [true, true]);
  const tooBig = await writeHeld(shop, titled(over), Math.floor(stale / 1000));
  is("so it is not kept: only when it was worked out", [tooBig?.kept, (await snapshotState(shop, base.lines[0]!.aff))?.kept], [false, false]);
  const under = Math.floor((BOOK_SNAPSHOT_MAX_BYTES - baseBytes) / 3) - 1_000;
  const fits = await writeHeld(shop, titled(under), Math.floor(stale / 1000));
  const fitState = await snapshotState(shop, base.lines[0]!.aff);
  const fitRaw = (await redis.pipeline([["HGET", `nl:aff:${statsId}:book`, base.lines[0]!.aff]]))[0] as string;
  is("one just under the cap in bytes is kept, and its part's size is its bytes", [fits?.kept, fitState?.kept, fitState?.sliceBytes, fitState?.sliceBytes === fitRaw.length], [true, true, Buffer.byteLength(fitRaw), false]);
  await writeHeld(shop, base, Math.floor(stale / 1000));

  part("Two refreshes that overlap never share a draft or undo each other");
  const statsKey = `nl:aff:${statsId}:book`;
  const lockOf = `nl:aff:${statsId}:book:lock`;
  const partial = { ...base, rows: base.rows.filter((r) => r.affiliate.id !== idOf(9)) };
  // A's lock runs out while it writes; B takes the lock and keeps a whole book; A then tries to finish.
  const heldA = (await claimRefresh(shop))!;
  const versionA = await readBookVersion(shop);
  let heldB: Awaited<ReturnType<typeof claimRefresh>> = null;
  let wroteB: Awaited<ReturnType<typeof writeSnapshot>> = null;
  const plain = redis.pipeline;
  redis.pipeline = async (commands) => {
    const reply = await plain.call(redis, commands);
    if (!heldB && commands.some((c) => c[0] === "EVAL" && c[1] === BOOK_ROUND && String(c[5]) === `${statsKey}:new:${heldA.token}`)) {
      await plain.call(redis, [["DEL", lockOf]]);
      heldB = await claimRefresh(shop);
      wroteB = await writeSnapshot(shop, base, Math.floor(stale / 1000) + 1, heldB!, await readBookVersion(shop), 1);
    }
    return reply;
  };
  const wroteA = await writeSnapshot(shop, partial, Math.floor(stale / 1000) + 2, heldA, versionA, 1);
  redis.pipeline = plain;
  is("B, holding the lock, keeps its whole book", [heldB !== null, wroteB], [true, { kept: true, short: false }]);
  is("A, whose lock ran out midway, keeps nothing", wroteA, null);
  is("the kept book is B's whole one: written by B, at B's time, with the affiliate A's left out", [(await redis.pipeline([["HGET", statsKey, "_by"]]))[0], (await snapshotState(shop, idOf(9)))?.at, ((await snapshotState(shop, idOf(9)))?.sliceBytes ?? 0) > 0], [heldB!.token, Math.floor(stale / 1000) + 1, true]);
  is("and neither draft is left", (await bookKeys(statsId)).filter((k) => k.includes(":book:new")), []);
  await releaseRefresh(heldA);
  is("A letting go does not free B's lock", (await redis.pipeline([["GET", lockOf]]))[0], heldB!.token);
  await releaseRefresh(heldB!);

  // A's rename fails while B holds the lock: A's fallback to marking only must not delete B's book.
  const heldC = (await claimRefresh(shop))!;
  const versionC = await readBookVersion(shop);
  let heldD: Awaited<ReturnType<typeof claimRefresh>> = null;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "EVAL" && c[1] === BOOK_COMMIT && String(c[5]) === `${statsKey}:new:${heldC.token}`)) {
      await plain.call(redis, [["DEL", lockOf]]);
      heldD = await claimRefresh(shop);
      await writeSnapshot(shop, base, Math.floor(stale / 1000) + 3, heldD!, await readBookVersion(shop), 1);
      throw new Error("synthetic rename failure");
    }
    return plain.call(redis, commands);
  };
  const wroteC = await writeSnapshot(shop, partial, Math.floor(stale / 1000) + 4, heldC, versionC, 1);
  redis.pipeline = plain;
  is("a refresh whose rename failed after its lock ran out marks nothing", wroteC, null);
  is("the newer refresh's whole book stays, kept", [(await redis.pipeline([["HGET", statsKey, "_by"]]))[0], (await snapshotState(shop, idOf(2)))?.kept, (await snapshotState(shop, idOf(2)))?.at], [heldD!.token, true, Math.floor(stale / 1000) + 3]);
  await releaseRefresh(heldC);
  await releaseRefresh(heldD!);

  // A refresh stopped midway (its function ended) leaves a draft; the next refresh deletes it as it begins.
  const heldE = (await claimRefresh(shop))!;
  await redis.pipeline([["SET", `${statsKey}:draft`, heldE.token], ["HSET", `${statsKey}:new:${heldE.token}`, idOf(0), "{}"]]);
  await redis.pipeline([["DEL", lockOf]]);
  await writeHeld(shop, base, Math.floor(stale / 1000) + 5);
  is("a draft a stopped refresh left is deleted by the next", (await bookKeys(statsId)).filter((k) => k.includes(":book:new")), []);
  is("the read stops well inside the page's maxDuration, which the page declares, and the lock outlasts both", [BOOK_READ_SECONDS + 60 <= AFFILIATE_PAGE_MAX_SECONDS, BOOK_LOCK_SECONDS >= AFFILIATE_PAGE_MAX_SECONDS + 60, readFileSync("app/[handle]/affiliates/page.tsx", "utf8").includes(`export const maxDuration = ${AFFILIATE_PAGE_MAX_SECONDS};`)], [true, true, true]);

  part("A person deleted while the book is worked out is never kept in it");
  const SECOND = "mara.buyer@example.com";
  const addLead = (email: string) => redis.pipeline([["HSET", `nl:aff:${statsId}:leads`, leadId(statsId, email), JSON.stringify({ id: leadId(statsId, email), aff: idOf(0), kind: "signup", at: NOW - 7_000, email, cents: 100, currency: "usd", hold: 0, daily: 10, budget: 10_000, state: "open", title: "" })]]);
  await addLead(SECOND);
  const heldF = (await claimRefresh(shop))!;
  const versionF = await readBookVersion(shop);
  const readF = await readBook(shop);
  is("the refresh read the address (masked in what it would keep)", JSON.stringify(keptSlice(bookSlice(readF, idOf(0)))).includes("m•••@example.com"), true);
  is("the person is deleted meanwhile", await forgetLeadPerson(shop, SECOND), 1);
  is("so what it read is thrown away: nothing kept, no draft", [await writeSnapshot(shop, readF, Math.floor(stale / 1000) + 6, heldF, versionF, 1), (await bookKeys(statsId)).filter((k) => k === statsKey || k.includes(":book:new"))], [null, []]);
  await releaseRefresh(heldF);
  // The same, through a page load: the deletion lands while its refresh reads the program's records.
  const THIRD = "nora.buyer@example.com";
  await addLead(THIRD);
  let erased = false;
  redis.pipeline = async (commands) => {
    const reply = await plain.call(redis, commands);
    if (!erased && commands.some((c) => c[0] === "HGETALL" && String(c[1]) === `nl:aff:${statsId}:leads`)) {
      erased = true;
      await forgetLeadPerson(shop, THIRD);
    }
    return reply;
  };
  const during = await admitAffiliatePage(shop, as(idOf(0)), stale + 9 * BOOK_FRESH_SECONDS * 1000);
  redis.pipeline = plain;
  is("the load shows nothing it read before the deletion, and nothing is kept", [erased, during.admitted && during.book, JSON.stringify(await redis.pipeline([["HGETALL", statsKey]])).includes("n•••@")], [true, "soon", false]);

  part("A deletion tried again after its first try stopped still deletes the book");
  await writeHeld(shop, await readBook(shop), Math.floor(stale / 1000) + 7);
  is("a book is kept", (await redis.pipeline([["EXISTS", statsKey]]))[0], 1);
  is("the address is already off the lead: nothing more to take off it", await forgetLeadPerson(shop, THIRD), 0);
  is("but the kept book is deleted all the same", (await redis.pipeline([["EXISTS", statsKey]]))[0], 0);

  part("A Redis that cannot run the scripts writes nothing");
  await writeHeld(shop, await readBook(shop), Math.floor(stale / 1000) + 8);
  const kept8 = JSON.stringify(await redis.pipeline([["HGETALL", statsKey]]));
  const versionBefore = await readBookVersion(shop);
  const emulated = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "EVAL")) throw new Error("ERR unknown command 'EVAL'");
    return emulated.call(redis, commands);
  };
  const heldG = await claimRefresh(shop);
  const triedG = heldG ? await beginAttempt(shop, heldG, Math.floor(stale / 1000) + 9) : "no lock";
  const wroteG = heldG ? await writeSnapshot(shop, await readBook(shop), Math.floor(stale / 1000) + 9, heldG, versionBefore, 1) : "no lock";
  redis.pipeline = emulated;
  is("no refresh is counted and nothing is written: the book stays as it was, no draft", [triedG, wroteG, JSON.stringify(await redis.pipeline([["HGETALL", statsKey]])) === kept8, (await bookKeys(statsId)).filter((k) => k.includes(":book:new"))], [null, null, true, []]);
  if (heldG) await releaseRefresh(heldG);
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "EVAL")) throw new Error("ERR unknown command 'EVAL'");
    return emulated.call(redis, commands);
  };
  const forgot = await forgetBookSnapshot(statsId).then(() => "done", () => "threw");
  redis.pipeline = emulated;
  is("a deletion without them still raises the version and deletes the book, and fails so it is tried again", [forgot, (await readBookVersion(shop)) !== versionBefore, (await redis.pipeline([["EXISTS", statsKey]]))[0]], ["threw", true, 0]);
  const line = PERSON_DATA.find((d) => d.file === "lib/affiliate-book-snapshot.ts");
  is("the privacy line says how long it is really kept", [BOOK_KEEP_SECONDS, line?.what.includes("kept for up to eight days")], [8 * 86_400, true]);

  part("A refused load reads nothing");
  await takePublicRequest(shop, "buyer", Date.now(), requestLimitFor(shop));
  is("the window used up", await takePublicRequest(shop, "buyer", Date.now(), 1), false);
  const refused = await watched(() => admitAffiliatePage(shop, as(idOf(4)), later + BOOK_FRESH_SECONDS * 1000));
  is("refused, and no record of the program read", [refused.value, count(refused.names, "HGETALL"), count(refused.names, "HGET") <= 1], [{ admitted: false }, 0, true]);
  const visitor = await watched(() => admitAffiliatePage(shop, null));
  is("somebody not signed in: the page rests with the store's others", [visitor.value, count(visitor.names, "HGETALL")], [{ admitted: false }, 0]);
  const page = readFileSync("app/[handle]/affiliates/page.tsx", "utf8");
  const gate = page.indexOf("const admission = await admitAffiliatePage(store, affiliate);");
  is("the page asks before it reads listings or codes, never works the book out itself, and says when its figures are from", [gate > 0, gate < page.indexOf("await readListings("), gate < page.indexOf("await codeOwners("), page.includes("await readBook("), page.includes("a.figuresAsOf(asOf)"), page.includes("a.figuresSoon")], [true, true, true, false, true, true]);

  part("Only the affiliate book is counted outside a connection's share");
  is("a closed list: the one refresh done for everybody", sharedCallers(sourcesUnder("lib", "app")), ["lib/affiliate-page-admission.ts"]);
  const tricks = [
    { file: "multi-line.ts", text: "await takePublicRequest(\n  store,\n  \"buyer\",\n  now,\n  units,\n  { shared: true },\n);" },
    { file: "variable.ts", text: "const shared = true;\nawait takePublicRequest(store, \"buyer\", now, units, { shared });" },
    { file: "options.ts", text: "const from = { shared: true };\nawait takePublicRequest(store, \"buyer\", now, units, from);" },
    { file: "alias.ts", text: "const take = takePublicRequest;\nawait take(store, \"buyer\", now, units, { shared: true });" },
    { file: "plain.ts", text: "import { takePublicRequest } from \"@/lib/traffic\";\nawait takePublicRequest(store, \"buyer\", now, units);" },
  ];
  is("and the reading finds a call over several lines, { shared } from a variable, options passed whole and an alias, and not a plain call", sharedCallers(tricks), ["alias.ts", "multi-line.ts", "options.ts", "variable.ts"]);

  part("Working the book out is not held against one connection's share of the day");
  let big = await paidStore("share-owner@example.com", "shareshop", "acct_1TestShareshop1");
  await program(big.statsId!, 10, 60_000);
  big = (await storeForEmail("share-owner@example.com"))!;
  const bigUnits = (await affiliatePageCost(big))!;
  const share = clientDayShare(requestLimitFor(big));
  is(`a large program's book (${bigUnits} requests) is more than one connection's day (${share})`, bigUnits > share, true);
  answering(new Request("https://marktmorgen.com/@shareshop/affiliates", { headers: { "x-forwarded-for": "203.0.113.9" } }));
  try {
    const first = await watched(() => admitAffiliatePage(big, as(idOf(0))));
    is("worked out all the same, for every affiliate", [first.value.admitted && first.value.book !== null && first.value.book !== "soon", count(first.names, "HGETALL")], [true, 7]);
    is("the same requests taken from the connection's own count would be refused", await takePublicRequest(big, "buyer", Date.now(), bigUnits), false);
  } finally {
    answering(null);
  }

  part("A slow Stripe: the refresh stops in time, keeps a short book, and is paid once");
  let slow = await paidStore("slow-owner@example.com", "slowshop", "acct_1TestSlowshop1");
  await program(slow.statsId!, 3, 12);
  slow = (await storeForEmail("slow-owner@example.com"))!;
  const slowFull = (await affiliatePageCost(slow))!;
  const T0 = Date.now();
  const skewBefore = skew;
  stripeCalls = 0;
  slowStripe = true;
  const slowFirst = await watched(() => admitAffiliatePage(slow, as(idOf(0)), T0));
  slowStripe = false;
  // The time Stripe's calls took on the check's clock.
  const spent = skew - skewBefore;
  is(`Stripe asked no longer than BOOK_READ_SECONDS (${stripeCalls} calls of 20 s, ${spent / 1000} s), where it would have taken 23 calls`, [spent <= BOOK_READ_SECONDS * 1000, stripeCalls < 23], [true, true]);
  is("what it read is kept as an incomplete book, worked out again soon, and the page says so", [(await snapshotState(slow, idOf(0)))?.freshFor, (await snapshotState(slow, idOf(0)))?.kept, shownOf(slowFirst.value)?.refresh], [BOOK_SHORT_SECONDS, true, "short"]);
  is("one charge: this load and the book", slowFirst.taken, load + slowFull);
  const slowAgain = await watched(() => admitAffiliatePage(slow, as(idOf(1)), T0 + 60_000));
  is("a minute later: no second charge for the book, only the load's own part", [slowAgain.taken, count(slowAgain.names, "HGETALL")], [load, 0]);
  const slowLater = await watched(() => admitAffiliatePage(slow, as(idOf(1)), T0 + (BOOK_SHORT_SECONDS + 60) * 1000));
  is("after the short wait, Stripe answering again: worked out once more, complete", [slowLater.taken, count(slowLater.names, "HGETALL"), (await snapshotState(slow, idOf(1)))?.freshFor], [load + slowFull, 7, BOOK_FRESH_SECONDS]);

  part("A refresh stopped before it writes still counts");
  const T1 = T0 + (BOOK_SHORT_SECONDS + 60 + BOOK_FRESH_SECONDS + 60) * 1000;
  const unstopped = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "HGETALL" && String(c[1]) === `nl:aff:${slow.statsId}:people`)) throw new Error("the function was stopped");
    return unstopped.call(redis, commands);
  };
  const stopped = await watched(() => admitAffiliatePage(slow, as(idOf(0)), T1).catch(() => "stopped" as const));
  redis.pipeline = unstopped;
  is("the refresh was paid for and stopped with nothing written", [stopped.value, stopped.taken, (await snapshotState(slow, idOf(0)))?.at], ["stopped", load + slowFull, Math.floor((T0 + (BOOK_SHORT_SECONDS + 60) * 1000) / 1000)]);
  const stoppedState = await snapshotState(slow, idOf(0));
  is("counted before it read: one refresh without a complete book, begun then", [stoppedState?.tries, stoppedState?.triedAt], [1, Math.floor(T1 / 1000)]);
  const afterStop = await watched(() => admitAffiliatePage(slow, as(idOf(0)), T1 + 60_000));
  is("so the next load does not pay for it again before the short wait: the last book kept, its own part paid", [afterStop.taken, count(afterStop.names, "HGETALL"), shownOf(afterStop.value) !== null], [load, 0, true]);
  const afterWait = await watched(() => admitAffiliatePage(slow, as(idOf(0)), T1 + (BOOK_SHORT_SECONDS + 60) * 1000));
  is("after it, once more, and a complete book sets the count back", [afterWait.taken, (await snapshotState(slow, idOf(0)))?.tries, (await snapshotState(slow, idOf(0)))?.triedAt], [load + slowFull, 0, 0]);
  const refusedSlow = await claimRefresh(slow);
  is("a refresh counted before its charge", await beginAttempt(slow, refusedSlow!, 1), 1);
  await undoAttempt(slow, refusedSlow!, 1);
  is("whose charge is refused takes its count back: nothing left of it", [(await snapshotState(slow, idOf(0)))?.tries, (await snapshotState(slow, idOf(0)))?.triedAt], [0, 0]);
  await releaseRefresh(refusedSlow!);

  part("The store's map");
  const MAP = "map-owner@example.com";
  await claimHandle(MAP, "mapshop", "Map Shop", "");
  await ensureStatsId(MAP);
  await setSubscription(MAP, { customerId: "cus_map", subscriptionId: "sub_map", active: true, tier: "creator", period: paidPeriod() });
  for (let i = 0; i < 3; i += 1) await addProduct(MAP, `Guide ${i}`, "", "19", null);
  let mapShop = (await storeForEmail(MAP))!;
  let n = 0;
  const nextId = () => (n++).toString(16).padStart(10, "0");
  for (let i = 0; i < 14; i += 1) await savePost(mapShop.statsId, null, { title: `Post ${i}`, body: "Words.", product: null, draft: false }, nextId, ROOM, 1_000 + i);
  mapShop = (await storeForEmail(MAP))!;

  const mapSize = await watched(() => sitemapSize(mapShop));
  is("counted with one command", mapSize.names, ["ZCARD"]);
  is("its size: three products the store record carries (nothing read for them) and two pages of posts", mapSize.value, { listings: 0, carried: 3, postPages: 2 });
  const want = await storeSitemap(mapShop);
  const drawn = await watched(() => paidStoreSitemap(mapShop));
  is("the same map as before, every product, the blog and its posts", drawn.value, want);
  is(`it took ${sitemapUnits(mapSize.value!)} requests first, the size it reads`, drawn.taken, sitemapUnits(mapSize.value!));
  is("and read no more pages of posts than were paid for", count(drawn.names, "ZREVRANGE") <= mapSize.value!.postPages, true);
  is(`its bytes (${drawn.bytes}) stay inside what was priced`, drawn.bytes <= mapSize.value!.listings * PUBLIC_LISTING_BYTES + mapSize.value!.postPages * 12 * 2_048 + 4_096, true);

  part("A refused map reads nothing");
  await takePublicRequest(mapShop, "buyer", Date.now(), requestLimitFor(mapShop));
  is("the window used up", await takePublicRequest(mapShop, "buyer", Date.now(), 1), false);
  const none = await watched(() => paidStoreSitemap(mapShop));
  is("refused", none.value, null);
  is(`no listing and no post read (${none.names.join(" ")})`, ["MGET", "ZREVRANGE", "HMGET"].some((c) => none.names.includes(c)), false);
  const route = readFileSync("app/[handle]/store-sitemap/route.ts", "utf8");
  is("the route answers a refusal with 503 and Retry-After, kept by no cache", [route.includes("paidStoreSitemap(store)"), route.includes('status: 503, headers: { "Retry-After": "3600", "Cache-Control": "no-store"')], [true, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
