/**
 * Second independent money review of #2921 (CX-116), synthetic only, never committed.
 *
 * P1: a failed build is no longer kept, and nothing else throttles a rebuild, so a persistent failure in one listed
 *     store makes every visitor's request run the whole build again (twice: generateMetadata and the page).
 * P2: a build that read a store before the creator withdrew it writes the page after the withdrawal's DEL,
 *     so the withdrawn program (or its numbers) is shown up to ten minutes ("Uncheck it and it leaves the page at once").
 * P3 (rule 30, outside the PR): forEachContact reads an unknown HSCAN page as the end of the walk.
 */
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import { readDirectory } from "@/lib/affiliate-directory";
import { forEachContact } from "@/lib/contacts";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 })) as typeof fetch;
const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];

async function selling(email: string, handle: string, name: string, numbers = false, directory = true): Promise<void> {
  await claimHandle(email, handle, name, "");
  await ensureStatsId(email);
  await setStripeAccount(email, `acct_1Test${handle.padEnd(11, "0").slice(0, 11)}`, true);
  await setSubscription(email, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true });
  const product = await addProduct(email, "Guide", "", "20", null);
  if (!product.ok) throw new Error("no product");
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory, numbers }));
}

/** Counts every command by its first word, under `fail` (which may throw for a command). */
function counting(fail: (commands: Commands) => void): Record<string, number> {
  const seen: Record<string, number> = {};
  redis.pipeline = (async (commands: Commands) => {
    for (const c of commands) seen[String(c[0])] = (seen[String(c[0])] ?? 0) + 1;
    fail(commands);
    return original(commands);
  }) as typeof redis.pipeline;
  return seen;
}

/** One visit to app/affiliate-programs: generateMetadata and the page each call readDirectory().catch(() => null). */
async function visit(): Promise<void> {
  await readDirectory().catch(() => null);
  await readDirectory().catch(() => null);
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";

  part("P1a: one listed store's numbers read fails every time (e.g. WRONGTYPE, or a hash too large to answer in 5 s)");
  redis.clear();
  for (let i = 0; i < 20; i += 1) await selling(`c${i}@example.com`, `shop${String(i).padStart(2, "0")}`, `Shop ${i}`, true);
  // The first store's people hash, found by one healthy build's first HGETALL.
  let firstPeople = "";
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "HGETALL" && !firstPeople) firstPeople = String(commands[0][1]);
    return original(commands);
  }) as typeof redis.pipeline;
  await readDirectory();
  await original([["DEL", DIRECTORY_CACHE]]);
  let seen = counting((commands) => {
    if (commands.length === 4 && commands[0]?.[0] === "HGETALL" && String(commands[0][1]) === firstPeople) throw new Error("Redis error: synthetic persistent failure");
  });
  for (let v = 0; v < 5; v += 1) await visit();
  redis.pipeline = original;
  console.log(`  P1a, 5 visits: ${JSON.stringify(seen)}`);
  is("5 visits inside ten minutes walk the listed set once, not on every call", (seen.SSCAN ?? 0) <= 1, true);
  is("and read the 20 stores once, not 10 times", (seen.HGETALL ?? 0) <= 20 * 4, true);

  part("P1b: one listed store's record read fails every time");
  await original([["DEL", DIRECTORY_CACHE]]);
  let victim = "";
  seen = counting((commands) => {
    const [word, key] = commands[0] ?? [];
    if (word === "GET" && String(key).startsWith("nl:store:id:")) {
      if (!victim) victim = String(key);
      if (String(key) === victim) throw new Error("Redis error: synthetic persistent failure");
    }
  });
  for (let v = 0; v < 5; v += 1) await visit();
  redis.pipeline = original;
  console.log(`  P1b, 5 visits: ${JSON.stringify(seen)}`);
  is("5 visits inside ten minutes walk the listed set once, not on every call", (seen.SSCAN ?? 0) <= 1, true);

  part("P2: the creator withdraws while a build is between its reads and its SET");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House", true);
  await selling("yoga@example.com", "yogaroom", "Yoga Room", true);
  let withdrawn = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!withdrawn && commands[0]?.[0] === "SET" && commands[0][1] === DIRECTORY_CACHE) {
      withdrawn = true;
      redis.pipeline = original;
      // The creator unchecks "List my program in the affiliate directory" and saves: SREM + DEL nl:dir:page.
      await setAffiliateSetting("baker@example.com", parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory: false, numbers: false }));
    }
    return original(commands);
  }) as typeof redis.pipeline;
  await readDirectory();
  redis.pipeline = original;
  const next = (await readDirectory()).map((row) => row.handle);
  console.log(`  P2, next visitor sees: ${JSON.stringify(next)}`);
  is("the next visitor no longer sees the withdrawn program", next.includes("breadhouse"), false);

  part("P2b: the creator hides the numbers while a build is between its reads and its SET");
  redis.clear();
  await selling("baker@example.com", "breadhouse", "Bread House", true);
  withdrawn = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!withdrawn && commands[0]?.[0] === "SET" && commands[0][1] === DIRECTORY_CACHE) {
      withdrawn = true;
      redis.pipeline = original;
      await setAffiliateSetting("baker@example.com", parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory: true, numbers: false }));
    }
    return original(commands);
  }) as typeof redis.pipeline;
  await readDirectory();
  redis.pipeline = original;
  const shown = (await readDirectory()).find((row) => row.handle === "breadhouse")?.numbers ?? null;
  is("the next visitor no longer sees the numbers the creator hid", shown, null);

  part("P3 (rule 30, lib/contacts.ts forEachContact, outside the PR): an unknown HSCAN page is not the end of the list");
  redis.clear();
  let scans = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "HSCAN") {
      scans += 1;
      return scans === 1 ? [["5", ["a@example.com", JSON.stringify({ agreed: true, at: 1, ids: [], tags: [] })]]] : [null];
    }
    return original(commands);
  }) as typeof redis.pipeline;
  let outcome = "answered";
  const visited: string[] = [];
  try {
    await forEachContact("list_proof", (email) => void visited.push(email));
  } catch {
    outcome = "threw";
  }
  redis.pipeline = original;
  console.log(`  P3: ${outcome} after ${scans} HSCAN, visited ${visited.length}`);
  is("a walk whose second page is unknown does not answer as finished", outcome, "threw");

  done();
}

void main();
