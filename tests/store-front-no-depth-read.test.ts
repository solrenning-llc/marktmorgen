/**
 * Drawing a store's front page never reads a product page's reading (lib/page-depth.ts, nl:depth:), however many
 * products the store has (C1-20261117, 2,000 products on every plan): those records are read only by the studio's
 * depth view, the AI route and the MCP tool. What the page does read of the store record is measured, so the
 * cost model can price it (tests/traffic-cost.ts). Synthetic store only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForPage } from "@/lib/store";
import { MAX_PRODUCTS, STORE_PAGE_SIZE, readListings } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "front@example.com";
  await claimHandle(owner, "frontshop", "Front Shop", "");
  await setSubscription(owner, { customerId: "cus_Front00001", subscriptionId: "sub_Front00001", active: true, tier: "scale", trialEnds: 0, period: paidPeriod() });
  await ensureStatsId(owner);
  for (let n = 0; n < MAX_PRODUCTS; n += 1) {
    const made = await addProduct(owner, `Product ${n}`, "A product.", "9");
    if (!made.ok) throw new Error(`product ${n} was refused: ${made.reason}`);
  }
  const keys: string[] = [];
  let bytes = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) keys.push(String(command[1] ?? ""));
    const replies = await pipeline(commands);
    for (const reply of replies as unknown[]) if (typeof reply === "string") bytes += Buffer.byteLength(reply);
    return replies;
  }) as typeof redis.pipeline;
  const store = await storeForPage("frontshop");
  is("the front page finds the store", Boolean(store), true);
  await readListings(store!, store!.catalog.items.slice(0, STORE_PAGE_SIZE).map((item) => item.id));
  redis.pipeline = pipeline;
  is("drawing the front page of a store with 2,000 products reads no page reading", keys.filter((key) => key.startsWith("nl:depth:")), []);
  console.log(`  (the front page read ${keys.length} keys, ${bytes} bytes of strings, for ${MAX_PRODUCTS} products)`);
  // Who may read a page reading at all: the studio's depth view, the AI route and the MCP tool, nothing a visitor draws.
  const root = process.cwd();
  const readers = [...files(join(root, "app")), ...files(join(root, "lib")), ...files(join(root, "components"))]
    .filter((path) => /\breadDepth(Exact)?\s*\(/.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .filter((path) => path !== join("lib", "page-depth.ts"))
    .sort();
  is("only the studio, the AI route and the MCP tool read a page reading", readers, ["app/api/store/ai/route.ts", "app/api/store/depth/route.ts", "lib/mcp-tools.ts"]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
