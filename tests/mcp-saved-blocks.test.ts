/**
 * 631 [AA1] (a), unit 14: an agent reads the creator's saved sections through
 * the real MCP route with a synthetic store, newest change first, with
 * testimonials counted, never quoted.
 */
import { POST } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { writeSection } from "@/lib/saved-block-store";
import { newBlockId } from "@/lib/sales-page";
import { newSectionId } from "@/lib/saved-blocks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "mcp-saved-blocks@example.com";

async function main(): Promise<void> {
  redis.clear();
  const previousFetch = globalThis.fetch;
  let outside = 0;
  globalThis.fetch = (async () => {
    outside += 1;
    throw new Error("No outside requests in this test");
  }) as typeof fetch;
  try {
    await claimHandle(OWNER, "mcp-saved-blocks", "Saved Blocks", "");
    await ensureStatsId(OWNER);
    await setSubscription(OWNER, { customerId: "cus_McpSavedBlk01", subscriptionId: "sub_McpSavedBlk01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
    const store = (await storeForEmail(OWNER))!;
    const key = await makeKey(store.sid, "Synthetic reader");
    if (!key.ok) throw new Error("No synthetic key");
    const list = async () => {
      const response = await POST(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_saved_blocks", arguments: {} } }),
      }));
      const body = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };
      return { isError: body.result.isError, raw: body.result.content[0].text, value: JSON.parse(body.result.content[0].text) as { sections: { name: string; blocks: Record<string, unknown>[] }[] } };
    };

    part("None saved yet");
    is("an empty list", (await list()).value.sections, []);

    part("Saved sections, newest change first, testimonials counted");
    const older = await writeSection(store.statsId!, { id: newSectionId(), name: "Guarantee", updatedAt: 1_000, blocks: [{ id: newBlockId(), kind: "faq", heading: "Questions", items: [{ q: "Refunds?", a: "Thirty days." }] }] }, true, 10);
    const newer = await writeSection(store.statsId!, { id: newSectionId(), name: "Praise", updatedAt: 2_000, blocks: [{ id: newBlockId(), kind: "quotes", heading: "Bakers say", items: [{ text: "My loaf rose!", name: "Ana", url: "https://example.com/ana" }] }] }, true, 10);
    is("both saved", [older, newer], ["ok", "ok"]);
    const read = await list();
    is("newest change first", read.value.sections.map((s) => s.name), ["Praise", "Guarantee"]);
    is("the testimonial is a count", read.value.sections[0].blocks[0], { id: read.value.sections[0].blocks[0].id, kind: "quotes", heading: "Bakers say", testimonials: 1 });
    is("no buyer's words or link anywhere", read.raw.includes("My loaf rose") || read.raw.includes("example.com/ana") || read.raw.includes("\"Ana\""), false);
    is("the creator's own blocks as saved", read.value.sections[1].blocks[0].kind, "faq");

    is("nothing reached outside", outside, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
  done();
}

void main();
