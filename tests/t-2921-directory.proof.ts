/** Independent, synthetic consumer proof for PR #2921; no product edits. */
import assert from "node:assert/strict";
import { DIRECTORY_CACHE } from "@/lib/directory-index";
import { directoryRow, readDirectory } from "@/lib/affiliate-directory";
import { INDEX_DIRECTORY_AT } from "@/lib/directory-index";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
const results: { name: string; ok: boolean; actual?: unknown }[] = [];
let externalHttpAttempts = 0;
globalThis.fetch = (async () => {
  externalHttpAttempts += 1;
  throw new Error("external HTTP is forbidden in this proof");
}) as typeof fetch;

async function seed(): Promise<string> {
  redis.pipeline = original;
  redis.clear();
  const email = "directory-proof@example.test";
  const handle = "directoryproof";
  await claimHandle(email, handle, "Synthetic Directory Proof", "");
  await ensureStatsId(email);
  await setStripeAccount(email, "acct_fixtureT01", true);
  await setSubscription(email, { customerId: "cus_directoryproof", subscriptionId: "sub_directoryproof", active: true });
  const product = await addProduct(email, "Synthetic guide", "", "20", null);
  assert.equal(product.ok, true);
  await setAffiliateSetting(email, parseAffiliateSetting({ enabled: true, percent: 30, days: 30, directory: true, numbers: false }));
  const store = await storeForEmail(email);
  assert.ok(store?.sid);
  assert.ok(directoryRow(store), "the synthetic fixture must really qualify for this directory");
  return store.sid;
}

async function kept(): Promise<unknown> {
  return (await original([["GET", DIRECTORY_CACHE]]))[0];
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";

  // Five cases, at most 5,000 synthetic commands, no provider requests. The
  // runner installs the command ceiling before these fixtures can write.
  let sid = await seed();
  let scans = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SSCAN") return ++scans === 1 ? [["7", []]] : [["0", [sid]]];
    return original(commands);
  }) as typeof redis.pipeline;
  const sparse = await readDirectory();
  results.push({ name: "a valid sparse nonterminal page does not erase the later program", ok: sparse.length === 1 && scans === 2, actual: { rows: sparse.length, scans } });

  sid = await seed();
  scans = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SSCAN") return ++scans === 1 ? [["7", [sid]]] : [["0", [sid]]];
    return original(commands);
  }) as typeof redis.pipeline;
  const duplicated = await readDirectory();
  const duplicatedCache = JSON.parse(String(await kept())) as unknown[];
  results.push({ name: "SSCAN returning the same program on two pages does not duplicate the cached directory", ok: duplicated.length === 1 && duplicatedCache.length === 1, actual: { rows: duplicated.length, cachedRows: duplicatedCache.length, indexThreshold: INDEX_DIRECTORY_AT } });

  sid = await seed();
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "GET" && commands[0]?.[1] === `nl:store:id:${sid}`) return [];
    return original(commands);
  }) as typeof redis.pipeline;
  let unknownFailed = false;
  let unknownRows: unknown;
  try { unknownRows = await readDirectory(); } catch { unknownFailed = true; }
  results.push({ name: "an unconfirmed store-id mapping does not become a cached empty directory", ok: unknownFailed && await kept() === null, actual: { threw: unknownFailed, rows: unknownRows, cache: await kept() } });

  await seed();
  scans = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SSCAN") return ++scans === 1 ? [["not-a-redis-cursor", []]] : [["0", []]];
    return original(commands);
  }) as typeof redis.pipeline;
  let malformedFailed = false;
  try { await readDirectory(); } catch { malformedFailed = true; }
  results.push({ name: "a malformed cursor is unknown rather than evidence for a cached empty directory", ok: malformedFailed && await kept() === null, actual: { threw: malformedFailed, scans, cache: await kept() } });

  sid = await seed();
  await original([["DEL", `nl:store:id:${sid}`]]);
  const absent = await readDirectory();
  results.push({ name: "a confirmed null mapping still omits a stale listing", ok: absent.length === 0 && await kept() === "[]", actual: { rows: absent.length, cache: await kept() } });

  redis.pipeline = original;
  assert.equal(results.length, 5);
  assert.equal(externalHttpAttempts, 0);
  console.log(JSON.stringify({ cases: results.length, passed: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, externalHttpAttempts, results }, null, 2));
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

void main().catch((error: unknown) => {
  redis.pipeline = original;
  console.error(error);
  process.exitCode = 1;
});
