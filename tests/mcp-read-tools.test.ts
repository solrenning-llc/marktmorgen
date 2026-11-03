/**
 * 631 [AA1] (a), unit 8: two more read tools on the MCP server, the studio's
 * live numbers (get_live) and any stretch of days (get_numbers_for_days),
 * through the real route with a synthetic store. Paid figures stay null when
 * the sales reading is not complete; bad dates are refused in words.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { liveTool, rangeTool } from "@/lib/mcp-tools";
import { MCP_TOOLS } from "@/lib/mcp-catalog";
import type { RangeData } from "@/lib/stats";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "mcp-read-tools@example.com";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "mcp-read-tools", "MCP Read Tools", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_McpReadTools1", subscriptionId: "sub_McpReadTools1", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const store = (await storeForEmail(OWNER))!;
    const made = await makeKey(store.sid, "Synthetic reader");
    if (!made.ok) throw new Error("No synthetic key");
    let id = 0;
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${made.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, value: JSON.parse(body.result.content[0].text) as Record<string, unknown> };
    };

    part("Every tool has a title and a read-only hint (what connector directories ask for)");
    is("tools without a title", MCP_TOOLS.filter((t) => !t.title || t.annotations.title !== t.title).map((t) => t.name), []);
    is("every tool says it reads only, but those that prepare a change for the creator to confirm", MCP_TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name), ["propose_product_description", "propose_product_title"]);
    is("names are 64 characters or fewer", MCP_TOOLS.every((t) => t.name.length <= 64), true);

    part("get_live: right now and today, counted, nobody named");
    const live = await tool("get_live");
    is("answers", live.isError, false);
    is("its fields", Object.keys(live.value), ["note", "last_minutes", "visitors_now", "sources_now", "today"]);
    is("an empty store has nobody on it", live.value.visitors_now, 0);
    is("shaped from the studio's own reading", liveTool({ visitors: 3, sources: [{ source: "instagram", visitors: 3 }] }, { date: "2026-11-02", visitors: 9, views: 20, checkouts: 2, sources: [{ source: "instagram", visits: 9 }], sales: null }), {
      note: liveTool({ visitors: 0, sources: [] }, null).note,
      last_minutes: 5,
      visitors_now: 3,
      sources_now: [{ channel: "instagram", visitors: 3 }],
      today: { day: "2026-11-02", visitors: 9, page_views: 20, checkouts_started: 2, sales: null, revenue: null, sources: [{ channel: "instagram", visits: 9 }] },
    });

    part("get_numbers_for_days: any stretch, bad dates refused in words");
    const week = await tool("get_numbers_for_days", { from: day(-6), to: day(0) });
    is("seven days answer", [week.isError, week.value.from, week.value.to, (week.value.days as unknown[]).length], [false, day(-6), day(0), 7]);
    is("refused: not dates", await tool("get_numbers_for_days", { from: "last week", to: day(0) }), { isError: true, value: { error: "Send from and to as YYYY-MM-DD." } });
    is("refused: in the wrong order", (await tool("get_numbers_for_days", { from: day(0), to: day(-1) })).value, { error: "from must not be after to." });
    is("refused: in the future", (await tool("get_numbers_for_days", { from: day(0), to: day(2) })).value, { error: "to must not be after today (UTC)." });
    is("refused: older than kept", (await tool("get_numbers_for_days", { from: day(-500), to: day(-490) })).value, { error: "Days are kept for 400 days; start later." });

    part("Unknown paid figures are null, never zero");
    const range: RangeData = {
      from: "2026-10-01", to: "2026-10-02", currency: "usd",
      days: [{ date: "2026-10-01", visitors: 10, views: 12, checkouts: 2, sales: 1, cents: 4900 }],
      totals: { visitors: 10, views: 12, checkouts: 2, sales: 1, cents: 4900 },
      before: { visitors: 4, views: 5, checkouts: 1, sales: 0, cents: 0 },
      channels: [{ source: "newsletter", visits: 10, sales: 1, cents: 4900 }],
      products: [{ id: "p1", views: 12, checkouts: 2, sales: 1, cents: 4900 }],
      sales: "ok", partial: false, elsewhere: 0,
    };
    const complete = rangeTool(range, new Map([["p1", "Course"]]));
    is("complete: the money is there", [complete.paid_figures_complete, complete.totals.revenue, complete.products[0].title], [true, 4900, "Course"]);
    const partial = rangeTool({ ...range, partial: true }, new Map());
    is("partial: paid figures null", [partial.paid_figures_complete, partial.totals.sales, partial.totals.revenue, partial.days[0].revenue, partial.channels[0].sales, partial.the_same_days_before?.revenue], [false, null, null, null, null, null]);
    is("partial: traffic still there", [partial.totals.visitors, partial.days[0].page_views], [10, 12]);
    is("errored sales reading: paid figures null", rangeTool({ ...range, sales: "error" }, new Map()).totals.revenue, null);
    is("a product no longer in the store is said so", partial.products[0].title, "A product no longer in your store");

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
