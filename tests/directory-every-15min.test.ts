/**
 * The public affiliate directory is built at most once every 15 minutes, site-wide (C1-20261107-1627-C4-5, on #3062).
 * Synthetic only: the in-memory Redis stub and a stubbed fetch, every command counted by its first word.
 *
 * Before: #3062 bounded the build to one start a minute (nl:dir:build, SET NX EX 60), but one build sends up to 12,068
 * commands, so 60 builds an hour came to 521,337,600 commands in 30 days, about US$1,042.68, a fixed company cost
 * whatever the number of visitors.
 *
 * Now: the claim and the kept page both last 15 minutes. A visit while the page is kept sends one GET. A save that can
 * change the page still drops it, but the next build waits for the claim: until then the visit is shown the last good
 * build without every store no longer in the listed set, so a store taken out is gone at once and a creator's other
 * change shows within 15 minutes. At most 4 builds an hour: 34,755,840 commands in 30 days, about US$69.51.
 */
import * as directory from "@/lib/affiliate-directory";
import { readDirectory } from "@/lib/affiliate-directory";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { UPSTASH_MICRO_USD_PER_MILLION_COMMANDS } from "@/lib/spend-cost-table";
import { HELP_SECTIONS } from "@/lib/help-content";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const exported = directory as unknown as Record<string, unknown>;
const MINUTE = 60_000;
/** The window this unit asks for, written here rather than read from the code under test. */
const WINDOW_MS = 15 * MINUTE;

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
  const Busy = exported.DirectoryBusyError as (new (...args: never[]) => Error) | undefined;
  if (Busy && error instanceof Busy) return "busy";
  if (error instanceof UnknownReplyError) return "UnknownReplyError";
  return `other: ${String(error)}`;
}

/** Each listed handle with its top share, sorted, or the outcome. */
async function attempt(): Promise<string[] | string> {
  try {
    return (await readDirectory()).map((row) => `${row.handle}:${row.topRate}`).sort();
  } catch (error) {
    return outcome(error);
  }
}

async function visit(): Promise<{ result: string[] | string; words: Record<string, number> }> {
  return counted(() => attempt()) as Promise<{ result: string[] | string; words: Record<string, number> }>;
}

async function kept(): Promise<unknown> {
  return (await original([["GET", DIRECTORY_CACHE]]))[0];
}

async function selling(email: string, handle: string, name: string): Promise<void> {
  await claimHandle(email, handle, name, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(11, "0").slice(0, 11)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true });
  const product = await addProduct(email, "Guide", "", "20", null);
  if (!product.ok) throw new Error("no product");
  await program(email, true);
}

async function program(email: string, listed: boolean, percent = 30, numbers = false): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent, days: 30, directory: listed, numbers }));
}

function dollars(microUsd: number): string {
  return `US$${(microUsd / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("cakes@example.com", "cakeshop", "Cake Shop");

  part("The window is 15 minutes, 4 builds an hour");
  is("DIRECTORY_BUILD_SECONDS is 900", exported.DIRECTORY_BUILD_SECONDS, 900);
  is("DIRECTORY_BUILDS_PER_HOUR is 4", exported.DIRECTORY_BUILDS_PER_HOUR, 4);

  part("A built page is kept the whole window: one GET a visit, no build");
  const first = await visit();
  is("the first visit builds the list, with one SSCAN", [first.result, first.words.SSCAN ?? 0], [["breadhouse:30", "cakeshop:30"], 1]);
  advance(WINDOW_MS - 1_000);
  const late = await visit();
  is("14 minutes 59 seconds later, the kept page is served with one GET and nothing else", [late.result, late.words], [["breadhouse:30", "cakeshop:30"], { GET: 1 }]);
  advance(1_000);
  const next = await visit();
  is("at 15 minutes, one build", [next.result, next.words.SSCAN ?? 0], [["breadhouse:30", "cakeshop:30"], 1]);

  part("A creator's change shows at the next build, within 15 minutes, never sooner than the window");
  advance(MINUTE);
  await program("baker@example.com", true, 45);
  is("the save drops the kept page", await kept(), null);
  let builds = 0;
  let stale = 0;
  for (let minute = 1; minute < 15; minute += 1) {
    const seen = await visit();
    builds += seen.words.SSCAN ?? 0;
    if (Array.isArray(seen.result) && seen.result.join() === "breadhouse:30,cakeshop:30") stale += 1;
    advance(MINUTE);
  }
  is("from minute 1 to minute 14 no visit builds", builds, 0);
  is("each is shown the last good page, with the share as it was built", stale, 14);
  const shown = await visit();
  is("at minute 15 one build shows the new share", [shown.result, shown.words.SSCAN ?? 0], [["breadhouse:45", "cakeshop:30"], 1]);

  part("A store taken out is gone at once, inside the window too");
  advance(5 * MINUTE);
  await program("cakes@example.com", false);
  const out = await visit();
  is("the next visit lists the other store only, with no build", [out.result, out.words.SSCAN ?? 0], [["breadhouse:45"], 0]);
  await program("cakes@example.com", true);
  is("a store that says yes again is shown again, from the last build", await attempt(), ["breadhouse:45", "cakeshop:30"]);

  part("An hour of saves every 10 seconds and a visit every second builds at most 4 times");
  advance(WINDOW_MS);
  let hourBuilds = 0;
  let unavailable = 0;
  for (let second = 0; second < 3_600; second += 1) {
    if (second % 10 === 0) await program("baker@example.com", true, 45);
    const seen = await visit();
    hourBuilds += seen.words.SSCAN ?? 0;
    if (!Array.isArray(seen.result)) unavailable += 1;
    advance(1_000);
  }
  is("3,600 visits and 360 saves, at most 4 builds", hourBuilds <= 4, true);
  is("and builds did happen, one each window", hourBuilds >= 4, true);
  is("no visit was told the list is unavailable", unavailable, 0);

  part("A build that keeps nothing leaves the last good page for the whole next window");
  advance(WINDOW_MS);
  is("a good build first", await attempt(), ["breadhouse:45", "cakeshop:30"]);
  advance(WINDOW_MS);
  await program("baker@example.com", true, 45, true);
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "HGETALL") throw new Error("synthetic network failure");
    return original(commands);
  }) as typeof redis.pipeline;
  const partial = await attempt();
  redis.pipeline = original;
  is("the build with a numbers read failed is shown and not kept", [partial, await kept()], [["breadhouse:45", "cakeshop:30"], null]);
  advance(WINDOW_MS - 1_000);
  const held = await visit();
  is("14 minutes 59 seconds later, the last good page is still shown, filtered, with no build", [held.result, held.words.SSCAN ?? 0], [["breadhouse:45", "cakeshop:30"], 0]);

  part("The registry prices 4 builds an hour from the repository's own rate");
  const line = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_BUILDS_PER_HOUR ?? "";
  const perMonth = 12_068 * 4 * 24 * 30;
  is("34,755,840 commands in 30 days", perMonth, 34_755_840);
  const cost = dollars((perMonth * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1_000_000);
  is("about US$69.51 at the repository's rate", cost, "US$69.51");
  is(
    "the line states 15 minutes, 4 builds, 48,272 an hour, 34,755,840 in 30 days and the dollars",
    [line.includes("DIRECTORY_BUILD_SECONDS = 900"), line.includes("4 builds an hour"), line.includes("48,272"), line.includes("34,755,840"), line.includes(cost)],
    [true, true, true, true, true],
  );
  is("and no longer the minute's figures", [line.includes("60 builds"), line.includes("724,080"), line.includes("1,042.68")], [false, false, false]);
  is("and says the rate was not confirmed on Upstash's own page", line.includes("not confirmed"), true);

  part("The help says a change can take up to 15 minutes, and leaving is at once");
  const help = HELP_SECTIONS.flatMap((section) => section.items.flatMap((item) => [item.q, item.a])).join("\n");
  is("the affiliate answer says so", help.includes("can take up to 15 minutes to show there"), true);
  is("and still says unchecking the box takes it off at once", help.includes("Uncheck it and save, and it leaves the page at once."), true);

  done();
}

main();
