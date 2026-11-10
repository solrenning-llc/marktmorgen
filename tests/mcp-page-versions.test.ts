/**
 * 631 [AA1] (a), unit 13: an agent reads a sales page's earlier versions
 * through the real MCP route with a synthetic store: the list newest first,
 * one version block by block with testimonials counted, refusals in words.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { writePage } from "@/lib/sales-page-store";
import { EMPTY_PAGE, type SalesPage, newBlockId } from "@/lib/sales-page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const OWNER = "mcp-page-versions@example.com";
const hero = (headline: string): SalesPage["blocks"][number] => ({ id: newBlockId(), kind: "hero", headline, sub: "", media: "none", video: null });

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "mcp-page-versions", "Page Versions", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_McpPageVers01", subscriptionId: "sub_McpPageVers01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const made = await addProduct(OWNER, "Bread Course", "", "29", null);
    if (!made.ok) throw new Error("no product");
    const store = (await storeForEmail(OWNER))!;
    const key = await makeKey(store.sid, "Synthetic reader");
    if (!key.ok) throw new Error("No synthetic key");
    let id = 0;
    const tool = async (args: Record<string, unknown>) => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "get_page_versions", arguments: args } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, value: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
    };

    part("No earlier version yet");
    is("an empty list", (await tool({ product: made.product.id })).value.versions, []);

    part("After two saves, the first is an earlier version");
    const quotes: SalesPage["blocks"][number] = { id: newBlockId(), kind: "quotes", heading: "Bakers say", items: [{ text: "My loaf rose!", name: "Ana", url: "https://example.com/ana" }] };
    await writePage(store.statsId!, made.product.id, { ...EMPTY_PAGE, blocks: [hero("Bake bread"), quotes] }, ROOM, true);
    await writePage(store.statsId!, made.product.id, { ...EMPTY_PAGE, blocks: [hero("Bake better bread")] }, ROOM, true);
    const list = await tool({ product: made.product.id });
    const versions = list.value.versions as { version: number; headline: string; blocks: number }[];
    is("the list, newest first, with its headline", [list.isError, versions[0]?.version, versions[0]?.headline, versions[0]?.blocks], [false, 0, "Bake bread", 2]);
    const one = await tool({ product: made.product.id, version: 0 });
    const blocks = one.value.blocks as Record<string, unknown>[];
    is("one version, block by block", [one.isError, blocks.length, blocks[1]?.kind, blocks[1]?.testimonials], [false, 2, "quotes", 1]);
    is("testimonials counted, not quoted", JSON.stringify(one.value).includes("My loaf rose") || JSON.stringify(one.value).includes("example.com/ana"), false);

    part("Refusals in words");
    is("a version that is not there", (await tool({ product: made.product.id, version: 7 })).value, { error: "There is no such version. Read the list first, without version." });
    is("a version that is not a whole number", (await tool({ product: made.product.id, version: 1.5 })).value, { error: "version is a whole number from the list, 0 for the newest." });
    is("an unknown product", (await tool({ product: "nope" })).isError, true);

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
