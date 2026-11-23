/**
 * #5285 row #2879, Claude 5's LEVE 2 (6701621505): where "next" leads from a funnel's page or product
 * (funnelHere, lib/page-funnel-store.ts). A product step the store still lists whose listing cannot be read is
 * unknown, never "a deleted product": "next" is never sent past it to a later step. Steps are decided in order, so
 * an open step before the unknown one is still where "next" leads, and a product really deleted is still passed
 * over. With "next" unknown, the page is still a step of its funnel (it is counted there), and it simply shows no
 * "next" button, as at the funnel's end.
 *
 * Synthetic store; the product records are read from Redis (the catalog's head is emptied) and one is failed.
 */
import { readFunnelInput } from "@/lib/page-funnel";
import { funnelHere, writePageFunnel } from "@/lib/page-funnel-store";
import { productSegment } from "@/lib/product-slug";
import { addProduct, claimHandle, ensureStatsId, removeProduct, setSitePages, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { readsKey } from "./listing-reads";

type Command = (string | number)[];
const OWNER = "funnel-here-unknown@example.test";
const real = redis.pipeline.bind(redis);
let failListing = "";
let garbleListing = "";
redis.pipeline = (async (batch: Command[]) => {
  if (failListing && batch.some((c) => readsKey(c, failListing))) throw new Error("synthetic Redis timeout");
  const values = await real(batch);
  if (garbleListing) {
    return values.map((value, i) => {
      const c = batch[i];
      if (c[0] === "GET" && String(c[1]) === garbleListing) return 7;
      if (c[0] === "MGET" && Array.isArray(value)) return value.map((v, j) => (String(c[j + 1]) === garbleListing ? 7 : v));
      return value;
    });
  }
  return values;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "fhunknown", "Funnel Here", "");
  await ensureStatsId(OWNER);
  const paid = await addProduct(OWNER, "Paid Guide", "", "19", null);
  const gone = await addProduct(OWNER, "Old Guide", "", "5", null);
  if (!paid.ok || !gone.ok) throw new Error("product fixture");
  await setSitePages(OWNER, [
    { id: "welcomepg1", slug: "welcome", title: "Welcome", nav: false, target: "", from: 0 },
    { id: "bonuspage1", slug: "bonus", title: "Bonus", nav: false, target: "", from: 0 },
  ]);
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const write = async (name: string, steps: { kind: "page" | "product"; id: string }[], before: Parameters<typeof writePageFunnel>[2]) => {
    const input = readFunnelInput({ name, steps }, before, 1_760_000_000);
    if (!input.ok) throw new Error("funnel fixture");
    return writePageFunnel(statsId, input.funnel, before, ROOM);
  };
  const paidThen = await write("Paid Then Bonus", [{ kind: "page", id: "welcomepg1" }, { kind: "product", id: paid.product.id }, { kind: "page", id: "bonuspage1" }], []);
  const bonusFirst = await write("Bonus First", [{ kind: "page", id: "welcomepg1" }, { kind: "page", id: "bonuspage1" }, { kind: "product", id: paid.product.id }], [paidThen]);
  const goneThen = await write("Gone Then Bonus", [{ kind: "page", id: "welcomepg1" }, { kind: "product", id: gone.product.id }, { kind: "page", id: "bonuspage1" }], [paidThen, bonusFirst]);
  if (!(await removeProduct(OWNER, gone.product.id)).ok) throw new Error("remove fixture");
  // A catalog larger than its head: each product's listing is read from Redis, not from the store record.
  for (const k of redis.keys()) {
    const [raw] = await real([["GET", k]]).catch(() => [null]);
    if (typeof raw !== "string" || !raw.includes('"catalog"') || !raw.includes('"fhunknown"')) continue;
    const value = JSON.parse(raw);
    if (!value.catalog?.head) continue;
    value.catalog.head = [];
    await real([["SET", k, JSON.stringify(value)]]);
  }
  const store = (await storeForEmail(OWNER))!;
  const listingKey = `nl:catalog:${store.catalog.id}:l:${paid.product.id}`;
  const paidPath = `/@fhunknown/p/${productSegment(paid.product)}`;
  const next = async (funnelId: string) => (await funnelHere(store, funnelId, "page", "welcomepg1"))?.next ?? null;

  part("Control: every listing reads");
  is("next is the paid product, with the funnel's mark", await next(paidThen.id), `${paidPath}?f=${paidThen.id}`);
  is("a product really deleted is passed over, to the page after it", await next(goneThen.id), `/@fhunknown/bonus?f=${goneThen.id}`);

  for (const [label, set] of [
    ["a failed read", () => { failListing = listingKey; }],
    ["a reply that is not a record", () => { garbleListing = listingKey; }],
  ] as [string, () => void][]) {
    part(`Unknown: the paid product's listing, ${label}`);
    set();
    const here = await funnelHere(store, paidThen.id, "page", "welcomepg1");
    is(`${label}: the page is still the funnel's first step, counted there`, [here?.funnel.id, here?.index], [paidThen.id, 0]);
    is(`${label}: next is unknown, never moved past the paid product to the bonus page`, here?.next ?? null, null);
    is(`${label}: an open page before it is still where next leads`, await next(bonusFirst.id), `/@fhunknown/bonus?f=${bonusFirst.id}`);
    is(`${label}: a product really deleted is still passed over`, await next(goneThen.id), `/@fhunknown/bonus?f=${goneThen.id}`);
    failListing = "";
    garbleListing = "";
  }

  part("Once the listing reads again");
  is("next is the paid product again", await next(paidThen.id), `${paidPath}?f=${paidThen.id}`);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
