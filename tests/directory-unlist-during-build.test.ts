/**
 * Claude 6's money review of #3118 (MÉDIO): a creator who unchecks "List my program" while a build is running leaves
 * the page at once, as the help says. Before, the build read the store before the save; the save's SREM and DEL of
 * the kept page landed next; then the build's SET wrote the store back, and the kept page (served with one GET and no
 * SMISMEMBER) showed it for the whole window, up to an hour (C1-20261109-1603-TODOS-71). Now the build, right after its SETs, asks the listed
 * set once (SMISMEMBER) for the sids it kept: a 0 drops the kept page, and so does a reply in any other shape (then
 * the build is unknown and says so). Against the save's SREM-then-DEL this is linearizable. Synthetic data only.
 */
import { readDirectory } from "@/lib/affiliate-directory";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import { UnknownReplyError } from "@/lib/redis-reply";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const MINUTE = 60_000;
/** The owner's build window, written here rather than read from the code under test. */
const HOUR = 60 * MINUTE;

async function attempt(): Promise<string[] | string> {
  try {
    return (await readDirectory()).map((row) => row.handle).sort();
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}
const kept = async () => (await original([["GET", DIRECTORY_CACHE]]))[0];
const keptHandles = async () => {
  const raw = await kept();
  return typeof raw === "string" ? (JSON.parse(raw) as { handle: string }[]).map((row) => row.handle).sort() : null;
};

async function program(email: string, listed: boolean): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory: listed, numbers: false }));
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

/** Runs a build in which `before` runs just before the build keeps its page (its SET, or the script that holds it). */
async function buildWith(before: () => Promise<void>): Promise<string[] | string> {
  let armed = true;
  redis.pipeline = (async (commands: Commands) => {
    // The page is kept by the build's own script (PUBLISH_IF_OWNER, Codex N1 on #2921), the cache key among its keys.
    if (armed && ((commands[0]?.[0] === "SET" && commands[0]?.[1] === DIRECTORY_CACHE) || (commands[0]?.[0] === "EVAL" && commands[0].slice(3).includes(DIRECTORY_CACHE)))) {
      armed = false;
      await before();
    }
    return original(commands);
  }) as typeof redis.pipeline;
  try {
    return await attempt();
  } finally {
    redis.pipeline = original;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("cakes@example.com", "cakeshop", "Cake Shop");

  part("Unlisted while a build runs: gone at once, never for the window");
  const built = await buildWith(() => program("cakes@example.com", false));
  is("the build's own answer leaves the unlisted store out", built, ["breadhouse"]);
  is("the kept page does not hold the unlisted store", ((await keptHandles()) ?? []).includes("cakeshop"), false);
  for (const [step, at] of [[1, 1], [29, 30], [29, 59]]) {
    advance(step * MINUTE);
    is(`a visit at minute ${at} after the build does not show it`, ((await attempt()) as string[]).includes("cakeshop"), false);
  }

  part("The listed set answered in another shape right after the build: the kept page is dropped, the build unknown");
  advance(HOUR);
  await program("cakes@example.com", true);
  redis.pipeline = (async (commands: Commands) => (commands[0]?.[0] === "SMISMEMBER" ? [["x", 1]] : original(commands))) as typeof redis.pipeline;
  const unknown = await attempt();
  redis.pipeline = original;
  is("the build says it is unknown", unknown, "UnknownReplyError");
  is("and keeps no page from it", await kept(), null);

  part("Unlisted while a lone DEL of the kept page fails: still gone at once (Claude 6's MÉDIO 1 on #3118)");
  // The save took the store out of the set and then sent the DEL of the kept page in a request of its own: when that
  // request failed, the save still succeeded and the kept page showed the store for its whole hour.
  advance(HOUR);
  await program("cakes@example.com", true);
  is("control: both are listed and kept", [await attempt(), await keptHandles()], [["breadhouse", "cakeshop"], ["breadhouse", "cakeshop"]]);
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0]?.[0] === "DEL" && commands[0]?.[1] === DIRECTORY_CACHE) throw new Error("synthetic network failure");
    return original(commands);
  }) as typeof redis.pipeline;
  await program("cakes@example.com", false);
  redis.pipeline = original;
  for (const [step, at] of [[1, 1], [29, 30], [28, 58]]) {
    advance(step * MINUTE);
    is(`a visit at minute ${at} after unlisting does not show it`, ((await attempt()) as string[]).includes("cakeshop"), false);
  }

  part("After a build, the DEL of the kept page is read exactly (Codex X6 on #3118)");
  for (const [label, reply] of [["null", null], ["QUEUED", "QUEUED"], ["a string", "1"], ["missing", undefined]] as const) {
    advance(HOUR);
    await program("cakes@example.com", true);
    let armed = true;
    let saved = false;
    let swapped = false;
    redis.pipeline = (async (commands: Commands) => {
      if (armed && ((commands[0]?.[0] === "SET" && commands[0]?.[1] === DIRECTORY_CACHE) || (commands[0]?.[0] === "EVAL" && commands[0].slice(3).includes(DIRECTORY_CACHE)))) {
        armed = false;
        await program("cakes@example.com", false);
        saved = true;
      }
      // Only the build's own DEL after its check, never the save's.
      if (saved && !swapped && commands.length === 1 && commands[0]?.[0] === "DEL" && commands[0]?.[1] === DIRECTORY_CACHE) {
        swapped = true;
        return reply === undefined ? [] : [reply];
      }
      return original(commands);
    }) as typeof redis.pipeline;
    const answer = await attempt();
    redis.pipeline = original;
    is(`a DEL of the kept page answering ${label} after a build: the build says it is unknown`, [swapped, answer], [true, "UnknownReplyError"]);
  }
  await program("cakes@example.com", true);

  part("Control: a build with nobody leaving keeps the page with both");
  advance(HOUR);
  is("both are listed", await attempt(), ["breadhouse", "cakeshop"]);
  is("and kept", await keptHandles(), ["breadhouse", "cakeshop"]);
  done();
}

main();
