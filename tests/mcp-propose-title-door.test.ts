/**
 * The title and summary proposals pass the same door as the description's (Claude 5's second review of #1929): a
 * funded store whose paid resource month cannot be reserved refuses them before any of its API requests is taken,
 * and a failure while the product is read answers as the tool's failure, never as an error thrown out of it.
 * Synthetic store and keys (MemoryRedis); no outside request.
 */
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { proposeSummary, proposeTitle } from "@/lib/agent-propose";
import { allowanceUsed } from "@/lib/store-allowance";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

let id = 0;
async function call(key: string, name: string, args: Record<string, unknown>) {
  const response = await mcp(new Request("https://marktmorgen.com/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  }));
  return (await response.json()) as { result?: { isError?: boolean }; error?: { code: number } };
}

async function storeWith(owner: string, handle: string, funded: boolean) {
  await claimHandle(owner, handle, "Synthetic door", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "scale", cycle: "month", period: { ...paidPeriod(), ...(funded ? { funded: true } : {}) } });
  const store = (await storeForEmail(owner))!;
  const product = await addProduct(owner, "Guide", "A guide.", "29", null);
  if (!product.ok) throw new Error("no product");
  const drafter = await makeKey(store.sid, "Drafter", Date.now(), false, "draft");
  if (!drafter.ok) throw new Error("no synthetic key");
  return { store, product: product.product.id, drafter: drafter.key };
}

async function main(): Promise<void> {
  redis.clear();
  part("A funded store whose paid resource month cannot be reserved");
  const funded = await storeWith("title-door-funded@example.com", "titledoorfunded", true);
  for (const [tool, args] of [["propose_product_title", { title: "A better guide" }], ["propose_product_summary", { summary: "What it teaches, in one line." }]] as [string, Record<string, unknown>][]) {
    const proposed = await call(funded.drafter, tool, { product: funded.product, ...args });
    is(`${tool}: refused at the door`, proposed.error?.code, -32001);
  }
  is("none of the store's API requests taken", await allowanceUsed(funded.store, "api"), 0);
  is("and no proposal written", redis.run(["GET", `nl:agent:book:${funded.store.statsId}`]), null);

  part("A failure while the product is read");
  const plain = await storeWith("title-door-plain@example.com", "titledoorplain", false);
  const apart = { ...plain.store, catalog: { ...plain.store.catalog, inline: null, head: [], id: "titlecatalog", items: [{ id: plain.product, kind: 0, options: [] }] } } as typeof plain.store;
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "MGET" || (c[0] === "GET" && String(c[1] ?? "").includes("titlecatalog")))) throw new Error("synthetic Redis failure");
    return pipe(commands);
  }) as typeof redis.pipeline;
  const title = await proposeTitle(apart, "key1", { product: plain.product, title: "A better guide" }).then((r) => r, (e: Error) => e);
  const summary = await proposeSummary(apart, "key1", { product: plain.product, summary: "What it teaches, in one line." }).then((r) => r, (e: Error) => e);
  redis.pipeline = pipe;
  for (const [label, got] of [["title", title], ["summary", summary]] as const) {
    is(`${label}: it answers, never throws out of the tool`, got instanceof Error ? `threw ${got.message}` : "answered", "answered");
    is(`${label}: as a failure, with nothing proposed`, got instanceof Error ? null : [got.isError, got.content[0].text.includes("could not")], [true, true]);
  }
  done();
}
void main();
