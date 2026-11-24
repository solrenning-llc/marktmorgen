/**
 * Issue #4346 (Codex C2, MEDIUM): the MCP server (app/api/mcp/route.ts) dispatched a `tools/call` without checking
 * its arguments against the tool's own published inputSchema (lib/mcp-catalog.ts). `{"days":14}`, `{"days":"7"}`
 * and `{"days":7,"unexpected":true}` were all read as a successful 30-day (or 7-day) answer, after the key was
 * checked and the store's requests counted, so an agent got a different window than it asked for, looking like
 * success. Now arguments are checked against the schema first, before the key or any read: a wrong type, a value
 * outside an enum, a missing required field or an extra property is JSON-RPC -32602 (Invalid params), and nothing
 * is read or counted. A call that matches its schema runs as before; an unknown tool keeps its own answer.
 *
 * Synthetic store, keys and Redis only.
 */
import { makeKey } from "@/lib/api-keys";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription } from "@/lib/store";
import { POST as mcp } from "@/app/api/mcp/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "mcp-args@example.com";
const original = redis.pipeline.bind(redis);
let commands = 0;
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands += batch.length;
  return original(batch);
}) as typeof redis.pipeline;

type Answer = { result?: { content: { text: string }[]; isError: boolean }; error?: { code: number; message: string } };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mcpargs", "MCP Args", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_McpArgs01", subscriptionId: "sub_McpArgs01", active: true, period: paidPeriod() });
  const product = await addProduct(OWNER, "Knife Skills", "Learn to cut.", "29", null);
  if (!product.ok) throw new Error("no product");
  const sid = (await ensureStoreId(OWNER))!.sid;
  const reader = await makeKey(sid, "Reader");
  const drafter = await makeKey(sid, "Drafter", Date.now(), false, "draft");
  if (!reader.ok || !drafter.ok) throw new Error("no keys");
  const call = async (key: string, name: string, args: unknown) => {
    commands = 0;
    const answer = (await (
      await mcp(new Request("https://marktmorgen.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }),
      }))
    ).json()) as Answer;
    return { answer, commands };
  };

  part("Arguments the schema forbids: -32602, and nothing is read or counted");
  for (const [label, name, args] of [
    ["a window outside the enum (14)", "get_revenue_by_channel", { days: 14 }],
    ["a window as text (\"7\")", "get_revenue_by_channel", { days: "7" }],
    ["an extra property", "get_revenue_by_channel", { days: 7, unexpected: true }],
    ["arguments that are not an object", "get_revenue_by_channel", [7]],
    ["an extra property on a tool with none", "list_products", { cursor: "x", more: 1 }],
    ["a product id that is not text", "get_product_description", { product: 5 }],
  ] as [string, string, unknown][]) {
    const { answer, commands: sent } = await call(reader.key, name, args);
    is(`${label}: Invalid params`, answer.error?.code, -32602);
    is(`${label}: no command sent`, sent, 0);
  }
  const missing = await call(drafter.key, "propose_product_title", { product: product.product.id });
  is("a required field missing: Invalid params", missing.answer.error?.code, -32602);
  is("a required field missing: no command sent", missing.commands, 0);

  part("Controls: what matches its schema runs; an unknown tool keeps its own answer");
  const seven = await call(reader.key, "get_revenue_by_channel", { days: 7 });
  is("{ days: 7 } answers", [seven.answer.error ?? null, seven.answer.result?.isError ?? null], [null, false]);
  const none = await call(reader.key, "get_revenue_by_channel", undefined);
  is("no arguments at all answers (the 30-day window)", [none.answer.error ?? null, none.answer.result?.isError ?? null], [null, false]);
  const unknown = await call(reader.key, "no_such_tool", {});
  is("an unknown tool is not answered as Invalid params", unknown.answer.error?.code === -32602, false);

  part("null is read as left out (Claude 1's NIT and Claude 5 ibuF's LOW on #5228)");
  const nullArgs = await call(reader.key, "list_products", null);
  is("arguments: null on a tool without arguments answers", [nullArgs.answer.error ?? null, nullArgs.answer.result?.isError ?? null], [null, false]);
  const nullDays = await call(reader.key, "get_revenue_by_channel", { days: null });
  is("a known argument sent as null answers (the default window)", [nullDays.answer.error ?? null, nullDays.answer.result?.isError ?? null], [null, false]);
  const nullVersion = await call(reader.key, "get_page_versions", { product: product.product.id, version: null });
  is("version: null is the list again, never Invalid params", nullVersion.answer.error?.code === -32602, false);
  const nullRequired = await call(drafter.key, "propose_product_title", { product: product.product.id, title: null });
  is("a required argument sent as null is still required", [nullRequired.answer.error?.code, nullRequired.commands], [-32602, 0]);
  const nullExtra = await call(reader.key, "list_products", { more: null });
  is("an argument the tool does not take is refused even as null", [nullExtra.answer.error?.code, nullExtra.commands], [-32602, 0]);

  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
