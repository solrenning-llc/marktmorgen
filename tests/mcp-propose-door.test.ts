/**
 * propose_product_description goes through the same door as the other MCP
 * tools (Claude 5's cross review of #1856, CX72):
 *
 * - MÉDIO: a store marked funded whose paid resource month cannot be reserved
 *   is refused before anything is read, written or taken, as the read-only
 *   tools are; it used to read three listings and the book, take room and
 *   write the proposal.
 * - LEVE: a failure while the product is read, before the book's own steps,
 *   answers as the tool's failure, never as an error thrown out of the route
 *   (an HTTP 500 instead of a JSON-RPC answer).
 *
 * Synthetic store and key; no outside request.
 */
import { POST as mcp } from "@/app/api/mcp/route";
import { makeKey } from "@/lib/api-keys";
import { proposeDescription } from "@/lib/agent-propose";
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
  })).then((r) => r, (error: Error) => error);
  if (response instanceof Error) return { status: "threw", body: null as null | { result?: { isError?: boolean }; error?: { code: number; message: string } } };
  return { status: response.status, body: (await response.json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: { code: number; message: string } } };
}

async function storeWith(owner: string, handle: string, funded: boolean) {
  await claimHandle(owner, handle, "Synthetic door", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "scale", cycle: "month", period: { ...paidPeriod(), ...(funded ? { funded: true } : {}) } });
  const store = (await storeForEmail(owner))!;
  const product = await addProduct(owner, "Guide", "A guide.", "29", null);
  if (!product.ok) throw new Error("no product");
  const reader = await makeKey(store.sid, "Reader", Date.now(), false);
  const drafter = await makeKey(store.sid, "Drafter", Date.now(), false, "draft");
  if (!reader.ok || !drafter.ok) throw new Error("no synthetic key");
  return { store, product: product.product.id, reader: reader.key, drafter: drafter.key };
}

async function main(): Promise<void> {
  redis.clear();

  part("A funded store whose paid resource month cannot be reserved");
  const funded = await storeWith("door-funded@example.com", "doorfunded", true);
  const read = await call(funded.reader, "get_product_description", { product: funded.product });
  is("control: a read-only tool is refused at the door", read.body?.error?.code, -32001);
  is("control: and takes none of the store's API requests", await allowanceUsed(funded.store, "api"), 0);
  const proposed = await call(funded.drafter, "propose_product_description", { product: funded.product, description: "New words for the guide." });
  is("the proposal tool is refused at the same door", proposed.body?.error?.code, -32001);
  is("it takes none of the store's API requests", await allowanceUsed(funded.store, "api"), 0);
  is("and writes no proposal", redis.run(["GET", `nl:agent:book:${funded.store.statsId}`]), null);

  part("A failure while the product is read");
  // A store whose catalog is kept apart (not inline), so the product is read from Redis, and that read fails.
  const plain = await storeWith("door-plain@example.com", "doorplain", false);
  const apart = { ...plain.store, catalog: { ...plain.store.catalog, inline: null, head: [], id: "doorcatalog", items: [{ id: plain.product, kind: 0, options: [] }] } } as typeof plain.store;
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "MGET" || c[0] === "GET" && String(c[1] ?? "").includes("doorcatalog"))) throw new Error("synthetic Redis failure");
    return pipe(commands);
  }) as typeof redis.pipeline;
  const failed = await proposeDescription(apart, "key1", { product: plain.product, description: "New words for the guide." }).then((r) => r, (e: Error) => e);
  redis.pipeline = pipe;
  is("it answers, never throws out of the tool", failed instanceof Error ? `threw ${failed.message}` : "answered", "answered");
  is("as a failure, with nothing proposed", failed instanceof Error ? null : [failed.isError, failed.content[0].text.includes("could not")], [true, true]);
  is("and writes no proposal", redis.run(["GET", `nl:agent:book:${plain.store.statsId}`]), null);
  done();
}

void main();
