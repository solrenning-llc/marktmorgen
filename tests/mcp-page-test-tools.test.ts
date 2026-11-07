/**
 * 631 [AA1] (a), unit 12: an agent reads how a product's page test stands and
 * how far its page is read, through the real MCP route with a synthetic
 * store. The test's state is the studio's own rule; no winner is invented.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { pageTestTool } from "@/lib/mcp-tools";
import { testState } from "@/lib/headline-test-rules";
import { EMPTY_PAGE, type SalesPage } from "@/lib/sales-page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "mcp-page-test-tools@example.com";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "mcp-page-test-tools", "Page Test Tools", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_McpPageTest01", subscriptionId: "sub_McpPageTest01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const made = await addProduct(OWNER, "Bread Course", "", "29", null);
    if (!made.ok) throw new Error("no product");
    const store = (await storeForEmail(OWNER))!;
    const key = await makeKey(store.sid, "Synthetic reader");
    if (!key.ok) throw new Error("No synthetic key");
    let id = 0;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, value: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
    };

    part("Through the route");
    is("no test running is said so", await tool("get_page_test", { product: made.product.id }), { isError: true, value: { error: "This product's page is not running a test." } });
    is("an unknown product is said so", (await tool("get_page_test", { product: "nope" })).value, { error: "There is no product with that id in this store. Use list_products for the ids." });
    const reading = await tool("get_page_reading", { product: made.product.id });
    is("a page nobody read yet: no blocks, nobody measured", [reading.isError, reading.value.visitors_measured, reading.value.blocks], [false, 0, []]);
    is("an unknown product's reading is said so", (await tool("get_page_reading", { product: "nope" })).isError, true);

    part("The state is the studio's own rule");
    const page: SalesPage = { ...EMPTY_PAGE, test: { id: "t1", headline: "Bake better bread", sub: "In six weeks", measure: "checkouts" } };
    const few = { va: 40, vb: 38, ca: 2, cb: 3 };
    const shown = pageTestTool("p1", page, few, "checkouts", 0.5, Date.UTC(2026, 10, 2));
    is("too few views: no winner", [shown.state, shown.winner], [testState(few, "checkouts", { declared: "checkouts", shareB: 0.5, now: Date.UTC(2026, 10, 2) }).state, null]);
    is("each version's counts", [shown.a, shown.b], [{ views: 40, checkouts_started: 2, sales: null, revenue: null }, { views: 38, checkouts_started: 3, sales: null, revenue: null }]);
    is("the headline tested", shown.headlines, { b: "Bake better bread", b_line: "In six weeks" });
    const clear = { va: 3000, vb: 3000, ca: 60, cb: 150 };
    const won = pageTestTool("p1", page, clear, "checkouts", 0.5, Date.UTC(2026, 10, 2));
    is("a clear difference: won, as the studio says", [won.state, won.winner], [testState(clear, "checkouts", { declared: "checkouts", shareB: 0.5, now: Date.UTC(2026, 10, 2) }).state, testState(clear, "checkouts", { declared: "checkouts", shareB: 0.5, now: Date.UTC(2026, 10, 2) }).winner]);
    is("and that is b", won.winner, "b");

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
