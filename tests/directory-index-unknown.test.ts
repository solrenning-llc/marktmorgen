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
 * failed numbers read kept a row without its numbers for ten minutes. A failed numbers read still shows the row
 * without numbers (as before) but nothing is kept.
 *
 * Codex N1 on #2921 (MEDIUM): a failed store read first failed the whole read, so one listed store whose read failed
 * every time showed "unavailable" (noindex) to every visitor, ten minutes after ten minutes. That store is now left
 * out of the page and counted (readDirectoryPage's `omitted`), never taken for a store that is not there: the page
 * lists the others and says how many could not be read; that page is kept ten minutes, so the builds stay one in ten
 * minutes, and the next build reads the store again. Only when no program could be read (every store read failed,
 * or none of the others lists one) does the read still fail, and the page say the list could not be checked.
 *
 * An exact empty set (SCARD 0, SSCAN ["0", []]) is still a true empty.
 *
 * CX-116 A1 on #2921 (MEDIUM): with nothing kept after a build that could not finish and nothing else bounding the
 * builds, a failure persisting in one listed store made every visit build the whole directory, twice (metadata and
 * page). A build now takes the build mark (nl:dir:build, SET NX) first; one that could not finish leaves it "failed"
 * for ten minutes, in which a read builds nothing and the page says the list could not be checked. Each part below
 * that checks a failure path starts with the mark dropped, so the failure it sees is its own.
 */
import { DIRECTORY_BUILD, DIRECTORY_BUILDS, DIRECTORY_CACHE, listedCount, listedStores, rememberListing } from "@/lib/directory-index";
import * as directory from "@/lib/affiliate-directory";
import { readDirectory, readDirectoryPage } from "@/lib/affiliate-directory";
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

/** A kept page's size: its rows and the programs it says it left out. Null when nothing is kept. */
function keptPage(raw: unknown): { rows: number; omitted: number } | null {
  if (typeof raw !== "string") return null;
  const value = JSON.parse(raw) as unknown;
  if (Array.isArray(value)) return { rows: value.length, omitted: 0 };
  const page = value as { rows: unknown[]; omitted: number };
  return { rows: page.rows.length, omitted: page.omitted };
}

/** The build mark and its seconds left: [value, TTL]. */
async function mark(): Promise<[unknown, unknown]> {
  const [value, ttl] = await original([["GET", DIRECTORY_BUILD], ["TTL", DIRECTORY_BUILD]]);
  return [value, ttl];
}

/**
 * Drops the build mark and the window's count, so the part that follows sees its own failure, not the last part's
 * window (one build an hour since C1-20261109-1603-TODOS-71: without it, the last part's build spent the hour).
 */
async function unmarked(): Promise<void> {
  await original([["DEL", DIRECTORY_BUILD], ["DEL", DIRECTORY_BUILDS]]);
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
  await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
  let storeReads = 0;
  redis.pipeline = (async (commands: Commands) => {
    const [word, key] = commands[0] ?? [];
    if (word === "GET" && key !== DIRECTORY_CACHE && ++storeReads === 1) throw new Error("synthetic network failure");
    return original(commands);
  }) as typeof redis.pipeline;
  const storeFailure = await readDirectoryPage();
  redis.pipeline = original;
  is("the read shows the program it could read and counts the one it could not, never as a program not there", [storeFailure.rows.length, storeFailure.omitted], [1, 1]);
  is("the page kept says one program is missing, it is not the whole list", keptPage(await kept()), { rows: 1, omitted: 1 });
  is("inside the hour the kept page still says so", (await readDirectoryPage()).omitted, 1);
  // One build an hour (#3118): the next build comes once the hour's kept page and count have run out.
  advance(3_600_001);
  is("healthy again an hour later, both are listed, none left out", await readDirectoryPage().then((p) => [p.rows.map((row) => row.handle).sort(), p.omitted]), [["breadhouse", "yogaroom"], 0]);

  part("Sibling: a numbers read that failed is not kept for ten minutes");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House", true);
  is("healthy, the row has its numbers", (await readDirectory())[0]?.numbers !== null, true);
  await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
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
  await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
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
    await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
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
    await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
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
  await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
  const victimStore = await storeForEmail("alphashop@example.com");
  const victim = `nl:store:id:${victimStore?.sid}`;
  const storeFails = (commands: Commands) => {
    if (commands[0]?.[0] === "GET" && commands[0][1] === victim) throw new Error("Redis error: synthetic persistent failure");
  };
  is("control: the victim's record is the GET the stand-in fails", (await original([["GET", victim]]))[0] !== null, true);
  let outcomes: string[] = [];
  let seen = await counted(async () => void (outcomes = await visits(5)), storeFails);
  is("a store read failing every time: 5 visits walk the listed set once", seen.SSCAN, 1);
  // Codex N1 on #2921 (MEDIUM): the one store is left out and counted; the other two programs stay on the page.
  is("all ten reads answer, none is \"unavailable\"", outcomes.every((o) => o === "answered"), true);
  // SET: the build's SET NX, its page and (#3062) the last good build kept for a visit past the ceiling; the nine
  // reads after it are the kept page's GET alone.
  is("one build: its SET NX, the page it keeps and its last good build, nothing more", seen.SET, 3);
  is("the build drops its mark, no \"failed\" hold", await mark(), [null, -2]);
  is("the page kept lists the two it read and says one could not be", keptPage(await kept()), { rows: 2, omitted: 1 });
  advance(300_000);
  seen = await counted(async () => void (outcomes = await visits(3)), storeFails);
  is("five minutes later still no build, and every read answers", [seen.SSCAN ?? 0, outcomes.every((o) => o === "answered")], [0, true]);
  advance(300_001);
  // One build an hour (C1-20261109-1603-TODOS-71, #3118): the kept page lasts the hour, so ten minutes later
  // nothing is built and the kept page answers.
  seen = await counted(async () => void (outcomes = await visits(3)), storeFails);
  is("ten minutes later, inside the hour, still no build: the kept page answers", [seen.SSCAN ?? 0, outcomes.every((o) => o === "answered")], [0, true]);
  advance(3_000_000);
  let again: Awaited<ReturnType<typeof readDirectoryPage>> = { rows: [], omitted: 0 };
  seen = await counted(async () => void (again = await readDirectoryPage()), storeFails);
  is("an hour later, one build reads the store again, and still leaves it out", [seen.SSCAN, again.rows.length, again.omitted], [1, 2, 1]);
  // Checked twice: the listed set, and the numbers' consent of the rows that carry them (Claude 5's MEDIUM on #3062).
  is("a save of a program in the window drops the kept page; the hour's build is spent, so the last good build is shown, checked, with its count", await (async () => {
    const store = await storeForEmail("bravoshop@example.com");
    if (store) await rememberListing(store);
    let page: Awaited<ReturnType<typeof readDirectoryPage>> = { rows: [], omitted: 0 };
    const built = await counted(async () => void (page = await readDirectoryPage()), storeFails);
    return [built.SSCAN ?? 0, built.SMISMEMBER ?? 0, page.rows.length, page.omitted];
  })(), [0, 2, 2, 1]);

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
  // Codex X6, LOW on #2921: the read that finds the mark held waits for the other build's page instead of showing
  // "unavailable" (and noindex) to a visitor who came during a healthy rebuild; it still builds nothing.
  is("two reads at once on no kept page: one builds, and both answer the rows", [seen.SSCAN, [...parallel].sort()], [1, ["breadhouse,yogaroom", "breadhouse,yogaroom"]]);
  is("the finished build kept the page and dropped the mark", [typeof (await kept()), await mark()], ["string", [null, -2]]);
  is("the next read is the kept page alone: one GET", await counted(async () => void (await readDirectory())), { GET: 1 });
  const baker = await storeForEmail("baker@example.com");
  if (baker) await rememberListing(baker);
  seen = await counted(async () => void (await readDirectory()));
  // One build an hour (C1-20261109-1603-TODOS-71): inside it, the next read is the last good build, checked.
  is("after a save drops the kept page, the next read inside the hour builds nothing and holds no mark", [seen.SSCAN ?? 0, seen.SMISMEMBER, await kept(), (await mark())[0]], [0, 1, null, null]);
  await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
  await original([["SET", DIRECTORY_BUILD, "building", "EX", 60]]);
  seen = await counted(async () => void (outcomes = await visits(1)));
  is("a build mark held (another build running): reads build nothing", [seen.SSCAN ?? 0, outcomes], [0, ["UnknownReplyError", "UnknownReplyError"]]);
  is("and each held read looks for the other build's page a bounded number of times", seen.GET ?? 0, 2 * (1 + 2 * 5));
  is(
    "the committed proof of #2921 says it is committed (Codex X6, LOW)",
    /never committed/.test(readFileSync(join(process.cwd(), "tests/c3-2921-rebuild.proof.ts"), "utf8")),
    false,
  );
  advance(60_001);
  is("a build cut short holds the page at most 60 seconds", (await readDirectory()).length, 2);
  for (const [label, reply] of [["QUEUED", "QUEUED"], ["a number", 1], ["missing", undefined]] as const) {
    await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
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

  part("One store that cannot be read never takes the whole directory down (Codex N1 on #2921, MEDIUM)");
  redis.clear();
  const TWENTY = Array.from({ length: 20 }, (_, i) => `shop${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`);
  for (const name of TWENTY) await selling(`${name}@example.com`, name, name);
  is("control: twenty programs are listed", await readDirectoryPage().then((p) => [p.rows.length, p.omitted]), [20, 0]);
  // The control's build spent the hour's place (#3118): it is given back, as a fresh hour.
  await original([["DEL", DIRECTORY_CACHE], ["DEL", DIRECTORY_BUILDS]]);
  const brokenStore = await storeForEmail("shopcc@example.com");
  const broken = `nl:store:id:${brokenStore?.sid}`;
  const brokenFails = (commands: Commands) => {
    if (commands[0]?.[0] === "GET" && commands[0][1] === broken) throw new Error("Redis error: synthetic persistent failure");
  };
  let firstRead: Awaited<ReturnType<typeof readDirectoryPage>> = { rows: [], omitted: 0 };
  let secondRead: Awaited<ReturnType<typeof readDirectoryPage>> = { rows: [], omitted: 0 };
  seen = await counted(async () => {
    firstRead = await readDirectoryPage();
    secondRead = await readDirectoryPage();
  }, brokenFails);
  is("the first read lists the 19 it could read and counts the one it could not", [firstRead.rows.length, firstRead.omitted, firstRead.rows.some((row) => row.handle === "shopcc")], [19, 1, false]);
  is("the second read, the build mark untouched, is not \"unavailable\": the same 19 and the one", [secondRead.rows.length, secondRead.omitted], [19, 1]);
  is("one build for both reads", seen.SSCAN, 1);
  is("no \"failed\" hold, and the page is kept the hour, as a healthy one", [(await mark())[0], keptPage(await kept()), Number((await original([["TTL", DIRECTORY_CACHE]]))[0]) <= 3_600], [null, { rows: 19, omitted: 1 }, true]);
  is("readDirectory, for any other caller, gives the same 19 rows", (await readDirectory()).length, 19);
  advance(3_600_001);
  is("the store readable again, the next build lists all twenty", await readDirectoryPage().then((p) => [p.rows.length, p.omitted, p.rows.some((row) => row.handle === "shopcc")]), [20, 0, true]);

  // rvB4 on #2921 (MEDIUM, rule 24): a store's id read answering in another shape is not "no such store" either. It is
  // left out and counted like a throw, never dropped from the page with nothing said (storeForIdExact, not storeForId).
  for (const [label, reply] of [["a number", 42], ["an empty string", ""], ["a list", ["x"]]] as const) {
    await original([["DEL", DIRECTORY_CACHE]]);
    await unmarked();
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "GET" && commands[0][1] === broken) return [reply];
      return original(commands);
    }) as typeof redis.pipeline;
    const shaped = await readDirectoryPage();
    redis.pipeline = original;
    is(`RED: rvB4 on #2921: a store id read answering ${label}: the 19 listed and the one counted as left out`, [shaped.rows.length, shaped.omitted, shaped.rows.some((row) => row.handle === "shopcc")], [19, 1, false]);
  }
  await original([["DEL", DIRECTORY_CACHE]]);
  await unmarked();
  is("a store id read that is nil is a store that is not there, not one left out", await (async () => {
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "GET" && commands[0][1] === broken) return [null];
      return original(commands);
    }) as typeof redis.pipeline;
    const page = await readDirectoryPage();
    redis.pipeline = original;
    return [page.rows.length, page.omitted];
  })(), [19, 0]);
  await original([["DEL", DIRECTORY_CACHE]]);
  await unmarked();

  await original([["DEL", DIRECTORY_CACHE]]);
  await unmarked();
  const allFail = await counted(async () => void (outcomes = [await failure(() => readDirectoryPage())]), (commands) => {
    if (commands[0]?.[0] === "GET" && String(commands[0][1]).startsWith("nl:store:id:")) throw new Error("Redis error: synthetic every store failure");
  });
  is("every store read failing is still not \"no program\": the read fails and the list could not be checked", [outcomes[0]?.startsWith("other:"), allFail.SSCAN, await kept(), (await mark())[0]], [true, 1, null, "failed"]);

  redis.clear();
  await selling("solo@example.com", "soloshop", "Solo Shop");
  await original([["DEL", DIRECTORY_CACHE]]);
  const soloStore = await storeForEmail("solo@example.com");
  await original([["SADD", "nl:dir:listed", "sid_not_a_store_id"]]);
  const solo = `nl:store:id:${soloStore?.sid}`;
  await counted(async () => void (outcomes = [await failure(() => readDirectoryPage())]), (commands) => {
    if (commands[0]?.[0] === "GET" && commands[0][1] === solo) throw new Error("Redis error: synthetic persistent failure");
  });
  is("one store left out and no other program read: never \"no program is listed yet\", the read fails", [outcomes[0]?.startsWith("other:"), await kept()], [true, null]);
  is("an old kept page (a bare list of rows) still reads, with nothing left out", await (async () => {
    await original([["SET", DIRECTORY_CACHE, "[]", "EX", 600]]);
    return readDirectoryPage();
  })(), { rows: [], omitted: 0 });
  for (const [label, raw] of [["omitted not a whole number", '{"rows":[],"omitted":1.5}'], ["omitted negative", '{"rows":[],"omitted":-1}'], ["rows not a list", '{"rows":{},"omitted":1}']] as const) {
    await original([["SET", DIRECTORY_CACHE, raw, "EX", 600]]);
    await unmarked();
    const sscans = await counted(async () => void (await readDirectoryPage().catch(() => null)));
    is(`a kept page with ${label} is not taken, the page is built again`, sscans.SSCAN, 1);
  }

  part("The page and its metadata share one directory read a request");
  const page = readFileSync(join(process.cwd(), "app/affiliate-programs/page.tsx"), "utf8");
  is("readDirectoryPage is called once in the page, inside React's cache()", [page.match(/readDirectory(Page)?\(/g)?.length, /const directory = cache\(\(\) => readDirectoryPage\(\)\.catch\(\(\) => null\)\);/.test(page)], [1, true]);
  is("and generateMetadata and the page both read it", page.match(/await directory\(\)/g)?.length, 2);
  is("a page with a program left out says how many, and that they did not leave (rule 27)", [
    /could not be read just now and/.test(page),
    /This does not mean they left the list\./.test(page),
    /directoryPage\.omitted > 0/.test(page),
  ], [true, true, true]);

  done();
}

main();
