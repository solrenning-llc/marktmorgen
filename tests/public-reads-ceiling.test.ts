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
 *   - a refused load reads nothing of the book;
 *   - the store's map counts its posts with one command and takes
 *     sitemapUnits before reading a listing or a post; refused, it reads
 *     nothing and tells the crawler to come back.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { answering } from "./security/next-headers";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { type Affiliate, bookSize, readBook } from "@/lib/affiliates";
import { admitAffiliatePage, affiliatePageCost } from "@/lib/affiliate-page-admission";
import { BOOK_FRESH_SECONDS, BOOK_SHORT_SECONDS, BOOK_SHORT_TRIES, bookSlice, claimRefresh, keptSlice, releaseRefresh, snapshotState, writeSnapshot } from "@/lib/affiliate-book-snapshot";
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
globalThis.fetch = (async (input: string | URL | Request) => {
  stripeCalls += 1;
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

/**
 * HSTRLEN and RENAME, which the kept book uses and the in-memory Redis
 * (lib/redis-memory.ts, reserved elsewhere today) does not answer: done here
 * with the commands it does, for hashes, as Redis does them.
 */
const memory = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  const out: unknown[] = [];
  for (const c of commands) {
    if (c[0] === "HSTRLEN") {
      const [value] = await memory([["HGET", c[1], c[2]]]);
      out.push(typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0);
    } else if (c[0] === "RENAME") {
      const [fields, ttl] = await memory([["HGETALL", c[1]], ["PTTL", c[1]]]);
      const flat = Array.isArray(fields) ? (fields as string[]) : [];
      if (!flat.length) throw new Error("ERR no such key");
      await memory([["DEL", c[2]], ["HSET", c[2], ...flat], ...(Number(ttl) > 0 ? [["PEXPIRE", c[2], Number(ttl)]] : []), ["DEL", c[1]]]);
      out.push("OK");
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
  await writeSnapshot(shop, { ...whole2, rows: whole2.rows.filter((r) => r.affiliate.id !== idOf(9)) }, Math.floor(stale / 1000));
  is("a newer book replaces the older whole: no part of the old one stays behind", (await snapshotState(shop, idOf(9)))?.sliceBytes, 0);
  const original = redis.pipeline;
  redis.pipeline = async (commands) => {
    if (commands.some((c) => c[0] === "RENAME")) throw new Error("synthetic write failure");
    return original.call(redis, commands);
  };
  const markOnly = await writeSnapshot(shop, whole2, Math.floor(stale / 1000));
  redis.pipeline = original;
  const marked = await snapshotState(shop, idOf(2));
  is("a book that could not be kept still marks when it was worked out", [markOnly.kept, marked?.at, marked?.kept, marked?.sliceBytes], [false, Math.floor(stale / 1000), false, 0]);
  answering(new Request("https://marktmorgen.com/@breadshop/affiliates", { headers: { "x-forwarded-for": "203.0.113.20" } }));
  try {
    const own = await watched(() => admitAffiliatePage(shop, as(idOf(2)), stale));
    is("so the next load that day does not refresh it for everybody: it works out its own book", [own.value.admitted && own.value.book !== null && own.value.book !== "soon", count(own.names, "HGETALL"), count(own.names, "SET")], [true, 7, 0]);
    is("paid in full from its own connection's share of the day", [own.taken, own.names.includes("HINCRBY")], [load + full, true]);
  } finally {
    answering(null);
  }

  part("An incomplete book is worked out again sooner, a few times");
  refundsDown = true;
  const soonest = await watched(() => admitAffiliatePage(shop, as(idOf(2)), stale + (BOOK_FRESH_SECONDS + 60) * 1000));
  const shortState = await snapshotState(shop, idOf(2));
  is("refunds not all read: in date for a quarter of an hour, and the page says so", [count(soonest.names, "HGETALL"), shortState?.freshFor, soonest.value.admitted && soonest.value.book !== null && soonest.value.book !== "soon" ? soonest.value.book.daily : null], [7, BOOK_SHORT_SECONDS, false]);
  let at = stale + (BOOK_FRESH_SECONDS + 60) * 1000;
  for (let i = 1; i < BOOK_SHORT_TRIES + 1; i += 1) {
    at += (BOOK_SHORT_SECONDS + 60) * 1000;
    await admitAffiliatePage(shop, as(idOf(2)), at);
  }
  is(`after ${BOOK_SHORT_TRIES} times running, once a day like any other`, (await snapshotState(shop, idOf(2)))?.freshFor, BOOK_FRESH_SECONDS);
  refundsDown = false;

  part("One refresh's lock is its own");
  const first = await claimRefresh(shop);
  await redis.pipeline([["DEL", `nl:aff:${statsId}:book:lock`]]);
  const second = await claimRefresh(shop);
  await releaseRefresh(first!);
  is("a load whose lock ran out cannot let go of the next one's", [second !== null, await claimRefresh(shop)], [true, null]);
  await releaseRefresh(second!);

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
  const sharedCallers = execSync("grep -rln --include=*.ts --include=*.tsx 'takePublicRequest(.*shared: true' lib app", { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  is("a closed list: the one refresh done for everybody", sharedCallers, ["lib/affiliate-page-admission.ts"]);

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
