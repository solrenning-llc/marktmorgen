/**
 * Sweep A2 finding 11 (docs/reviews/c5-sweep-a2.md), synthetic only.
 *
 * lib/directory-index.ts read an unknown SCARD as "no program listed" (`Number(count) || 0`) and an unknown SSCAN as
 * "no sid, walk finished" (`Array.isArray(reply) ? reply : []`, `next: "0"`). lib/affiliate-directory.ts readDirectory
 * then built the public directory from no stores and kept that empty page (nl:dir:page "[]", ten minutes) for every
 * visitor. An unknown reply now throws UnknownReplyError; readDirectory keeps nothing, and the page shows its own
 * "The program list is unavailable just now" state (app/affiliate-programs/page.tsx, `readDirectory().catch(() => null)`, once a request).
 *
 * Siblings in readDirectory: a store read that failed dropped that program from the page that was then kept, and a
 * failed numbers read kept a row without its numbers for ten minutes. A failed store read now fails the read; a
 * failed numbers read still shows the row without numbers (as before) but nothing is kept.
 *
 * An exact empty set (SCARD 0, SSCAN ["0", []]) is still a true empty.
 */
import { DIRECTORY_CACHE, listedCount, listedStores } from "@/lib/directory-index";
import * as directory from "@/lib/affiliate-directory";
import { DIRECTORY_BUILD_SECONDS, readDirectory as build } from "@/lib/affiliate-directory";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);

/**
 * Each read here is a build of its own: the minute between builds (DIRECTORY_BUILD_SECONDS) has passed first. How
 * often builds run is tested in tests/directory-assembly-ceiling.test.ts.
 */
async function readDirectory(): ReturnType<typeof build> {
  advance(DIRECTORY_BUILD_SECONDS * 1000);
  return build();
}
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
  is("healthy again, both are listed", (await readDirectory()).map((row) => row.handle).sort(), ["breadhouse", "yogaroom"]);

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
  is("the next read has the numbers again", (await readDirectory())[0]?.numbers !== null, true);

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

  done();
}

main();
