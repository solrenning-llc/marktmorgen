/**
 * Claude 5's MEDIUM on #3062 (6908741782) and on #3118 (6909363676), consent: a creator who unchecks "Show my
 * program's numbers there too" must not have them shown again. Two paths showed them:
 *   1. past the window's ceiling, a visit is shown the last good build (nl:dir:last), filtered only by the listed set,
 *      so the row still carried the numbers the build read before the creator took them back;
 *   2. a build that read the numbers before the save and kept its page after the save's DEL kept them for the page's
 *      whole life.
 * Now the stores showing their numbers are a set of their own (nl:dir:numbers), kept only by the save
 * (rememberListing), never by a build: the last good build and a page just kept are checked against it, and a row
 * whose store is not in it is shown with no numbers (null, never $0). Synthetic only: the in-memory Redis stub.
 */
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import * as directory from "@/lib/affiliate-directory";
import { readDirectory } from "@/lib/affiliate-directory";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;

const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const CEILING = ((directory as unknown as Record<string, unknown>).DIRECTORY_BUILDS_PER_TEN_MINUTES as number | undefined) ?? 10;

async function program(email: string, numbers: boolean, percent = 30): Promise<void> {
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent, days: 30, directory: true, numbers }));
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

/** Which handles carry numbers on the page now, sorted. */
async function withNumbers(): Promise<string[]> {
  return (await readDirectory()).filter((row) => row.numbers !== null).map((row) => row.handle).sort();
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House");
  await selling("cakes@example.com", "cakeshop", "Cake Shop");

  part("Control: both creators show their numbers");
  is("a build shows both with their numbers", await withNumbers(), ["breadhouse", "cakeshop"]);

  part("Past the window's ceiling, numbers taken back are not shown from the last good build");
  for (let n = 1; n < CEILING; n += 1) {
    await program("cakes@example.com", true, 30 + (n % 3));
    await readDirectory();
  }
  await program("baker@example.com", false);
  is("the next visit, not built, shows the baker without numbers and the cake shop with them", await withNumbers(), ["cakeshop"]);
  advance(5 * 60_000);
  is("five minutes on, still without them", await withNumbers(), ["cakeshop"]);

  part("A build that read the numbers before the save keeps no page with them");
  advance(20 * 60_000);
  await program("baker@example.com", true);
  await original([["DEL", DIRECTORY_CACHE]]);
  let withdrawn = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!withdrawn && commands.some((c) => c[0] === "SET" && c[1] === DIRECTORY_CACHE)) {
      withdrawn = true;
      redis.pipeline = original;
      // The save lands while the build is writing: after it read the baker's numbers, before its page is kept.
      await program("baker@example.com", false);
    }
    return original(commands);
  }) as typeof redis.pipeline;
  let during: string[] = [];
  try {
    during = await withNumbers();
  } finally {
    redis.pipeline = original;
  }
  is("the save landed during the build", withdrawn, true);
  is("the build's own answer shows the baker without numbers", during, ["cakeshop"]);
  is("and the next visit too: no page kept with them", await withNumbers(), ["cakeshop"]);

  part("Taken back and given again: shown again at the next build");
  advance(20 * 60_000);
  await program("baker@example.com", true);
  is("both with their numbers", await withNumbers(), ["breadhouse", "cakeshop"]);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
