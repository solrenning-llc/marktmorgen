/**
 * How many times the public affiliate directory is built, on top of #2921's build mark (MR: a ceiling before every
 * spend). Synthetic only: the in-memory Redis stub and a stubbed fetch, every command counted by its first word.
 *
 * #2921 (lib/affiliate-directory.ts, readDirectory) lets one build run at a time (nl:dir:build "building") and none for
 * ten minutes after one that could not finish ("failed"), and a save of a listed program drops the kept page so the
 * next visit builds at once. Nothing bounded how many healthy builds follow one another: one listed creator saving
 * in a loop, with visits in between, built the whole directory (up to 64 SSCAN + 2,000 store reads + their numbers
 * reads) once per save, with no figure to price it.
 *
 * Now, after taking the mark and before building, a build reserves its place in the window's count (nl:dir:builds,
 * INCR, the window's ten minutes set once on the key that has none): at most DIRECTORY_BUILDS_PER_TEN_MINUTES builds
 * in a window, site-wide. Past them, or with a count whose reply is unknown, nothing is built: the mark is dropped
 * and the visit is shown the last good build (nl:dir:last) without every store no longer in the listed set (one
 * SMISMEMBER), so a store whose creator has just taken it out is gone at once and the page stays up (Claude 6 on
 * #3062). With no last build kept, the visit is told the list is unavailable just now, never an empty or partial
 * list. #2921's own behavior is unchanged inside the ceiling (tests/directory-index-unknown.test.ts).
 *
 * Since the owner's decision through the coordinator (C1-20261109-1603-TODOS-71, on #3118), the window is
 * DIRECTORY_BUILD_SECONDS (an hour) with DIRECTORY_BUILDS_PER_HOUR (one) build in it, in place of 10 in ten minutes:
 * a save inside the hour no longer builds again, and its visits are shown the last good build, checked
 * (tests/directory-every-hour.test.ts).
 */
import * as index from "@/lib/directory-index";
import { DIRECTORY_BUILD, DIRECTORY_CACHE } from "@/lib/directory-index";
import * as directory from "@/lib/affiliate-directory";
import { readDirectory } from "@/lib/affiliate-directory";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const keys = index as unknown as Record<string, unknown>;
const exported = directory as unknown as Record<string, unknown>;
const LAST = (keys.DIRECTORY_LAST as string | undefined) ?? "nl:dir:last";
const COUNT = (keys.DIRECTORY_BUILDS as string | undefined) ?? "nl:dir:builds";
const CEILING = (exported.DIRECTORY_BUILDS_PER_HOUR as number | undefined) ?? 1;
const Busy = exported.DirectoryBusyError as (new (...args: never[]) => Error) | undefined;
const WINDOW_MS = 3_600_000;

function outcome(error: unknown): string {
  if (Busy && error instanceof Busy) return "busy";
  if (error instanceof UnknownReplyError) return "UnknownReplyError";
  return `other: ${String(error)}`;
}

/** The handles shown, sorted, or what the read threw. */
async function attempt(): Promise<string[] | string> {
  try {
    return (await readDirectory()).map((row) => row.handle).sort();
  } catch (error) {
    return outcome(error);
  }
}

/** Every command sent, by its first word, while `run` runs; `answer` may replace a command's reply. */
async function counted<T>(run: () => Promise<T>, answer?: (commands: Commands) => unknown[] | Promise<unknown[]> | undefined): Promise<{ result: T; words: Record<string, number> }> {
  const words: Record<string, number> = {};
  redis.pipeline = (async (commands: Commands) => {
    for (const command of commands) words[String(command[0])] = (words[String(command[0])] ?? 0) + 1;
    return answer?.(commands) ?? original(commands);
  }) as typeof redis.pipeline;
  try {
    return { result: await run(), words };
  } finally {
    redis.pipeline = original;
  }
}

async function get(key: string): Promise<unknown> {
  return (await original([["GET", key]]))[0];
}

async function ttl(key: string): Promise<unknown> {
  return (await original([["TTL", key]]))[0];
}

async function selling(email: string, handle: string, name: string): Promise<void> {
  await claimHandle(email, handle, name, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(11, "0").slice(0, 11)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true });
  const product = await addProduct(email, "Guide", "", "20", null);
  if (!product.ok) throw new Error("no product");
  await listed(email, true);
}

/** A save of the program as the studio sends it: a listed program's save drops the kept page. */
async function listed(email: string, yes: boolean, percent = 30): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent, days: 30, directory: yes }));
}

/** Spends the window's builds: a save and a visit, until the ceiling, from a fresh window. */
async function spend(email: string): Promise<number> {
  let builds = 0;
  for (let n = 0; n < CEILING; n += 1) {
    await listed(email, true, 30 + (n % 3));
    builds += (await counted(() => attempt())).words.SSCAN ?? 0;
  }
  return builds;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("cakes@example.com", "cakeshop", "Cake Shop");

  part("The ceiling is named, exported and priced");
  is("DIRECTORY_BUILDS_PER_HOUR is exported, 1 build in a window of DIRECTORY_BUILD_SECONDS, an hour", [exported.DIRECTORY_BUILDS_PER_HOUR, exported.DIRECTORY_BUILD_SECONDS], [1, 3_600]);
  is("DirectoryBusyError is exported", typeof Busy, "function");
  is("the window's count and the last good build have their keys", [keys.DIRECTORY_BUILDS, keys.DIRECTORY_LAST], ["nl:dir:builds", "nl:dir:last"]);
  const line = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_BUILDS_PER_HOUR ?? "";
  is("the registry prices the builds by name", line.length > 0, true);
  is("with the worst build, the builds in 30 days, the commands and the dollars", ["12,074", "720", "8,693,280", "US$17.39"].map((figure) => line.includes(figure)), [true, true, true, true]);
  is("and with what a visit costs when it is not built", ["nl:dir:last", "SMISMEMBER"].map((word) => line.includes(word)), [true, true]);
  const scanLine = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_SCAN_PAGES ?? "";
  is("the scan line no longer says the rate is not bounded", /not bounded|needs its own item/.test(scanLine), false);

  part("#2921 inside the ceiling: the window's one build, then a save inside the hour builds nothing");
  const first = await counted(() => attempt());
  is("the first visit builds", [first.result, first.words.SSCAN], [["breadhouse", "cakeshop"], 1]);
  is("its place is counted in the window, which ends by itself", [await get(COUNT), Number(await ttl(COUNT)) > 600 && Number(await ttl(COUNT)) <= 3_600], ["1", true]);
  is("the finished build kept the page and the last good build, and dropped the mark", [typeof (await get(DIRECTORY_CACHE)), typeof (await get(LAST)), await get(DIRECTORY_BUILD)], ["string", "string", null]);
  is("a kept page is still one GET alone", (await counted(() => readDirectory())).words, { GET: 1 });
  await listed("baker@example.com", true, 31);
  const next = await counted(() => attempt());
  is("a save drops the page and the next visit inside the hour is the last build, checked, with nothing built", [next.result, next.words.SSCAN ?? 0, next.words.SMISMEMBER], [["breadhouse", "cakeshop"], 0, 1]);

  part("A save every 30 seconds for two hours: one build in each hour, and every visit sees the list");
  advance(WINDOW_MS);
  let builds = 0;
  let shown = 0;
  const perWindow: number[] = [0, 0];
  for (let step = 0; step < 240; step += 1) {
    await listed("baker@example.com", true, 30 + (step % 5));
    const visit = await counted(() => attempt());
    const built = visit.words.SSCAN ?? 0;
    builds += built;
    perWindow[step < 120 ? 0 : 1] += built;
    if (Array.isArray(visit.result) && visit.result.join() === "breadhouse,cakeshop") shown += 1;
    advance(30_000);
  }
  is("240 saves and 240 visits build 2 times: 1 in each hour", [builds, perWindow], [2, [1, 1]]);
  is("and every one of the 240 visits is shown the list", shown, 240);

  part("Past the ceiling: the last good build, without a store taken out, and nothing built or kept");
  advance(WINDOW_MS);
  is("the window's builds are spent", await spend("baker@example.com"), CEILING);
  await listed("cakes@example.com", false);
  is("the creator's save took the page down", await get(DIRECTORY_CACHE), null);
  const past = await counted(() => attempt());
  is("the next visit is the last good build without the store just taken out", past.result, ["breadhouse"]);
  is("with no SSCAN, one GET of the last build and one SMISMEMBER", [past.words.SSCAN ?? 0, past.words.SMISMEMBER ?? 0], [0, 1]);
  is("it keeps no page from it and leaves no mark held", [await get(DIRECTORY_CACHE), await get(DIRECTORY_BUILD)], [null, null]);
  await listed("cakes@example.com", true);
  is("a store whose creator says yes again is shown again, from the last build", await attempt(), ["breadhouse", "cakeshop"]);
  advance(WINDOW_MS);
  const fresh = await counted(() => attempt());
  is("the next window builds again", [fresh.result, fresh.words.SSCAN], [["breadhouse", "cakeshop"], 1]);

  part("Past the ceiling with no last build: unavailable just now, never an empty list");
  advance(WINDOW_MS);
  await spend("baker@example.com");
  await listed("baker@example.com", true);
  await original([["DEL", LAST]]);
  const none = await counted(() => attempt());
  is("the visit is told the list is unavailable", [none.result, none.words.SSCAN ?? 0], ["busy", 0]);
  is("and nothing is kept", await get(DIRECTORY_CACHE), null);

  part("The window's count is read exactly (rule 24): unknown is no build");
  const shapes: [string, (commands: Commands) => unknown[] | undefined][] = [
    ["INCR missing", (c) => (c[0]?.[0] === "INCR" ? [undefined, 600] : undefined)],
    ["INCR null", (c) => (c[0]?.[0] === "INCR" ? [null, 600] : undefined)],
    ["INCR QUEUED", (c) => (c[0]?.[0] === "INCR" ? ["QUEUED", 600] : undefined)],
    ["INCR a numeric string", (c) => (c[0]?.[0] === "INCR" ? ["1", 600] : undefined)],
    ["INCR 0", (c) => (c[0]?.[0] === "INCR" ? [0, 600] : undefined)],
    ["INCR a fraction", (c) => (c[0]?.[0] === "INCR" ? [1.5, 600] : undefined)],
    ["TTL missing", (c) => (c[0]?.[0] === "INCR" ? [1] : undefined)],
    ["TTL text", (c) => (c[0]?.[0] === "INCR" ? [1, "600"] : undefined)],
    ["TTL -2 (the count gone)", (c) => (c[0]?.[0] === "INCR" ? [1, -2] : undefined)],
    ["EXPIRE 0 on a count with no end", (c) => (c[0]?.[0] === "INCR" ? [1, -1] : c[0]?.[0] === "EXPIRE" && c[0]?.[1] === COUNT ? [0] : undefined)],
    ["a pipeline that throws", (c) => {
      if (c[0]?.[0] === "INCR") throw new Error("synthetic network failure");
      return undefined;
    }],
  ];
  for (const [label, answer] of shapes) {
    advance(WINDOW_MS);
    await listed("baker@example.com", true, 32);
    is(`control before ${label}: a healthy build`, (await counted(() => attempt())).words.SSCAN, 1);
    await listed("baker@example.com", true, 33);
    // With one build an hour the control spent the window: the count is dropped so a healthy reply would build again.
    await original([["DEL", COUNT]]);
    const read = await counted(() => attempt(), answer);
    is(`${label}: nothing built, the last good build shown`, [read.result, read.words.SSCAN ?? 0, await get(DIRECTORY_BUILD)], [["breadhouse", "cakeshop"], 0, null]);
  }
  advance(WINDOW_MS);
  await listed("baker@example.com", true);
  await original([["DEL", LAST]]);
  const unknownAlone = await counted(() => attempt(), (c) => (c[0]?.[0] === "INCR" ? ["QUEUED", 600] : undefined));
  is("an unknown count with no last build is unknown, never an empty list", [unknownAlone.result, unknownAlone.words.SSCAN ?? 0], ["UnknownReplyError", 0]);

  part("A count left with no end gets the window's hour, and the window then ends");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await original([["DEL", DIRECTORY_CACHE], ["SET", COUNT, String(CEILING + 5)]]);
  is("control: the count has no end", await ttl(COUNT), -1);
  await original([["SET", LAST, JSON.stringify({ sids: [], rows: [] })]]);
  const healed = await counted(() => attempt());
  is("past the ceiling it builds nothing and sets the end", [healed.result, healed.words.SSCAN ?? 0, healed.words.EXPIRE ?? 0, await ttl(COUNT)], [[], 0, 1, 3_600]);
  advance(WINDOW_MS + 1);
  is("and once the window ended, it builds again", (await counted(() => attempt())).words.SSCAN, 1);

  part("The last build's own read and the listed-set check are exact");
  advance(WINDOW_MS);
  await selling("cakes@example.com", "cakeshop", "Cake Shop");
  await spend("baker@example.com");
  for (const [label, reply] of [["missing", undefined], ["null", null], ["a number", 1], ["a shorter list", [1]], ["a longer list", [1, 1, 1]], ["a string flag", ["1", "1"]], ["a flag of 2", [1, 2]], ["QUEUED", "QUEUED"]] as const) {
    await listed("baker@example.com", true);
    const read = await counted(() => attempt(), (c) => (c[0]?.[0] === "SMISMEMBER" ? [reply] : undefined));
    is(`an SMISMEMBER answering ${label} is unknown, never the list unfiltered or empty`, read.result, "UnknownReplyError");
  }
  for (const [label, reply] of [["a number", 5], ["a list", []], ["text that is not the build", "{oops"], ["sids that do not match the rows", JSON.stringify({ sids: ["x"], rows: [] })], ["an empty sid", JSON.stringify({ sids: [""], rows: [{}] })]] as const) {
    await listed("baker@example.com", true);
    // The pipeline still runs, so its DEL drops the mark; only the GET's reply is replaced.
    const read = await counted(() => attempt(), (c) =>
      c.some((command) => command[0] === "GET" && command[1] === LAST) ? original(c).then((replies) => c.map((command, at) => (command[0] === "GET" ? reply : replies[at]))) : undefined,
    );
    is(`a last build answering ${label} is unknown, and nothing is filtered from it`, [read.result, read.words.SMISMEMBER ?? 0], ["UnknownReplyError", 0]);
  }
  await listed("baker@example.com", true);
  is("healthy control: the last build, checked, is the list", await attempt(), ["breadhouse", "cakeshop"]);

  part("#2921's mark still comes first: a held or failed mark builds nothing and counts nothing");
  advance(WINDOW_MS);
  await original([["DEL", DIRECTORY_CACHE], ["DEL", COUNT], ["SET", DIRECTORY_BUILD, "failed", "EX", 600]]);
  const held = await counted(() => attempt());
  is("the read is unknown, as on #2921, with no count taken", [held.result, held.words.INCR ?? 0, await get(COUNT)], ["UnknownReplyError", 0, null]);

  done();
}

main();
