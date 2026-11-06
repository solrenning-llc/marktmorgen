/**
 * Review of #2879 (d9d58169), rule 30 in the same route: after the strict
 * funnel read, app/[handle]/go/[funnel]/route.ts calls stepStates(store,
 * funnel) without strictProducts, so a product step whose listing cannot be
 * read (readListings throws, caught to []) reads as "a deleted product": the
 * step is closed and, with no other open step, the visitor is sent to the
 * store front (307) — the same "unknown -> store" the PR removes for the
 * funnel list. With a later open step, the visitor skips the unread one.
 * Synthetic store; the listing GET of a product beyond the catalog head fails.
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
const OWNER = "rev2879-steps@example.test";
const real = redis.pipeline.bind(redis);
let failListing = "";
redis.pipeline = (async (batch: Command[]) => {
  if (failListing && batch.some((c) => c[0] === "GET" && c[1] === failListing)) throw new Error("synthetic Redis timeout");
  return real(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "rev2879", "Rev 2879", "");
  await ensureStatsId(OWNER);
  const guide = await addProduct(OWNER, "Paid Guide", "", "19", null);
  if (!guide.ok) throw new Error("product fixture");
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const input = readFunnelInput({ name: "Launch", steps: [{ kind: "product", id: guide.product.id }] }, [], 1_760_000_000);
  if (!input.ok) throw new Error("funnel fixture");
  await writePageFunnel(statsId, input.funnel, [], ROOM);

  // A catalog larger than its head: this product's listing is read from Redis, not from the store record.
  const keys = redis.keys();
  for (const k of keys) {
    const [raw] = await real([["GET", k]]).catch(() => [null]);
    if (typeof raw !== "string" || !raw.includes('"catalog"') || !raw.includes('"rev2879"')) continue;
    const value = JSON.parse(raw);
    if (!value.catalog?.head) continue;
    value.catalog.head = [];
    await real([["SET", k, JSON.stringify(value)]]);
  }
  const go = async () => {
    const r = await goRoute(new NextRequest("https://marktmorgen.com/@rev2879/go/launch"), { params: Promise.resolve({ handle: "@rev2879", funnel: "launch" }) });
    return [r.status, r.headers.get("location")];
  };
  part("Control: the listing reads, the funnel opens its product step");
  const ok = await go();
  is("307 to the product step", [ok[0], String(ok[1]).includes("/p/")], [307, true]);

  part("The product step's listing cannot be read just now");
  failListing = `nl:catalog:${store.catalog.id}:l:${guide.product.id}`;
  is("says try again later, never sends the visitor to the store front", await go(), [503, null]);
  done();
}

main().catch((error) => { console.error(error); process.exit(1); });
