/**
 * 631 [AA1] (a), unit 9: an agent reads a product's description and its sales
 * page before it prepares any change, through the real MCP route with a
 * synthetic store. Testimonials are counted, never quoted; an unknown product
 * is said so; another store's product is never read.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { salesPageTool } from "@/lib/mcp-tools";
import { EMPTY_PAGE, type SalesPage } from "@/lib/sales-page";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "mcp-page-tools@example.com";
const OTHER = "mcp-page-tools-other@example.com";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    for (const [email, handle] of [[OWNER, "mcp-page-tools"], [OTHER, "mcp-page-tools-other"]] as const) {
      await claimHandle(email, handle, "Page Tools", "");
      await ensureStatsId(email);
      await setSubscription(email, { customerId: `cus_${handle.replace(/-/g, "")}`.slice(0, 24), subscriptionId: `sub_${handle.replace(/-/g, "")}`.slice(0, 24), active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    }
    const mine = await addProduct(OWNER, "The Bread Course", "Bake at home", "29", null);
    const theirs = await addProduct(OTHER, "Their Course", "", "19", null);
    if (!mine.ok || !theirs.ok) throw new Error("No synthetic products");
    const store = (await storeForEmail(OWNER))!;
    const made = await makeKey(store.sid, "Synthetic reader");
    if (!made.ok) throw new Error("No synthetic key");
    let id = 0;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${made.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, value: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
    };

    part("The description, as written");
    const text = await tool("get_product_description", { product: mine.product.id });
    is("answers with the product and its title", [text.isError, text.value.product, text.value.title], [false, mine.product.id, "The Bread Course"]);
    is("no description written yet reads as empty", text.value.description, "");

    part("The sales page");
    const page = await tool("get_sales_page", { product: mine.product.id });
    is("a product with no page of its own: no blocks", [page.isError, page.value.blocks], [false, []]);

    part("Only this store's products");
    const unknown = { isError: true, value: { error: "There is no product with that id in this store. Use list_products for the ids." } };
    is("another store's product is not read", await tool("get_sales_page", { product: theirs.product.id }), unknown);
    is("nor its description", await tool("get_product_description", { product: theirs.product.id }), unknown);
    is("an unknown id is said so", await tool("get_product_description", { product: "nope" }), unknown);
    is("no id is said so", await tool("get_sales_page", {}), unknown);

    part("Testimonials are counted, never quoted");
    const saved: SalesPage = {
      ...EMPTY_PAGE,
      seoTitle: "Bake bread at home",
      blocks: [
        { id: "b1", kind: "quotes", heading: "What bakers say", items: [{ text: "My first loaf rose!", name: "Ana P.", url: "" }, { text: "Clear steps.", name: "Ben", url: "https://example.com/ben" }] },
        { id: "b2", kind: "faq", heading: "Questions", items: [{ q: "How long?", a: "Six weeks." }] },
      ] as SalesPage["blocks"],
    };
    const shown = salesPageTool("p1", "The Bread Course", saved);
    is("the quotes block keeps its heading and a count", shown.blocks[0], { id: "b1", kind: "quotes", heading: "What bakers say", testimonials: 2 });
    is("no buyer's words or name anywhere", JSON.stringify(shown).includes("loaf") || JSON.stringify(shown).includes("Ana P.") || JSON.stringify(shown).includes("example.com/ben"), false);
    is("the creator's own blocks are there as saved", shown.blocks[1], saved.blocks[1]);
    is("the search title is there", shown.seo_title, "Bake bread at home");

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
