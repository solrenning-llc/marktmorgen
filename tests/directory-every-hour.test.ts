/**
 * The public affiliate directory is built at most once an hour, site-wide (owner's decision through the coordinator,
 * C1-20261109-1603-TODOS-71, on #3118: "US$ 69,51/mês é custo fixo da empresa e não aprovo. Use 1 montagem por hora
 * (DIRECTORY_BUILD_SECONDS = 3600) ... Loja retirada continua saindo na hora. Listagem nova pode levar até 1 hora, e a
 * tela não deve prometer menos."). Synthetic only: the in-memory Redis stub and a stubbed fetch, every command counted
 * by its first word.
 *
 * Before: #3062 counted builds in a window of ten minutes, at most 10 in it (nl:dir:builds), so up to 43,200 builds
 * in 30 days, about US$1,043 of Redis commands, a fixed company cost whatever the number of visitors.
 *
 * Now: the window is DIRECTORY_BUILD_SECONDS (3,600) with one build in it, and the kept page lasts as long. Inside the
 * window a save that drops the kept page does not build again: the visit is shown the last good build without every
 * store no longer in the listed set, so a store taken out leaves at once, and a new listing shows at the next build,
 * within the hour. The help and the studio say "up to an hour", never less.
 */
import { readFileSync } from "node:fs";
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
/** The window the owner asked for, written here rather than read from the code under test. */
const HOUR_MS = 60 * MINUTE;

function outcome(error: unknown): string {
  const Busy = exported.DirectoryBusyError as (new (...args: never[]) => Error) | undefined;
  if (Busy && error instanceof Busy) return "busy";
  if (error instanceof UnknownReplyError) return "UnknownReplyError";
  return `other: ${String(error)}`;
}

async function attempt(): Promise<string[] | string> {
  try {
    return (await readDirectory()).map((row) => row.handle).sort();
  } catch (error) {
    return outcome(error);
  }
}

async function counted<T>(run: () => Promise<T>): Promise<{ result: T; words: Record<string, number> }> {
  const words: Record<string, number> = {};
  redis.pipeline = (async (commands: Commands) => {
    for (const command of commands) words[String(command[0])] = (words[String(command[0])] ?? 0) + 1;
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return { result: await run(), words };
  } finally {
    redis.pipeline = original;
  }
}

const total = (words: Record<string, number>) => Object.values(words).reduce((sum, n) => sum + n, 0);

async function listed(email: string, yes: boolean, percent = 30): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent, days: 30, directory: yes, numbers: true }));
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

/** The directory's sentences a creator reads: the help section and the studio's checkbox. */
function screens(): { help: string; studio: string; page: string } {
  const help = JSON.stringify(HELP_SECTIONS).match(/To be found by people looking for something to promote[^"]*/)?.[0] ?? "";
  const studioFile = readFileSync("components/affiliate-studio.tsx", "utf8");
  const at = studioFile.indexOf("List my program in the affiliate directory");
  const studio = at < 0 ? "" : studioFile.slice(at, studioFile.indexOf("</label>", at)).replace(/\s+/g, " ");
  const page = readFileSync("app/affiliate-programs/page.tsx", "utf8");
  return { help, studio, page };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();

  part("The window is named and is the owner's hour, with one build in it");
  is("DIRECTORY_BUILD_SECONDS is exported, 3,600", exported.DIRECTORY_BUILD_SECONDS, 3_600);
  is("DIRECTORY_BUILDS_PER_HOUR is exported, 1", exported.DIRECTORY_BUILDS_PER_HOUR, 1);
  is("the ten-minute ceiling is gone", "DIRECTORY_BUILDS_PER_TEN_MINUTES" in exported, false);

  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("cakes@example.com", "cakeshop", "Cake Shop");

  part("What one build sends, measured here, gives the cost line");
  const one = await counted(() => attempt());
  is("the first visit builds", [one.result, one.words.SSCAN], [["breadhouse", "cakeshop"], 1]);
  const pageLeft = Number((await original([["TTL", DIRECTORY_CACHE]]))[0]);
  is("the kept page lasts the hour", pageLeft > 3_000 && pageLeft <= 3_600, true);
  // Each listed store showing its numbers costs 2 GET (storeForId) + 4 HGETALL (programNumbers).
  const perStore = 6;
  const fixed = total(one.words) - one.words.SSCAN - 2 * perStore;
  // The worst build: its fixed commands, 1 DEL of the kept page when a store left while it ran, 64 SSCAN pages and
  // 2,000 stores (lib/affiliate-directory.ts, DIRECTORY_SCAN_PAGES and MAX_ROWS).
  const worst = fixed + 1 + 64 + perStore * 2_000;
  const builds30 = (30 * 24 * 3_600) / 3_600;
  const commands30 = worst * builds30;
  const dollars = (commands30 * UPSTASH_MICRO_USD_PER_MILLION_COMMANDS) / 1e6 / 1e6;
  const line = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_BUILDS_PER_HOUR ?? "";
  const n = (value: number) => value.toLocaleString("en-US");
  is("the registry prices the hourly builds by name", line.length > 0, true);
  is("with the worst build, the builds in 30 days, the commands and the dollars, as measured", [n(worst), n(builds30), n(commands30), `US$${dollars.toFixed(2)}`].map((figure) => line.includes(figure)), [true, true, true, true]);
  is("the ten-minute line is gone from the registry", "DIRECTORY_BUILDS_PER_TEN_MINUTES" in NOT_A_COST, false);

  part("A save every 30 seconds for three hours: one build an hour, and every visit sees the list");
  advance(HOUR_MS);
  const perHour = [0, 0, 0];
  let shown = 0;
  for (let step = 0; step < 360; step += 1) {
    await listed("baker@example.com", true, 30 + (step % 5));
    const visit = await counted(() => attempt());
    perHour[Math.floor(step / 120)] += visit.words.SSCAN ?? 0;
    if (Array.isArray(visit.result) && visit.result.join() === "breadhouse,cakeshop") shown += 1;
    advance(30_000);
  }
  is("360 saves and 360 visits build 3 times: 1 in each hour", perHour, [1, 1, 1]);
  is("and every one of the 360 visits is shown the list", shown, 360);

  part("A store taken out leaves at once, inside the hour, with nothing built");
  advance(HOUR_MS);
  is("the hour's build", (await counted(() => attempt())).words.SSCAN, 1);
  advance(5 * MINUTE);
  await listed("cakes@example.com", false);
  const gone = await counted(() => attempt());
  is("the next visit does not show it", gone.result, ["breadhouse"]);
  is("and built nothing to say so", gone.words.SSCAN ?? 0, 0);
  advance(50 * MINUTE);
  is("50 minutes later it is still not shown", await attempt(), ["breadhouse"]);

  part("A new listing shows at the next build, within the hour, and not promised sooner");
  advance(10 * MINUTE);
  is("the next hour's build", (await counted(() => attempt())).words.SSCAN, 1);
  await selling("yoga@example.com", "yogaroom", "Yoga Room");
  advance(30 * MINUTE);
  is("30 minutes after listing, the hour's build is still what is shown", await attempt(), ["breadhouse"]);
  advance(30 * MINUTE + 1_000);
  is("an hour after the build, the new listing is shown", await attempt(), ["breadhouse", "yogaroom"]);

  part("The screens say up to an hour, and never promise less");
  const { help, studio, page } = screens();
  is("the help says a new listing can take up to an hour", /up to an hour/.test(help), true);
  is("the studio's checkbox says it too", /up to an hour/.test(studio), true);
  const minutes = (text: string) => [...text.matchAll(/(\d+|ten|fifteen|five|thirty)\s+minutes?/gi)].map((m) => m[0]);
  is("no directory sentence promises minutes", [minutes(help), minutes(studio), minutes(page)], [[], [], []]);
  is("and taking a store out still says at once", [/leaves the page at once/.test(help), /leaves the page at once/.test(studio)], [true, true]);

  done();
}

main();
