/**
 * A Search Console answer that arrives after store erasure started must not
 * recreate the store's private query cache or be returned as live data.
 */
import { SEARCH_CONSOLE_SCOPE, storeSearches } from "@/lib/search-console";
import { redisPipeline } from "@/lib/redis";
import { seal } from "@/lib/secret-box";
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, ownerKey, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "a-local-key-for-tests-only-0123456789abcdef";
process.env.GOOGLE_OAUTH_CLIENT_ID = "client-id.apps.googleusercontent.com";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "client-secret-for-tests";

const OWNER = "gsc-erasure@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "gsc-erasure", "GSC Erasure", "");
  await ensureStatsId(OWNER);
  const shop = (await storeForEmail(OWNER))!;
  const cache = `nl:gsc:q:${shop.statsId}`;
  await redisPipeline([["SET", "nl:gsc:conn", JSON.stringify({ refresh: seal("synthetic-refresh", "search-console|marktmorgen") })]]);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "synthetic-access", expires_in: 3600, scope: SEARCH_CONSOLE_SCOPE });
    }
    if (url.hostname === "searchconsole.googleapis.com") {
      // The closing walk has begun and removed the live id while this supplier
      // request was in flight; it has also already deleted the old cache.
      await redisPipeline([
        ["HSET", ERASING_KEY, await erasingField(storeRef(shop)), String(Date.now())],
        ["DEL", storeIdCommand(shop.sid)[1]],
        ["DEL", cache],
      ]);
      return Response.json({ rows: [{ keys: ["private synthetic query"], clicks: 1, impressions: 2, position: 3 }] });
    }
    return Response.json({});
  }) as typeof fetch;

  part("Search Console answer after erasure");
  const read = await storeSearches(shop);
  is("the stale supplier answer is not returned as live store data", read, null);
  const [kept] = await redisPipeline([["GET", cache]]);
  is("the deleted store's private query cache is not recreated", kept, null);

  // A live store kept from before ids (its sid is "") has no id key: the fence reads its record, under its owner's
  // address, as lib/store-live-cache.ts does (Claude 3's MEDIUM on #4934). Its answer is shown, kept a day, and the
  // next view reads it back without asking Google again.
  part("A live store kept from before ids (sid \"\") gets its answer and keeps it");
  redis.clear();
  await claimHandle(OWNER, "gsc-erasure", "GSC Erasure", "");
  await ensureStatsId(OWNER);
  const legacy = { ...(await storeForEmail(OWNER))!, sid: "" };
  const legacyCache = `nl:gsc:q:${legacy.statsId}`;
  await redisPipeline([["SET", "nl:gsc:conn", JSON.stringify({ refresh: seal("synthetic-refresh", "search-console|marktmorgen") })]]);
  let googleCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "synthetic-access", expires_in: 3600, scope: SEARCH_CONSOLE_SCOPE });
    }
    if (url.hostname === "searchconsole.googleapis.com") {
      googleCalls += 1;
      return Response.json({ rows: [{ keys: ["synthetic legacy query"], clicks: 1, impressions: 2, position: 3 }] });
    }
    return Response.json({});
  }) as typeof fetch;
  const first = await storeSearches(legacy);
  is("the answer is shown", first?.rows.map((row) => row.query), ["synthetic legacy query"]);
  const [legacyKept] = await redisPipeline([["GET", legacyCache]]);
  is("the answer is kept", typeof legacyKept === "string" && legacyKept.includes("synthetic legacy query"), true);
  const second = await storeSearches(legacy);
  is("the second view reads the kept answer, not Google", { rows: second?.rows.map((row) => row.query), googleCalls }, { rows: ["synthetic legacy query"], googleCalls: 1 });

  part("The same store once its record is gone is never kept");
  await redisPipeline([["DEL", legacyCache], ["DEL", await ownerKey(storeRef(legacy))]]);
  is("no answer for a store whose record is gone", await storeSearches(legacy), null);
  const [goneKept] = await redisPipeline([["GET", legacyCache]]);
  is("and no cache is written", goneKept, null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
