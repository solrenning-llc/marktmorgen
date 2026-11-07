/**
 * One account cannot hold the public affiliate directory "unavailable" (Claude 6 on #3062, MÉDIO 1).
 * Synthetic only: the in-memory Redis stub and a stubbed fetch, every command counted by its first word.
 *
 * Before: every affiliate-settings save dropped the kept page (nl:dir:page), even a save from a store that is not
 * listed, and POST /api/store/affiliates has no per-store pace. With the build ceiling (nl:dir:build, SET NX EX 60),
 * every miss while the claim was held was DirectoryBusyError, so one account saving every few seconds kept the page
 * "unavailable" (and noindex) for almost every visitor, with no end: 50 of 600 visits saw the list.
 *
 * Now:
 *   - a save drops the kept page only when the store would be listed after it or was in the listed set before it,
 *     read from the SREM reply (lib/directory-index.ts, rememberListing): a store that is not listed and stays so
 *     changes nothing the directory shows;
 *   - each full build also keeps the last good page with the sid of each row (nl:dir:last). A visit that misses the
 *     kept page while the claim is held is shown that last page, filtered by one SMISMEMBER of its sids against the
 *     listed set, so a store whose creator has just taken it out is gone at once. Nothing is kept from it. Only with
 *     no last page is the visit told the list is unavailable.
 *   - the SMISMEMBER reply is read exactly (rule 24): a list of 0 and 1, one for each sid; anything else is unknown.
 */
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import * as index from "@/lib/directory-index";
import { DIRECTORY_BUILD_SECONDS, DirectoryBusyError, readDirectory } from "@/lib/affiliate-directory";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { NOT_A_COST } from "./plan-cost-registry";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const WINDOW_MS = DIRECTORY_BUILD_SECONDS * 1000;
const LAST = ((index as unknown as Record<string, unknown>).DIRECTORY_LAST as string | undefined) ?? "nl:dir:last";

async function counted<T>(run: () => Promise<T>): Promise<{ result: T | string; words: Record<string, number> }> {
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

function outcome(error: unknown): string {
  if (error instanceof DirectoryBusyError) return "busy";
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

/** The handles in a stable order, or the outcome as it is. */
function sorted(answer: string[] | string): string[] | string {
  return Array.isArray(answer) ? [...answer].sort() : answer;
}

async function kept(key = DIRECTORY_CACHE): Promise<unknown> {
  return (await original([["GET", key]]))[0];
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

async function listed(email: string, directory: boolean, percent = 30): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent, days: 30, directory }));
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  // The account in the loop: any account, not listed, saving its program again and again.
  const LOOP = "loop@example.com";
  await claimHandle(LOOP, "loophole", "Loop Hole", "");
  await setAffiliateSetting(LOOP, parseAffiliateSetting({ enabled: false, percent: 10, days: 30, directory: false }));

  part("A save from a store that is not listed does not drop the kept page");
  is("the first visit builds the list", await attempt(), ["breadhouse"]);
  const unlisted = await counted(() => setAffiliateSetting(LOOP, parseAffiliateSetting({ enabled: false, percent: 12, days: 30, directory: false })));
  is("the save sends no DEL of the kept page", unlisted.words.DEL ?? 0, 0);
  is("and the kept page is still there", typeof (await kept()), "string");
  const served = await counted(() => attempt());
  is("so the next visit is the list, with one GET", [served.result, served.words], [["breadhouse"], { GET: 1 }]);

  part("One account saving every 5 s for 10 minutes, one visit a second: every visit sees the list");
  advance(WINDOW_MS);
  let shown = 0;
  let builds = 0;
  for (let second = 0; second < 600; second += 1) {
    if (second % 5 === 0) {
      // Saved as the studio does; also a save that drops the page, as a store listed would, every 5 s.
      await setAffiliateSetting(LOOP, parseAffiliateSetting({ enabled: false, percent: 10 + (second % 7), days: 30, directory: false }));
      await original([["DEL", DIRECTORY_CACHE]]);
    }
    const visit = await counted(() => attempt());
    builds += visit.words.SSCAN ?? 0;
    if (Array.isArray(visit.result) && visit.result.join() === "breadhouse") shown += 1;
    advance(1000);
  }
  is("600 of 600 visits see the unchanged list, none told unavailable", shown, 600);
  is("and the builds stay at most one a window", builds <= Math.ceil(600 / DIRECTORY_BUILD_SECONDS), true);

  part("A store taken out while the claim is held is gone at once");
  advance(WINDOW_MS);
  await original([["DEL", DIRECTORY_CACHE]]);
  await selling("cakes@example.com", "cakeshop", "Cake Shop");
  is("both are listed after a build", sorted(await attempt()), ["breadhouse", "cakeshop"]);
  await listed("cakes@example.com", false);
  const after = await counted(() => attempt());
  is("the next visit, inside the window, lists the other store only", after.result, ["breadhouse"]);
  is("with one SMISMEMBER and no SSCAN", [after.words.SMISMEMBER ?? 0, after.words.SSCAN ?? 0], [1, 0]);
  is("and keeps nothing from the last page", await kept(), null);
  await listed("cakes@example.com", true);
  is("a store whose creator says yes again is shown again", sorted(await attempt()), ["breadhouse", "cakeshop"]);
  advance(WINDOW_MS);
  is("and after the next build too", sorted(await attempt()), ["breadhouse", "cakeshop"]);

  part("With no last page, the visit is told unavailable, never an empty list");
  await original([["DEL", DIRECTORY_CACHE], ["DEL", LAST]]);
  is("busy", await attempt(), "busy");

  part("The listed-set check is read exactly (rule 24)");
  for (const [label, reply] of [
    ["missing", undefined],
    ["null", null],
    ["a number", 1],
    ["a shorter list", [1]],
    ["a longer list", [1, 1, 1]],
    ["a string flag", ["1", "1"]],
    ["a flag of 2", [1, 2]],
    ["QUEUED", "QUEUED"],
  ] as const) {
    advance(WINDOW_MS);
    await original([["DEL", DIRECTORY_CACHE]]);
    is(`a build before the check, ${label}`, sorted(await attempt()), ["breadhouse", "cakeshop"]);
    await original([["DEL", DIRECTORY_CACHE]]);
    redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SMISMEMBER" ? [reply] : original(commands))) as typeof redis.pipeline;
    const answer = await attempt();
    redis.pipeline = original;
    is(`an SMISMEMBER answering ${label} is unknown, never the list unfiltered or empty`, answer, "UnknownReplyError");
  }
  is("and a healthy check answers the list", sorted(await attempt()), ["breadhouse", "cakeshop"]);

  part("The last page's own read is exact");
  for (const [label, reply] of [["a number", 5], ["a list", []], ["text that is not the page", "{oops"], ["a page whose sids do not match its rows", JSON.stringify({ sids: ["x"], rows: [] })]] as const) {
    await original([["DEL", DIRECTORY_CACHE]]);
    let checks = 0;
    redis.pipeline = (async (commands: Commands) => {
      if (commands[0]?.[0] === "SMISMEMBER") checks += 1;
      return commands[0]?.[0] === "GET" && commands[0]?.[1] === LAST ? [reply] : original(commands);
    }) as typeof redis.pipeline;
    const answer = await attempt();
    redis.pipeline = original;
    is(`a last page answering ${label} is unknown, and nothing is filtered from it`, [answer, checks], ["UnknownReplyError", 0]);
  }

  part("The registry counts the last page");
  const line = (NOT_A_COST as Record<string, string | undefined>).DIRECTORY_BUILDS_PER_HOUR ?? "";
  is("one build sends at most 12,070 commands, 4 builds an hour, 48,280 an hour", [line.includes("12,070"), line.includes("4 builds an hour"), line.includes("48,280")], [true, true, true]);
  is("and a visit while the claim is held reads the last page and the listed set", [line.includes("nl:dir:last"), line.includes("SMISMEMBER")], [true, true]);

  done();
}

main();
