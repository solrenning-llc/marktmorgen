/**
 * Codex L's directory report (L-20261120-1133, MEDIUM): a directory build that read a creator's consent before the
 * creator withdrew it (unchecked "List my program", took the numbers back, or the store's listing was forgotten)
 * must never keep or show the withdrawn store. The build is paused just before it keeps its page, the withdrawal
 * lands, and the build goes on. Its own answer, the kept page and the next visit are checked. Adapted from the
 * report's proposed test, without its candidate design (a build that rejects, a revision marker): it fails on main,
 * on #2921 and, for the listing and the forgetting, on #3062; it passes once #3118's listedAfterBuild checks the
 * listed set after the build. Real directory builder, index and creator save; synthetic Redis, stores and Stripe.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readDirectory } from "@/lib/affiliate-directory";
import { DIRECTORY_CACHE, forgetListing } from "@/lib/directory-index";
import { parseAffiliateSetting } from "@/lib/affiliate-setting";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);
const OWNER = "directory-consent@example.test";
const setting = (directory: boolean, numbers = false) => parseAffiliateSetting({ enabled: true, percent: 25, directory, numbers });
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
async function world(numbers = false) {
  redis.clear();
  assert.equal((await claimHandle(OWNER, "dir-consent", "Synthetic Person", "")).ok, true);
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestDirect01", true);
  await setSubscription(OWNER, { customerId: "cus_DirectoryFixture", subscriptionId: "sub_DirectoryFixture", active: true, period: paidPeriod() });
  assert.equal((await addProduct(OWNER, "Synthetic private product name", "", "20", null)).ok, true);
  assert.equal((await setAffiliateSetting(OWNER, setting(true, numbers))).ok, true);
  const shop = await storeForEmail(OWNER); assert.ok(shop);
  return shop;
}
test("an old directory build never keeps or shows withdrawn publication consent (Codex L-20261120-1133)", { timeout: 20000 }, async (t) => {
  const priorFetch = globalThis.fetch, priorSecret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_directory_only_a_stand_in";
  globalThis.fetch = async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  const keeps = (commands: Commands) => commands.some((c) => (c[0] === "SET" && c[1] === DIRECTORY_CACHE) || (c[0] === "EVAL" && c.slice(3).includes(DIRECTORY_CACHE)));
  try {
    for (const mode of ["withdraw", "numbers", "forget"] as const) {
      await t.test(mode, async () => {
        const shop = await world(mode === "numbers"), started = gate(), release = gate();
        let paused = false;
        redis.pipeline = async (commands: Commands) => {
          if (!paused && keeps(commands)) { paused = true; started.open(); await release.wait; }
          return real(commands);
        };
        const running = readDirectory().catch((error: unknown) => ({ thrown: String(error) }));
        try {
          await started.wait;
          if (mode === "forget") await forgetListing(shop.sid);
          else assert.equal((await setAffiliateSetting(OWNER, setting(mode === "numbers", false))).ok, true);
          release.open();
          const old = await running;
          const shown = Array.isArray(old) ? old : [];
          if (mode === "numbers") assert.ok(shown.every((row) => row.numbers === null), "the old build's own answer shows no withdrawn numbers");
          else assert.equal(shown.length, 0, "the old build's own answer shows no withdrawn store");
          assert.equal((await real([["GET", DIRECTORY_CACHE]]))[0], null, "no kept page outlives the withdrawal");
          const fresh = await readDirectory().catch((error: unknown) => ({ thrown: String(error) }));
          if (Array.isArray(fresh)) {
            if (mode === "numbers") assert.ok(fresh.every((row) => row.numbers === null));
            else assert.equal(fresh.length, 0);
          }
        } finally { release.open(); await running; redis.pipeline = real; }
      });
    }
  } finally {
    redis.pipeline = real; globalThis.fetch = priorFetch;
    if (priorSecret === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = priorSecret;
  }
});
