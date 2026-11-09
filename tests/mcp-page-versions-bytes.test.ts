/**
 * The sibling of GET /api/store/page-versions on claude5/page-bytes-cap (rule 30): the MCP tool get_page_versions
 * (lib/mcp-tools.ts, readPageVersionsTool) read a page's kept versions (LRANGE) whatever they weighed, and set aside
 * only PAGE_VERSION_BYTES for each. A version kept before 9 November 2026, when writePage held a page to a length in
 * UTF-16 units, may weigh up to three times that: what it weighs past it moved before it was paid for.
 *
 * Each version is now measured in Redis first (versionSizes, sizes only), and only the newest ones that each fit in
 * PAGE_VERSION_BYTES are read; one kept larger is never read here, counted in too_large, and refused in words when
 * asked for (the studio still brings it back, paid for at its weight).
 *
 * Every call is a real one through the MCP route with a synthetic key, on the in-memory Redis; only the versions kept
 * before pages were held in bytes are set by hand.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { EMPTY_PAGE, newBlockId } from "@/lib/sales-page";
import { MAX_VERSION_BYTES } from "@/lib/sales-page-store";
import { addWork, apiReadUnits, listingsWork, pageVersionsWork } from "@/lib/api-read-rules";
import { listingsToRead } from "@/lib/catalog-read-count";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");
const real = redis.pipeline.bind(redis);
/** The heaviest entry any LRANGE of the versions key sent back, and how many such reads there were. */
let watched = "";
let heaviest = 0;
let ranges = 0;
redis.pipeline = (async (batch: Command[]) => {
  const values = (await real(batch)) as unknown[];
  batch.forEach((c, i) => {
    if (watched && c[0] === "LRANGE" && c[1] === watched) {
      ranges += 1;
      for (const entry of Array.isArray(values[i]) ? (values[i] as unknown[]) : []) if (typeof entry === "string") heaviest = Math.max(heaviest, utf8(entry));
    }
  });
  return values;
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "mcp-version-bytes@example.com";
  await claimHandle(owner, "mcp-version-bytes", "Version Bytes", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_McpVerBytes01", subscriptionId: "sub_McpVerBytes01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const made = await addProduct(owner, "Guide", "", "29", null);
  const other = await addProduct(owner, "Notes", "", "9", null);
  if (!made.ok || !other.ok) throw new Error("fixture product");
  const store = (await storeForEmail(owner))!;
  const key = await makeKey(store.sid, "Version bytes");
  if (!key.ok) throw new Error("fixture key");
  let id = 0;
  const call = async (args: Record<string, unknown>) => {
    const r = await POST(new Request("https://marktmorgen.com/api/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "get_page_versions", arguments: args } }) }));
    const body = (await r.json()) as { result?: { isError: boolean; content: { text: string }[] } };
    const text = body.result?.content[0]?.text ?? "{}";
    return { isError: body.result?.isError ?? null, value: JSON.parse(text) as Record<string, unknown> };
  };
  const versionsKey = (product: string) => `nl:product:pages:${store.statsId}:${product}`;
  // A record kept before pages were held in bytes: 239,000 UTF-16 units, 717 kB.
  const legacy = JSON.stringify({ blocks: [{ id: "lega0001", kind: "text", heading: "", body: "語".repeat(239_000) }] });
  const small = JSON.stringify({ ...EMPTY_PAGE, blocks: [{ id: newBlockId(), kind: "hero", headline: "Bake bread", sub: "", media: "none", video: null }] });
  console.log(`  an old version: ${utf8(`1730000000000\n${legacy}`)} bytes; MAX_VERSION_BYTES ${MAX_VERSION_BYTES}`);

  part("A newer version that fits is read; two kept larger before are never read, and are counted");
  const p = made.product.id;
  // Newest first: the small one saved over after the two old ones.
  await real([["RPUSH", versionsKey(p), `1800000000000\n${small}`, `1730000000001\n${legacy}`, `1730000000000\n${legacy}`]]);
  watched = versionsKey(p);
  heaviest = 0;
  const before = await allowanceUsed(store, "api");
  const listed = await call({ product: p });
  const taken = (await allowanceUsed(store, "api")) - before;
  const versions = (listed.value.versions ?? []) as { headline: string }[];
  const due = 1 + apiReadUnits(addWork(listingsWork(listingsToRead(store, [p])), pageVersionsWork(1, false)));
  console.log(`  heaviest version read: ${heaviest} bytes; listed ${versions.length}, too_large ${String(listed.value.too_large)}; took ${taken} (one version's envelope: ${due})`);
  is("no version past MAX_VERSION_BYTES was read", heaviest <= MAX_VERSION_BYTES, true);
  is("the one that fits is listed, the two larger counted", [listed.isError, versions.length, versions[0]?.headline, listed.value.too_large], [false, 1, "Bake bread", 2]);
  is("it took the door's request and the envelope of the one version read", taken, due);

  part("Asking for a version kept larger is refused in words, without reading it");
  heaviest = 0;
  const asked = await call({ product: p, version: 1 });
  is("refused, the version not read", [asked.isError, String(asked.value.error ?? "").includes("too large"), heaviest <= MAX_VERSION_BYTES], [true, true, true]);
  const first = await call({ product: p, version: 0 });
  is("the one that fits is still read whole", [first.isError, first.value.version], [false, 0]);

  part("When every kept version is larger, none is read at all");
  const q = other.product.id;
  await real([["RPUSH", versionsKey(q), `1730000000001\n${legacy}`, `1730000000000\n${legacy}`]]);
  watched = versionsKey(q);
  heaviest = 0;
  ranges = 0;
  const none = await call({ product: q });
  is("no LRANGE of the versions, an empty list, both counted", [none.isError, ranges, none.value.versions, none.value.too_large], [false, 0, [], 2]);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
