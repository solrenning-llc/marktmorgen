/**
 * Codex N1's two LOWs on #3062 (comment 7049000493, report N1-20261120-1109-review-3062-lot65.md), both in main's
 * code that #2921 and #3062 build on:
 *
 * 1. setAffiliateSetting (lib/store.ts) saved the program, then kept the directory index in step
 *    (lib/directory-index.ts rememberListing). A rejected index write was only logged and the save still answered
 *    { ok: true }, so a creator who withdrew from the directory was told it was saved while their program stayed
 *    listed until a rebuild or the cache's expiry. Now it answers a retryable failure; the same save sent again
 *    writes the same program and keeps the index in step.
 * 2. components/affiliate-directory.tsx called the rate "of clicks became a sale", with a "%". Several sales can
 *    come from one click, so the figure can pass 100: it is now said as sales per 100 clicks.
 *
 * Synthetic only.
 */
import { readFileSync } from "node:fs";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LISTED = "nl:dir:listed";

async function main(): Promise<void> {
  redis.clear();
  const owner = "listing@example.com";
  await claimHandle(owner, "listingshop", "Listing Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  const sid = (await storeForEmail(owner))!.sid;

  part("A directory index write that fails is never a saved program");
  const listed = { ...NO_AFFILIATES, enabled: true, percent: 25, rates: {}, directory: true };
  is("listed in the directory when the index answers", (await setAffiliateSetting(owner, listed)).ok, true);
  is("and the index holds the store", (await redis.pipeline([["SISMEMBER", LISTED, sid]]))[0], 1);

  const original = redis.pipeline.bind(redis);
  let refused = 0;
  (redis as { pipeline: typeof original }).pipeline = async (commands) => {
    if (commands.some((c) => (c[0] === "SADD" || c[0] === "SREM") && c[1] === LISTED)) {
      refused += 1;
      throw new Error("the index write was refused (synthetic)");
    }
    return original(commands);
  };
  const withdrawn = await setAffiliateSetting(owner, { ...listed, directory: false });
  (redis as { pipeline: typeof original }).pipeline = original;
  is("withdrawing while the index write fails answers a retryable failure, never ok", [refused, withdrawn.ok, withdrawn.ok ? "" : withdrawn.reason], [1, false, "listing"]);
  is("  the index still names the store, so the creator must be told to try again", (await redis.pipeline([["SISMEMBER", LISTED, sid]]))[0], 1);

  const again = await setAffiliateSetting(owner, { ...listed, directory: false });
  is("the same save sent again is saved", again.ok, true);
  is("  and the store has left the index", (await redis.pipeline([["SISMEMBER", LISTED, sid]]))[0], 0);

  part("The directory's rate per click is said as sales per 100 clicks");
  const page = readFileSync("components/affiliate-directory.tsx", "utf8");
  is("never 'of clicks became a sale': several sales can come from one click", page.includes("of clicks became a sale"), false);
  is("said as sales per 100 clicks, with no percent sign", /label: "sales per 100 clicks", value: `\$\{numbers\.conversion\}`/.test(page), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
