/**
 * 273 [BK1], files part 3: the two pages of the backup files route that are
 * not a listing (app/api/backup/files/route.ts): `?page=stores`, the stores to
 * copy with R, the room of each one's plan (lib/backup-stores.ts), and
 * `?page=deletions`, the deletion records the site keeps
 * (lib/backup-deletions.ts). Against the in-memory database, a stand-in Blob
 * that must never be reached (tests/backup-files-world.ts) and a synthetic
 * review (tests/backup-files-review-fixture.ts). Nothing real is reached.
 *
 * What fails here:
 *   - a store left out, listed twice, or listed with a smaller R than its
 *     plan's (plan storage + students' room + community pictures); a store
 *     whose plan cannot be read listed at all instead of a 503;
 *   - a SCAN or GET that does not read exactly (rule 24) answered as a page,
 *     least of all as a complete one;
 *   - a deletion record lost, repeated or reordered across pages; a resume
 *     point the site no longer keeps read as "nothing was deleted" (it is a
 *     409); a record that is not exactly the contract's answered at all;
 *   - either page answered past the day's reviewed pages, or with anything
 *     but `page` and `cursor` in the request.
 */
import * as route from "@/app/api/backup/files/route";
import { parseDeletionPage, parseStoresPage } from "@/lib/backup-files-contract";
import { TASK_ROOM_BYTES } from "@/lib/assignment-rules";
import { COMMUNITY_PICTURES, PICTURE_BYTES } from "@/lib/community-picture-rules";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { storeFolder } from "@/lib/store";
import { blobWorld, resetBlobWorld } from "./backup-files-world";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const SECRET = "route-secret-synthetic-0123456789abcdef";
const DAY = 86_400_000;
const dayOf = (ms: number) => Math.floor(ms / DAY);
const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const room = (tier: "creator" | "pro" | "scale") => PAID_STORAGE_BYTES[tier] + TASK_ROOM_BYTES[tier] + COMMUNITY_PICTURES[tier] * PICTURE_BYTES;
const ownerKey = (n: number) => `nl:store:owner:${n.toString(16).padStart(40, "0")}`;
const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

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

function reset(): void {
  resetBlobWorld();
  redis.clear();
  commands = [];
  inject = null;
  process.env.BACKUP_FILES_ROUTE_SECRET = SECRET;
  process.env.CRON_SECRET = "cron-secret-synthetic-0123456789abcdef";
}

async function call(query: string, auth: string | null = `Bearer ${SECRET}`): Promise<{ status: number; text: string; json: unknown }> {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  const response = await route.GET(new Request(`https://marktmorgen.test/api/backup/files${query}`, { headers }));
  const text = await response.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}
const errorOf = (answer: { json: unknown }) => (answer.json as { error?: string } | null)?.error;
const scans = () => commands.filter((c) => c[0] === "SCAN").length;
const lranges = () => commands.filter((c) => c[0] === "LRANGE").length;

async function seedStore(n: number, value: Record<string, unknown>): Promise<void> {
  await realPipeline([["SET", ownerKey(n), JSON.stringify(value)]]);
}
const storeValue = (email: string, more: Record<string, unknown> = {}) => ({ handle: `h-${email.split("@")[0]}`, name: "Synthetic", email, ...more });

/** SCAN answered a page at a time, `size` keys a page, as Redis walks a large keyspace. */
function pagedScan(size: number): (list: unknown[][]) => unknown {
  return (list) => {
    if (list.length !== 1 || list[0][0] !== "SCAN") return undefined;
    return (async () => {
      const [[, all]] = (await realPipeline([["SCAN", "0", "MATCH", "nl:store:owner:*", "COUNT", 1_000_000]])) as [[string, string[]]];
      const sorted = [...all].sort();
      const at = Number(list[0][1]);
      const next = at + size < sorted.length ? String(at + size) : "0";
      return [[next, sorted.slice(at, at + size)]];
    })();
  };
}

async function record(day: number, records: { source: string; key: string; recordedAt: number; reason: string }[]): Promise<void> {
  await realPipeline([["RPUSH", `nl:backup:del:${isoDay(day)}`, ...records.map((r) => JSON.stringify(r))], ["EXPIRE", `nl:backup:del:${isoDay(day)}`, 14 * 86_400]]);
}
const rec = (n: number, at: number, reason = "creator_deleted") => ({ source: "blob", key: `stores/0123456789abcdef0123456789abcdef/f${n}.pdf`, recordedAt: at, reason });

async function main(): Promise<void> {
  part("the stores page: every store, each with R, the room of its plan");
  reset();
  await seedStore(1, storeValue("a@x.test", { tier: "pro" }));
  await seedStore(2, storeValue("b@x.test", { tier: "scale", sid: "aaaabbbbccccddddeeeeffff00001111", extra: true }));
  await seedStore(3, storeValue("c@x.test"));
  await seedStore(4, storeValue("d@x.test", { tier: "creator", subscriptionActive: false }));
  let answer = await call("?page=stores");
  is("200", answer.status, 200);
  let page = parseStoresPage(answer.json);
  const want = [
    { store: await storeFolder("a@x.test"), roomBytes: room("pro") },
    { store: await storeFolder("#aaaabbbbccccddddeeeeffff00001111"), roomBytes: room("scale") },
    { store: await storeFolder("c@x.test"), roomBytes: room("creator") },
    { store: await storeFolder("d@x.test"), roomBytes: room("creator") },
  ].sort((x, y) => x.store.localeCompare(y.store));
  is("every store, by the folder its files are kept in, with its plan's R", [...page.stores].sort((x, y) => x.store.localeCompare(y.store)), want);
  is("one walk: complete, no cursor", [page.complete, page.reason, page.cursor], [true, "done", null]);
  is("R is plan storage + the students' room + the community pictures, never less", [room("creator"), room("pro"), room("scale")], [5 * 1024 ** 3 + 250 * 1024 ** 2 + 200 * PICTURE_BYTES, 40 * 1024 ** 3 + 1024 ** 3 + 1000 * PICTURE_BYTES, 80 * 1024 ** 3 + 2 * 1024 ** 3 + 3000 * PICTURE_BYTES]);
  is("nothing listed or signed from a file store", [blobWorld.listCalls.length, blobWorld.tokenCalls.length], [0, 0]);
  is("the database: the day's count, a SCAN, a GET for each store", [commands[0][0], commands[1][0], scans(), commands.filter((c) => c[0] === "GET").length], ["SET", "INCRBY", 1, 4]);
  is("the day's count is the stores page's own", commands[0][1], `nl:backup:files:day:${new Date().toISOString().slice(0, 10)}:stores`);

  reset();
  answer = await call("?page=stores");
  is("no store at all: an empty, complete page (SCAN said so)", [answer.status, (answer.json as { stores?: unknown[] }).stores, (answer.json as { complete?: boolean }).complete], [200, [], true]);

  part("the stores page in several calls: no store lost or repeated");
  reset();
  for (let n = 1; n <= 250; n++) await seedStore(n, storeValue(`s${n}@x.test`, { tier: "pro" }));
  inject = pagedScan(100);
  const seen: string[] = [];
  let cursor: string | null = null;
  let calls = 0;
  do {
    answer = await call(cursor === null ? "?page=stores" : `?page=stores&cursor=${cursor}`);
    page = parseStoresPage(answer.json);
    seen.push(...page.stores.map((s) => s.store));
    cursor = page.cursor;
    calls += 1;
  } while (cursor !== null && calls < 10);
  is("more than one call, the last one complete", [calls > 1, page.complete], [true, true]);
  is("each of the 250 stores exactly once", [seen.length, new Set(seen).size], [250, 250]);

  part("the stores page fails, never shrinks (rule 24)");
  for (const [what, prepare] of [
    ["a plan the code does not know", async () => seedStore(9, storeValue("z@x.test", { tier: "gold" }))],
    ["a store record that is not JSON", async () => { await realPipeline([["SET", ownerKey(9), "{not json"]]); }],
    ["a store record without its address", async () => seedStore(9, { handle: "h", name: "n", tier: "pro" })],
    ["a SCAN that does not read", async () => { inject = (list) => (list[0][0] === "SCAN" ? [["x", "y"]] : undefined); }],
    ["a GET that answers a number", async () => { inject = (list) => (list[0][0] === "GET" ? list.map(() => 7) : undefined); }],
    ["a GET pipeline with a reply missing", async () => { inject = (list) => (list[0][0] === "GET" ? [] : undefined); }],
  ] as const) {
    reset();
    await seedStore(1, storeValue("a@x.test", { tier: "pro" }));
    await prepare();
    answer = await call("?page=stores");
    is(`${what}: 503 stores_unavailable, no store answered`, [answer.status, errorOf(answer), answer.text.includes("roomBytes")], [503, "stores_unavailable", false]);
  }

  part("the deletions page: the records the site keeps, in order, resumed by its cursor");
  reset();
  const now = Date.now();
  const today = dayOf(now);
  answer = await call("?page=deletions");
  let records = parseDeletionPage(answer.json);
  is("no record kept: 200, empty, complete, with the point to resume from", [answer.status, records.records, records.complete, typeof records.cursor], [200, [], true, "string"]);
  const start = records.cursor;
  await record(today, [rec(1, now), rec(2, now, "privacy_request"), rec(3, now, "store_closed")]);
  answer = await call(`?page=deletions&cursor=${start}`);
  records = parseDeletionPage(answer.json);
  is("the three records, exactly, in the order written", records.records, [rec(1, now), rec(2, now, "privacy_request"), rec(3, now, "store_closed")]);
  is("complete, with a new resume point", [records.complete, records.reason, records.cursor !== start], [true, "done", true]);
  const after = records.cursor;
  answer = await call(`?page=deletions&cursor=${after}`);
  is("read again from there: nothing new", parseDeletionPage(answer.json).records, []);
  await record(today, [rec(4, now), rec(5, now)]);
  answer = await call(`?page=deletions&cursor=${after}`);
  is("two more written since: exactly those two", parseDeletionPage(answer.json).records.map((r) => r.key), [rec(4, now).key, rec(5, now).key]);
  is("one LRANGE a day read, no other command but the day's count", commands.filter((c) => !["SET", "INCRBY", "LRANGE"].includes(String(c[0]))).length, 0);

  part("from the start: every day still kept, the oldest first");
  reset();
  await record(today - 3, [rec(10, (today - 3) * DAY + 5)]);
  await record(today - 1, [rec(11, (today - 1) * DAY + 5)]);
  await record(today, [rec(12, now)]);
  answer = await call("?page=deletions");
  records = parseDeletionPage(answer.json);
  is("three days in one call, in order", records.records.map((r) => r.key.slice(-7)), ["f10.pdf", "f11.pdf", "f12.pdf"]);
  is("at most one LRANGE a day of the 14 kept", lranges() <= 16, true);

  part("a page holds at most 1,000 records; the next call goes on from the next");
  reset();
  await record(today, Array.from({ length: 1500 }, (_, n) => rec(n, now)));
  answer = await call(`?page=deletions&cursor=${cursorOf({ v: 1, k: "del", d: today, i: 0 })}`);
  records = parseDeletionPage(answer.json);
  is("1,000, more to come", [records.records.length, records.complete, records.reason], [1000, false, "more"]);
  answer = await call(`?page=deletions&cursor=${records.cursor}`);
  const rest = parseDeletionPage(answer.json);
  is("then the other 500, none lost or repeated", [rest.records.length, rest.records[0].key, rest.complete], [500, rec(1000, now).key, true]);

  part("a resume point the site no longer keeps is a 409, never an empty page");
  reset();
  answer = await call(`?page=deletions&cursor=${cursorOf({ v: 1, k: "del", d: today - 20, i: 3 })}`);
  is("20 days back: 409 records_expired, nothing read", [answer.status, errorOf(answer), lranges()], [409, "records_expired", 0]);
  answer = await call(`?page=deletions&cursor=${cursorOf({ v: 1, k: "del", d: today + 2, i: 0 })}`);
  is("a day still to come: 400", answer.status, 400);
  for (const bad of ["%7B%7D", cursorOf({ v: 1, k: "stores", c: "0" }), cursorOf({ v: 1, k: "del", d: today, i: -1 }), cursorOf({ v: 1, k: "del", d: today, i: 0, x: 1 })]) {
    is(`a cursor that is not this page's (${bad.slice(0, 12)}): 400`, (await call(`?page=deletions&cursor=${bad}`)).status, 400);
  }
  is("no command for any of them", lranges(), 0);

  part("a record that does not read is a 503, never skipped (rule 24)");
  for (const [what, item] of [
    ["not JSON", "{oops"],
    ["an extra field", JSON.stringify({ ...rec(1, now), person: "a@b.c" })],
    ["a reason the contract does not know", JSON.stringify(rec(1, now, "other"))],
  ] as const) {
    reset();
    await realPipeline([["RPUSH", `nl:backup:del:${isoDay(today)}`, JSON.stringify(rec(0, now)), item]]);
    answer = await call("?page=deletions");
    is(`${what}: 503 deletions_unavailable, no record answered`, [answer.status, errorOf(answer), answer.text.includes("recordedAt")], [503, "deletions_unavailable", false]);
  }
  reset();
  inject = (list) => (list[0][0] === "LRANGE" ? list.map(() => "not a list") : undefined);
  answer = await call("?page=deletions");
  is("an LRANGE that does not answer a list: 503", [answer.status, errorOf(answer)], [503, "deletions_unavailable"]);

  part("both pages: the same secret, the day's reviewed pages, and nothing else in the request");
  reset();
  is("no secret sent: 404", [(await call("?page=stores", null)).status, (await call("?page=deletions", null)).status, commands.length], [404, 404, 0]);
  await realPipeline([["SET", `nl:backup:files:day:${new Date().toISOString().slice(0, 10)}:deletions`, "40", "EX", 86_400]]);
  answer = await call("?page=deletions");
  is("past the day's 40 reviewed pages: 429, nothing read", [answer.status, errorOf(answer), lranges()], [429, "day_ceiling", 0]);
  is("the stores page has its own count", (await call("?page=stores")).status, 200);
  for (const query of ["?page=stores&source=blob", "?page=deletions&store=0123456789abcdef0123456789abcdef", "?page=other", "?page=stores&page=stores"]) {
    is(`${query}: 400`, (await call(query)).status, 400);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
