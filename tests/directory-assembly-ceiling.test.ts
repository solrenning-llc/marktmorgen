/**
 * How often the public affiliate directory is built (#2921 left it unbounded; MR: a ceiling before every spend).
 * Synthetic only: the in-memory Redis stub and a stubbed fetch, every command counted by its first word.
 *
 * Before: every program save drops the kept page (nl:dir:page), a failed numbers read keeps none, and
 * generateMetadata and the page each called readDirectory, so one visit could build it twice, every visit after a
 * save built it again, and concurrent misses all built it at once. Each build is up to 1 GET + 64 SSCAN + 2,000
 * store reads + their numbers reads + 1 SET.
 *
 * Now: a build first claims nl:dir:build with SET NX EX DIRECTORY_BUILD_SECONDS. That one key is both the
 * single-flight lock (concurrent misses do not all rebuild) and the minimum interval between builds, whatever
 * dropped the page. A request that misses the kept page while the claim is held is told the list is unavailable
 * (DirectoryBusyError; the page shows its existing notice), never an old, empty or partial list. The page and its
 * metadata share one read per request (React cache).
 */
import { readFileSync } from "node:fs";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
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
const exported = directory as unknown as Record<string, unknown>;
const BUILD_SECONDS = exported.DIRECTORY_BUILD_SECONDS as number | undefined;
const Busy = exported.DirectoryBusyError as (new (...args: never[]) => Error) | undefined;
const WINDOW_MS = (typeof BUILD_SECONDS === "number" ? BUILD_SECONDS : 60) * 1000;

/** Every command sent, by its first word, while `run` runs. */
async function counted<T>(run: () => Promise<T>): Promise<{ result: T | string; words: Record<string, number> }> {
  const words: Record<string, number> = {};
  redis.pipeline = (async (commands: Commands) => {
    for (const command of commands) words[String(command[0])] = (words[String(command[0])] ?? 0) + 1;
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return { result: await run(), words };
  } catch (error) {
    return { result: outcome(error), words };
  } finally {
    redis.pipeline = original;
  }
}

function outcome(error: unknown): string {
  if (Busy && error instanceof Busy) return "busy";
  if (error instanceof UnknownReplyError) return "UnknownReplyError";
  return `other: ${String(error)}`;
}

async function attempt(): Promise<string[] | string> {
  try {
    return (await readDirectory()).map((row) => row.handle);
  } catch (error) {
    return outcome(error);
  }
}

async function kept(): Promise<unknown> {
  return (await original([["GET", DIRECTORY_CACHE]]))[0];
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

/** A save of the program, as the studio sends it: it drops the kept page. */
async function save(email: string, numbers = false): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory: true, numbers }));
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");

  part("The ceiling is named and counted");
  is("DIRECTORY_BUILD_SECONDS is exported, one build a minute at the most", BUILD_SECONDS, 60);
  is("DIRECTORY_BUILDS_PER_HOUR follows from it", exported.DIRECTORY_BUILDS_PER_HOUR, 60);
  is("DirectoryBusyError is exported", typeof Busy, "function");
  const line = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_BUILDS_PER_HOUR ?? "";
  is("the registry prices the build rate by name", line.length > 0, true);
  is("and states the bounded worst case: commands per build and builds per hour", [line.includes("12,067"), line.includes("60 builds"), line.includes("724,020")], [true, true, true]);
  const scanLine = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_SCAN_PAGES ?? "";
  is("the scan line no longer says the rate is unbounded", scanLine.includes("not bounded yet"), false);

  part("Concurrent misses build once");
  const together = await counted(() => Promise.all(Array.from({ length: 10 }, () => attempt())));
  const answers = together.result as (string[] | string)[];
  is("one of ten concurrent misses builds, with one SSCAN", together.words.SSCAN, 1);
  is("it gets the list", answers.filter((a) => Array.isArray(a)).length, 1);
  is("the nine others are told the list is unavailable, never an empty list", answers.filter((a) => a === "busy").length, 9);
  is("the built page is kept", (JSON.parse(String(await kept())) as { handle: string }[]).map((r) => r.handle), ["breadhouse"]);

  part("A kept page is served with one GET and no claim");
  const hit = await counted(() => readDirectory());
  is("one GET, nothing else", hit.words, { GET: 1 });

  part("A save inside the window does not rebuild");
  await save("baker@example.com");
  is("the save dropped the kept page", await kept(), null);
  const soon = await counted(() => attempt());
  is("the next visit is told unavailable, not shown the old list", soon.result, "busy");
  is("and sends no SSCAN", soon.words.SSCAN ?? 0, 0);
  advance(WINDOW_MS);
  const later = await counted(() => attempt());
  is("once the window passed, one build", [later.result, later.words.SSCAN], [["breadhouse"], 1]);

  part("A save every second for ten minutes builds at most once a minute");
  advance(WINDOW_MS);
  let builds = 0;
  for (let second = 0; second < 600; second += 1) {
    await save("baker@example.com");
    const visit = await counted(() => attempt());
    builds += visit.words.SSCAN ?? 0;
    const shown = visit.result;
    if (!(shown === "busy" || (Array.isArray(shown) && shown.join() === "breadhouse"))) throw new Error(`second ${second}: ${JSON.stringify(shown)}`);
    advance(1000);
  }
  is("600 saves and 600 visits, at most 10 builds", builds <= 600 / (WINDOW_MS / 1000), true);
  is("and builds did happen", builds >= 9, true);

  part("A failed build is not retried inside the window");
  advance(WINDOW_MS);
  await original([["DEL", DIRECTORY_CACHE]]);
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SSCAN" ? [null] : original(commands))) as typeof redis.pipeline;
  is("the build fails as unknown", await attempt(), "UnknownReplyError");
  redis.pipeline = original;
  const retry = await counted(() => attempt());
  is("the next visit does not walk again", [retry.result, retry.words.SSCAN ?? 0], ["busy", 0]);
  advance(WINDOW_MS);
  is("after the window, it builds again", await attempt(), ["breadhouse"]);

  part("A partial build (numbers unread) keeps nothing and is not retried inside the window");
  advance(WINDOW_MS);
  await save("baker@example.com", true);
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "HGETALL") throw new Error("synthetic network failure");
    return original(commands);
  }) as typeof redis.pipeline;
  const partial = await readDirectory();
  redis.pipeline = original;
  is("the row is shown without numbers, as before, and nothing is kept", [partial.map((r) => r.handle), partial[0]?.numbers, await kept()], [["breadhouse"], null, null]);
  const afterPartial = await counted(() => attempt());
  is("the next visit does not walk again", [afterPartial.result, afterPartial.words.SSCAN ?? 0], ["busy", 0]);

  part("The claim's own reply is read exactly (rule 24)");
  for (const [label, reply] of [["missing", undefined], ["QUEUED", "QUEUED"], ["a number", 1], ["a list", []], ["an empty string", ""]] as const) {
    advance(WINDOW_MS);
    await original([["DEL", DIRECTORY_CACHE]]);
    let scans = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "SSCAN") scans += 1;
      if (commands[0]?.[0] === "SET" && commands[0]?.includes("NX")) return [reply];
      return original(commands);
    }) as typeof redis.pipeline;
    const answer = await attempt();
    redis.pipeline = original;
    is(`a claim answering ${label} is unknown, and nothing is built`, [answer, scans], ["UnknownReplyError", 0]);
  }

  part("One read per request: the page and its metadata share it");
  const page = readFileSync("app/affiliate-programs/page.tsx", "utf8");
  is("the page imports React's cache", /import \{ cache \} from "react";/.test(page), true);
  is("readDirectory is called once in the file, inside cache(...)", [(page.match(/readDirectory\(/g) ?? []).length, /cache\(\s*(async\s*)?\(\)\s*=>\s*readDirectory\(\)/.test(page)], [1, true]);
  const shared = page.match(/const (\w+) = cache\(/)?.[1] ?? "";
  is("generateMetadata and the page both read through it", shared !== "" && (page.match(new RegExp(`await ${shared}\\(\\)`, "g")) ?? []).length === 2, true);

  done();
}

main();
