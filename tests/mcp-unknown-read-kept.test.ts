/**
 * A page's versions or the saved sections read but not known (a row that does
 * not parse, after other keys saved more since the count) keep everything that
 * was set aside: how much was read is not known, so it is never settled at the
 * count taken before the read (Codex J's question on #1821, da90d9f6).
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { MAX_VERSIONS } from "@/lib/sales-page-store";
import { SAVED_SECTIONS_MAX, addWork, apiReadUnits, listingsWork, pageVersionsWork, savedBlocksWork } from "@/lib/api-read-rules";
import { listingsToRead } from "@/lib/catalog-read-count";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let afterCount: (() => Promise<void>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (afterCount && batch.some((c) => c[0] === "HLEN" || c[0] === "LLEN")) {
    const run = afterCount;
    afterCount = null;
    await run();
  }
  return values;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "mcp-unknown-kept@example.com";
  await claimHandle(owner, "mcp-unknown-kept", "Unknown Kept", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_UnknownKept001", subscriptionId: "sub_UnknownKept001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const made = await addProduct(owner, "Guide", "", "29", null);
  if (!made.ok) throw new Error("fixture product");
  const store = (await storeForEmail(owner))!;
  const key = await makeKey(store.sid, "Unknown kept");
  if (!key.ok) throw new Error("fixture key");
  const p = made.product.id;
  const sectionsKey = `nl:sblocks:${store.statsId}`;
  const versionsKey = `nl:product:pages:${store.statsId}:${p}`;
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await POST(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) }));
    return (await r.json()) as { result?: { isError: boolean } };
  };
  const big = "€".repeat(12_000);

  part("Saved sections: grown after the count, one row unreadable");
  {
    afterCount = async () => {
      const rows: Command[] = Array.from({ length: SAVED_SECTIONS_MAX - 1 }, (_, i) => ["HSET", sectionsKey, `s${i}`, `{"id":"s${i}","name":"${big}"`]);
      await real([...rows, ["HSET", sectionsKey, "bad", "not a section"]]);
    };
    const before = await allowanceUsed(store, "api");
    const answered = await call("list_saved_blocks", {});
    const taken = (await allowanceUsed(store, "api")) - before;
    is("unavailable, and all that was set aside is kept", [answered.result?.isError ?? null, taken], [true, 1 + apiReadUnits(savedBlocksWork(SAVED_SECTIONS_MAX))]);
  }

  part("Page versions: grown after the count, one version unreadable");
  {
    afterCount = async () => {
      const rows: Command[] = Array.from({ length: MAX_VERSIONS - 1 }, () => ["RPUSH", versionsKey, `1800000000000\n${big}`]);
      await real([...rows, ["RPUSH", versionsKey, "not a version"]]);
    };
    const before = await allowanceUsed(store, "api");
    const answered = await call("get_page_versions", { product: p });
    const taken = (await allowanceUsed(store, "api")) - before;
    is("unavailable, and all that was set aside is kept", [answered.result?.isError ?? null, taken], [true, 1 + apiReadUnits(addWork(listingsWork(listingsToRead(store, [p])), pageVersionsWork(MAX_VERSIONS, false)))]);
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
