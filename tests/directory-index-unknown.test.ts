/**
 * Sweep A2 finding 11 (docs/reviews/c5-sweep-a2.md), synthetic only.
 *
 * lib/directory-index.ts read an unknown SCARD as "no program listed" (`Number(count) || 0`) and an unknown SSCAN as
 * "no sid, walk finished" (`Array.isArray(reply) ? reply : []`, `next: "0"`). lib/affiliate-directory.ts readDirectory
 * then built the public directory from no stores and kept that empty page (nl:dir:page "[]", ten minutes) for every
 * visitor. An unknown reply now throws UnknownReplyError; readDirectory keeps nothing, and the page shows its own
 * "The program list is unavailable just now" state (app/affiliate-programs/page.tsx, `readDirectory().catch(() => null)`).
 *
 * Siblings in readDirectory: a store read that failed dropped that program from the page that was then kept, and a
 * failed numbers read kept a row without its numbers for ten minutes. A failed store read now fails the read; a
 * failed numbers read still shows the row without numbers (as before) but nothing is kept.
 *
 * An exact empty set (SCARD 0, SSCAN ["0", []]) is still a true empty.
 *
 * CX-116 A1 on #2921 (MEDIUM): with nothing kept after a build that could not finish and nothing else bounding the
 * builds, a failure persisting in one listed store made every visit build the whole directory, twice (metadata and
 * page). A build now takes the build mark (nl:dir:build, SET NX) first; one that could not finish leaves it "failed"
 * for ten minutes, in which a read builds nothing and the page says the list could not be checked. Each part below
 * that checks a failure path starts with the mark dropped, so the failure it sees is its own.
 */
import { DIRECTORY_BUILD, DIRECTORY_CACHE, listedCount, listedStores, rememberListing } from "@/lib/directory-index";
import * as directory from "@/lib/affiliate-directory";
import { readDirectory } from "@/lib/affiliate-directory";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];

async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "answered";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

async function kept(): Promise<unknown> {
  return (await original([["GET", DIRECTORY_CACHE]]))[0];
}

/** The build mark and its seconds left: [value, TTL]. */
async function mark(): Promise<[unknown, unknown]> {
  const [value, ttl] = await original([["GET", DIRECTORY_BUILD], ["TTL", DIRECTORY_BUILD]]);
  return [value, ttl];
}

/** Drops the build mark, so the part that follows sees its own failure, not the last part's window. */
async function unmarked(): Promise<void> {
  await original([["DEL", DIRECTORY_BUILD]]);
}

/** Every command whose first word is `word` answers `reply` instead of the stub's own answer. */
function answering(word: string, reply: unknown): void {
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === word) return [reply];
    return original(commands);
  }) as typeof redis.pipeline;
}

async function selling(email: string, handle: string, name: string, numbers = false): Promise<void> {
  await claimHandle(email, handle, name, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(11, "0").slice(0, 11)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true });
  const product = await addProduct(email, "Guide", "", "20", null);
  if (!product.ok) throw new Error("no product");
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory: true, numbers }));
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";

  part("An exact empty set is a true empty");
  is("SCARD 0 is no program listed", await listedCount(), 0);
  is("SSCAN [\"0\", []] is no sid and the walk finished", await listedStores(), { next: "0", sids: [] });
  is("the directory is empty and kept as such", [await readDirectory(), await kept()], [[], "[]"]);

  part("Healthy control");
  redis.clear();
  await original([["SADD", "nl:dir:listed", "sid_one", "sid_two"]]);
  is("two listed, both sids read", [await listedCount(), (await listedStores()).sids.sort()], [2, ["sid_one", "sid_two"]]);

  part("An unknown SCARD reply is not \"no program listed\"");
  for (const [label, reply] of [["missing", undefined], ["null", null], ["QUEUED", "QUEUED"], ["a numeric string", "2"], ["negative", -1], ["a fraction", 1.5], ["NaN", Number.NaN], ["a list", []]] as const) {
    answering("SCARD", reply);
    is(`SCARD answering ${label} throws`, await failure(() => listedCount()), "UnknownReplyError");
    redis.pipeline = original;
  }
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SCARD" ? [] : original(commands))) as typeof redis.pipeline;
  is("a pipeline with no reply for SCARD throws", await failure(() => listedCount()), "UnknownReplyError");
  redis.pipeline = original;

  part("An unknown SSCAN reply is not \"no sid, walk finished\"");
  const shapes: [string, unknown][] = [
    ["missing", undefined],
    ["null", null],
    ["QUEUED", "QUEUED"],
    ["an empty list", []],
    ["a cursor alone", ["0"]],
    ["a numeric cursor", [0, []]],
    ["members not a list", ["0", "sid_one"]],
    ["a member not a string", ["0", ["sid_one", 2]]],
    ["three slots", ["0", [], "extra"]],
  ];
  for (const [label, reply] of shapes) {
    answering("SSCAN", reply);
    is(`SSCAN answering ${label} throws`, await failure(() => listedStores()), "UnknownReplyError");
    redis.pipeline = original;
  }
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SSCAN" ? [] : original(commands))) as typeof redis.pipeline;
  is("a pipeline with no reply for SSCAN throws", await failure(() => listedStores()), "UnknownReplyError");
  is("readDirectory throws instead of building the page from no stores", await failure(() => readDirectory()), "UnknownReplyError");
  redis.pipeline = original;
  is("and keeps no page for the next visitor", await kept(), null);

  part("A page of the walk that is unknown after a healthy one");
  await unmarked();
  let scans = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SSCAN") return ++scans === 1 ? [["7", ["sid_one"]]] : [null];
    return original(commands);
  }) as typeof redis.pipeline;
  is("the second page unknown fails the read", await failure(() => readDirectory()), "UnknownReplyError");
  redis.pipeline = original;
  is("nothing kept", await kept(), null);

  part("Sibling: a store read that failed is not a program that is not there");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("yoga@example.com", "yogaroom", "Yoga Room");
  is("healthy, both programs are listed", (await readDirectory()).map((row) => row.handle).sort(), ["breadhouse", "yogaroom"]);
  await original([["DEL", DIRECTORY_CACHE]]);
  let storeReads = 0;
  redis.pipeline = (async (commands: Commands) => {
    const [word, key] = commands[0] ?? [];
    if (word === "GET" && key !== DIRECTORY_CACHE && ++storeReads === 1) throw new Error("synthetic network failure");
    return original(commands);
  }) as typeof redis.pipeline;
  const storeFailure = await failure(() => readDirectory());
  redis.pipeline = original;
  is("the read fails instead of showing one program as the whole list", storeFailure.startsWith("other:") && storeFailure.includes("synthetic network failure"), true);
  is("and keeps no page with one program missing", await kept(), null);
  advance(600_001);
  is("healthy again ten minutes later, both are listed", (await readDirectory()).map((row) => row.handle).sort(), ["breadhouse", "yogaroom"]);

  part("Sibling: a numbers read that failed is not kept for ten minutes");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House", true);
  is("healthy, the row has its numbers", (await readDirectory())[0]?.numbers !== null, true);
  await original([["DEL", DIRECTORY_CACHE]]);
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "HGETALL") throw new Error("synthetic network failure");
    return original(commands);
  }) as typeof redis.pipeline;
  const withoutNumbers = await readDirectory();
  redis.pipeline = original;
  is("the row is shown without numbers, as before", [withoutNumbers.map((row) => row.handle), withoutNumbers[0]?.numbers], [["breadhouse"], null]);
  is("but that page is not kept", await kept(), null);
  is("and the next read inside ten minutes builds nothing: the list could not be checked", await failure(() => readDirectory()), "UnknownReplyError");
  advance(600_001);
  is("the next read ten minutes later has the numbers again", (await readDirectory())[0]?.numbers !== null, true);

  // Codex T on #2921 (LEVE): SSCAN may return a member more than once, within a page or across pages, by design.
  // Every exact page was taken as is, so the same program was written twice into the directory and kept.
  part("A member SSCAN returns twice is one program in the directory (RED)");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("yoga@example.com", "yogaroom", "Yoga Room");
  const [listed] = (await original([["SMEMBERS", "nl:dir:listed"]])) as [string[]];
  const [first, second] = [...listed].sort();
  await original([["DEL", DIRECTORY_CACHE]]);
  let walk = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SSCAN") return ++walk === 1 ? [["5", [first, first, second]]] : [["0", [second, first]]];
    return original(commands);
  }) as typeof redis.pipeline;
  const once = await readDirectory();
  redis.pipeline = original;
  is("each program is one row", once.map((row) => row.handle).sort(), ["breadhouse", "yogaroom"]);
  is("and the page kept has each once", (JSON.parse(String(await kept())) as { handle: string }[]).map((row) => row.handle).sort(), ["breadhouse", "yogaroom"]);

  // Codex T on #2921 (LEVE): a cursor of the right type but not a cursor (not a string of digits) was taken as one,
  // so ["", []] or ["abc", []] ended or misled the walk and an empty directory was written. It is unknown.
  part("A cursor that is not a string of digits is unknown (RED)");
  for (const [label, cursor] of [["empty", ""], ["letters", "abc"], ["negative", "-1"], ["a fraction", "1.5"], ["a space before", " 0"], ["a newline after", "0\n"]] as const) {
    answering("SSCAN", [cursor, []]);
    is(`SSCAN with a cursor ${label} throws`, await failure(() => listedStores()), "UnknownReplyError");
    await original([["DEL", DIRECTORY_CACHE]]);
    await unmarked();
    // The bad cursor once, then an exact last page, so a walk that took it as a cursor ends instead of looping here.
    let scan = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "SSCAN") return ++scan === 1 ? [[cursor, []]] : [["0", []]];
      return original(commands);
    }) as typeof redis.pipeline;
    is(`and readDirectory with a cursor ${label} throws, keeping nothing`, [await failure(() => readDirectory()), await kept()], ["UnknownReplyError", null]);
    redis.pipeline = original;
  }
  is("a cursor of digits is still a page", (await listedStores("0")).next, "0");

  // R2/C4 on #2921 (MEDIO): the walk stopped only at cursor "0" or at MAX_ROWS distinct stores. A cursor that never
  // comes back to "0" with pages that bring nothing new (a member repeated, or empty pages, which SCAN allows on a
  // sparse table) sent one SSCAN per page with no end before the function timed out. It now reads at most
  // DIRECTORY_SCAN_PAGES pages; past them the read is unknown and nothing is kept.
  part("The walk reads at most DIRECTORY_SCAN_PAGES pages (RED)");
  const ceiling = (directory as unknown as Record<string, unknown>).DIRECTORY_SCAN_PAGES;
  is("the ceiling is exported, 64 pages", ceiling, 64);
  is("and its count is in the cost registry, by name", typeof (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_SCAN_PAGES, "string");
  const HARNESS_STOP = 200;
  /** SSCAN answers `page(n)` for its n-th call; past HARNESS_STOP the harness stops a walk that would not end. */
  async function walking(page: (n: number) => unknown): Promise<{ outcome: string; scans: number; kept: unknown }> {
    await original([["DEL", DIRECTORY_CACHE]]);
    await unmarked();
    let n = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "SSCAN") {
        if (++n > HARNESS_STOP) throw new Error("harness stop");
        return [page(n)];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    const outcome = await failure(() => readDirectory());
    redis.pipeline = original;
    return { outcome, scans: n, kept: await kept() };
  }
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  const [one] = (await original([["SMEMBERS", "nl:dir:listed"]])) as [string[]];
  is("one listed store repeated on a cursor that never ends: unknown at exactly 64 pages, nothing kept", await walking(() => ["5", [one[0]]]), { outcome: "UnknownReplyError", scans: 64, kept: null });
  is("empty pages on a cursor that never ends: unknown at exactly 64 pages, nothing kept", await walking(() => ["5", []]), { outcome: "UnknownReplyError", scans: 64, kept: null });
  const sixtyFour = await walking((n) => [n === 64 ? "0" : "5", n === 64 ? [one[0]] : []]);
  is("healthy control: a walk that ends on its 64th page is read and kept", [sixtyFour.outcome, sixtyFour.scans, (JSON.parse(String(sixtyFour.kept)) as { handle: string }[]).map((row) => row.handle)], ["answered", 64, ["breadhouse"]]);
  is("one page more than the ceiling is unknown, nothing kept", await walking((n) => [n === 65 ? "0" : "5", []]), { outcome: "UnknownReplyError", scans: 64, kept: null });
  // MAX_ROWS (2,000) distinct stores still end the walk on their own, before the page ceiling.
  is("healthy control: pages of 200 new sids stop at 2,000 stores after 10 pages", (await walking((n) => ["5", Array.from({ length: 200 }, (_, i) => `sid_${n}_${i}`)])).scans, 10);
  is("healthy control: the real stub's walk of one listed store is one page", await walking((n) => ["0", n === 1 ? [one[0]] : []]).then((r) => [r.outcome, r.scans]), ["answered", 1]);

  // CX-116 A1 on #2921 (MEDIUM): a build that could not finish kept nothing and nothing bounded the builds, so one
  // listed store whose read failed every time made every visit build the whole directory, twice.
  part("A build that could not finish is built again once in ten minutes, not on every visit (CX-116 A1)");
  /** Counts every command by its first word while `run` runs, under `fail` (which may throw for a command). */
  async function counted(run: () => Promise<void>, fail: (commands: Commands) => void = () => undefined): Promise<Record<string, number>> {
    const seen: Record<string, number> = {};
    redis.pipeline = (async (commands: Commands) => {
      for (const c of commands) seen[String(c[0])] = (seen[String(c[0])] ?? 0) + 1;
      fail(commands);
      return original(commands);
    }) as typeof redis.pipeline;
    try {
      await run();
    } finally {
      redis.pipeline = original;
    }
    return seen;
  }
  /** `n` visits, each the page's metadata and the page reading once (without the request's shared read). */
  async function visits(n: number): Promise<string[]> {
    const outcomes: string[] = [];
    for (let v = 0; v < n * 2; v += 1) outcomes.push(await failure(() => readDirectory()));
    return outcomes;
  }
  const SHOPS = ["alphashop", "bravoshop", "charlieshop"];
  redis.clear();
  for (const name of SHOPS) await selling(`${name}@example.com`, name, name, true);
  is("control: three programs are listed, each with its numbers", (await readDirectory()).map((row) => [row.handle, row.numbers !== null]), SHOPS.map((name) => [name, true]));
  await original([["DEL", DIRECTORY_CACHE]]);
  const victimStore = await storeForEmail("alphashop@example.com");
  const victim = `nl:store:id:${victimStore?.sid}`;
  const storeFails = (commands: Commands) => {
    if (commands[0]?.[0] === "GET" && commands[0][1] === victim) throw new Error("Redis error: synthetic persistent failure");
  };
  is("control: the victim's record is the GET the stand-in fails", (await original([["GET", victim]]))[0] !== null, true);
  let outcomes: string[] = [];
  let seen = await counted(async () => void (outcomes = await visits(5)), storeFails);
  is("a store read failing every time: 5 visits walk the listed set once", seen.SSCAN, 1);
  is("the first read fails as the store read, the nine after it are unknown without building", [outcomes[0]?.startsWith("other:"), outcomes.slice(1).every((o) => o === "UnknownReplyError")], [true, true]);
  // SET: the first read's SET NX and its "failed" mark, then one SET NX for each of the nine; no numbers read at all.
  is("each of those nine sends its GET and its SET NX alone", [seen.SET, seen.HGETALL ?? 0], [11, 0]);
  is("the mark says failed, for ten minutes", await mark(), ["failed", 600]);
  is("and no page is kept", await kept(), null);
  advance(300_000);
  seen = await counted(async () => void (outcomes = await visits(3)), storeFails);
  is("five minutes later still no build", [seen.SSCAN ?? 0, outcomes.every((o) => o === "UnknownReplyError")], [0, true]);
  advance(300_001);
  seen = await counted(async () => void (outcomes = await visits(3)), storeFails);
  is("ten minutes after the failure, one build again, and failing, the next ten minutes again", [seen.SSCAN, outcomes[0]?.startsWith("other:"), outcomes.slice(1).every((o) => o === "UnknownReplyError")], [1, true, true]);
  is("a save of a program in the window drops the kept page, not the mark", await (async () => {
    const store = await storeForEmail("bravoshop@example.com");
    if (store) await rememberListing(store);
    return [(await mark())[0], await failure(() => readDirectory())];
  })(), ["failed", "UnknownReplyError"]);

  redis.clear();
  for (const name of SHOPS) await selling(`${name}@example.com`, name, name, true);
  let firstRows: Awaited<ReturnType<typeof readDirectory>> = [];
  seen = await counted(
    async () => {
      firstRows = await readDirectory();
      outcomes = await visits(4);
    },
    (commands) => {
      if (commands.length === 4 && commands[0]?.[0] === "HGETALL") throw new Error("Redis error: synthetic persistent failure");
    },
  );
  is("a numbers read failing every time: the request that built shows the rows without numbers", [firstRows.length, firstRows.every((row) => row.numbers === null)], [3, true]);
  is("and the eight reads after it build nothing", [seen.SSCAN, outcomes.every((o) => o === "UnknownReplyError"), (await mark())[0], await kept()], [1, true, "failed", null]);

  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  let endless = 0;
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SSCAN" ? (++endless, [["5", []]]) : original(commands))) as typeof redis.pipeline;
  outcomes = await visits(3);
  redis.pipeline = original;
  is("the SSCAN page ceiling: 3 visits read 64 pages once, then build nothing", [endless, outcomes.every((o) => o === "UnknownReplyError"), (await mark())[0]], [64, true, "failed"]);

  part("One build at a time, and a healthy build leaves no mark");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("yoga@example.com", "yogaroom", "Yoga Room");
  let parallel: string[] = [];
  seen = await counted(async () => {
    parallel = await Promise.all([readDirectory(), readDirectory()].map((read) => read.then((rows) => rows.map((row) => row.handle).sort().join(","), (error) => (error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`))));
  });
  is("two reads at once on no kept page: one builds and answers, the other builds nothing", [seen.SSCAN, [...parallel].sort()], [1, ["UnknownReplyError", "breadhouse,yogaroom"]]);
  is("the finished build kept the page and dropped the mark", [typeof (await kept()), await mark()], ["string", [null, -2]]);
  is("the next read is the kept page alone: one GET", await counted(async () => void (await readDirectory())), { GET: 1 });
  const baker = await storeForEmail("baker@example.com");
  if (baker) await rememberListing(baker);
  seen = await counted(async () => void (await readDirectory()));
  is("after a save drops the kept page, the next read builds at once (no mark held)", [seen.SSCAN, typeof (await kept()), (await mark())[0]], [1, "string", null]);
  await original([["DEL", DIRECTORY_CACHE]]);
  await original([["SET", DIRECTORY_BUILD, "building", "EX", 60]]);
  seen = await counted(async () => void (outcomes = await visits(1)));
  is("a build mark held (another build running): reads build nothing", [seen.SSCAN ?? 0, outcomes], [0, ["UnknownReplyError", "UnknownReplyError"]]);
  advance(60_001);
  is("a build cut short holds the page at most 60 seconds", (await readDirectory()).length, 2);
  for (const [label, reply] of [["QUEUED", "QUEUED"], ["a number", 1], ["missing", undefined]] as const) {
    await original([["DEL", DIRECTORY_CACHE]]);
    await unmarked();
    let sscans = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "SSCAN") sscans += 1;
      if (commands[0]?.[0] === "SET" && commands[0][1] === DIRECTORY_BUILD && commands[0].includes("NX")) return [reply];
      return original(commands);
    }) as typeof redis.pipeline;
    const outcome = await failure(() => readDirectory());
    redis.pipeline = original;
    is(`a build mark answering ${label} is unknown and builds nothing`, [outcome, sscans], ["UnknownReplyError", 0]);
  }

  part("The page and its metadata share one directory read a request");
  const page = readFileSync(join(process.cwd(), "app/affiliate-programs/page.tsx"), "utf8");
  is("readDirectory is called once in the page, inside React's cache()", [page.match(/readDirectory\(/g)?.length, /const directory = cache\(\(\) => readDirectory\(\)\.catch\(\(\) => null\)\);/.test(page)], [1, true]);
  is("and generateMetadata and the page both read it", page.match(/await directory\(\)/g)?.length, 2);

  done();
}

main();
