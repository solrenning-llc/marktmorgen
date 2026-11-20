/**
 * A funnel's own address (app/[handle]/go/[funnel]/route.ts) is answered
 * with no-store, so every open reaches the function: it reads the store's
 * funnels and the listings of the funnel's product steps. Those reads are
 * the store's public requests (lib/traffic.ts, takePublicRequest), taken
 * before they are made, as a collection page takes its products'
 * (lib/page-read-rules.ts, collectionUnits): one for the funnels, and the
 * product steps' units before their listings. A store that cannot take them
 * sends nobody on and reads nothing more: "Try again later", 503, no-store.
 * Synthetic store, the in-memory database.
 */
import { NextRequest } from "next/server";
import { readFunnelInput } from "@/lib/page-funnel";
import { writePageFunnel } from "@/lib/page-funnel-store";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { GET as goRoute } from "@/app/[handle]/go/[funnel]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const OWNER = "go-funnel-paid@example.test";
let commands: string[][] = [];
let refuseCount = false;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Command[]) => {
  commands.push(...batch.map((c) => c.map(String)));
  const values = await real(batch);
  if (refuseCount && batch.some((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:"))) return ["not a count"];
  return values;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "gofunnel", "Go Funnel", "");
  await ensureStatsId(OWNER);
  const products = [];
  for (const name of ["One", "Two", "Three", "Four", "Five"]) {
    const made = await addProduct(OWNER, `Guide ${name}`, "", "0", null);
    if (!made.ok) throw new Error("product fixture");
    products.push(made.product.id);
  }
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const input = readFunnelInput({ name: "Launch", steps: products.map((id) => ({ kind: "product", id })) }, [], 1_760_000_000);
  if (!input.ok) throw new Error("funnel fixture");
  await writePageFunnel(statsId, input.funnel, [], ROOM);

  const go = async (slug: string) => {
    const response = await goRoute(new NextRequest(`https://marktmorgen.com/@gofunnel/go/${slug}?fbclid=x`), {
      params: Promise.resolve({ handle: "@gofunnel", funnel: slug }),
    });
    return { status: response.status, to: response.headers.get("location"), cache: response.headers.get("cache-control") ?? "" };
  };
  const taken = () => commands.filter((c) => c[0] === "INCRBY" && c[1].startsWith("nl:traffic:r:")).map((c) => Number(c[2]));
  const firstIndex = (test: (c: string[]) => boolean) => commands.findIndex(test);

  part("An open is paid by the store before its funnels and listings are read");
  commands = [];
  const opened = await go("launch");
  is("the funnel still opens", opened.status, 307);
  const units = taken();
  is("the store's count is taken", units.length >= 1, true);
  const charge = firstIndex((c) => c[0] === "INCRBY" && c[1].startsWith("nl:traffic:r:"));
  const funnels = firstIndex((c) => c[0] === "HVALS" && c[1].startsWith("nl:pfunnels:"));
  is("before the funnels are read", charge >= 0 && funnels >= 0 && charge < funnels, true);
  // One for the funnels, and five products at four a unit: two more, before the listings.
  is("the product steps are paid as a collection's products are (1 + 2 units)", units.reduce((a, b) => a + b, 0), 3);

  part("A store that cannot take one more request sends nobody on and reads nothing more");
  refuseCount = true;
  commands = [];
  const refused = await go("launch");
  refuseCount = false;
  is("503, never a redirect", [refused.status, refused.to], [503, null]);
  is("never kept", refused.cache.includes("no-store"), true);
  is("the funnels are not read", firstIndex((c) => c[0] === "HVALS" && c[1].startsWith("nl:pfunnels:")), -1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
