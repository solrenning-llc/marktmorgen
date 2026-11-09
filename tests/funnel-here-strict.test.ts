/**
 * CX-123 rule 24, BAIXA item of the tolerant-reads inventory: where a visitor
 * goes after a funnel's step (lib/page-funnel-store.ts funnelHere) read the
 * later steps' products with `readListings(...).catch(() => [])`, the only
 * caller of stepStates without its strict mode. A product the store still
 * lists whose listing could not be read was taken for "a deleted product", so
 * the page's "next" link skipped it and sent the visitor to a later step, or
 * to none. Now stepStates always reads strictly: an unread listing throws,
 * funnelHere throws, and the pages that call it (each with `.catch(() => null)`)
 * show the page on its own, as for an unread funnel, never a wrong next step.
 * Synthetic store; one listing read made to fail per case.
 */
import { readFunnelInput } from "@/lib/page-funnel";
import { funnelHere, stepStates, writePageFunnel } from "@/lib/page-funnel-store";
import { addProduct, claimHandle, ensureStatsId, removeProduct, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const OWNER = "funnel-here-strict@example.test";
const real = redis.pipeline.bind(redis);
let failListing = "";
redis.pipeline = (async (batch: Command[]) => {
  if (failListing && batch.some((c) => c[0] === "GET" && c[1] === failListing)) throw new Error("synthetic Redis timeout");
  return real(batch);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "herestrict", "Here Strict", "");
  await ensureStatsId(OWNER);
  const first = await addProduct(OWNER, "Free Guide", "", "0", null);
  const middle = await addProduct(OWNER, "Paid Guide", "", "19", null);
  const last = await addProduct(OWNER, "Course", "", "99", null);
  const gone = await addProduct(OWNER, "Old Guide", "", "5", null);
  if (!first.ok || !middle.ok || !last.ok || !gone.ok) throw new Error("product fixture");
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const input = readFunnelInput({ name: "Path", steps: [first, middle, last].map((p) => ({ kind: "product", id: p.product.id })) }, [], 1_760_000_000);
  if (!input.ok) throw new Error("funnel fixture");
  const funnel = await writePageFunnel(statsId, input.funnel, [], ROOM);
  const withGone = readFunnelInput({ name: "Gone", steps: [first, gone, last].map((p) => ({ kind: "product", id: p.product.id })) }, [funnel], 1_760_000_000);
  if (!withGone.ok) throw new Error("funnel fixture");
  const goneFunnel = await writePageFunnel(statsId, withGone.funnel, [funnel], ROOM);
  if (!(await removeProduct(OWNER, gone.product.id)).ok) throw new Error("remove fixture");
  // A catalog larger than its head: each product's listing is read from Redis, not from the store record.
  for (const k of redis.keys()) {
    const [raw] = await real([["GET", k]]).catch(() => [null]);
    if (typeof raw !== "string" || !raw.includes('"catalog"') || !raw.includes('"herestrict"')) continue;
    const value = JSON.parse(raw);
    if (!value.catalog?.head) continue;
    value.catalog.head = [];
    await real([["SET", k, JSON.stringify(value)]]);
  }
  const store = (await storeForEmail(OWNER))!;
  const catalogId = store.catalog.id;

  part("Confirmed readings");
  const here = await funnelHere(store, funnel.id, "product", first.product.id);
  is("after the first step comes the second, with the funnel's mark", [here?.index, String(here?.next).includes(middle.product.id), String(here?.next).endsWith(`?f=${funnel.id}`)], [0, true, true]);
  const skip = await funnelHere(store, goneFunnel.id, "product", first.product.id);
  is("a product confirmed deleted is skipped, as before", String(skip?.next).includes(last.product.id), true);

  part("Unknown: the next step's listing cannot be read");
  failListing = `nl:catalog:${catalogId}:l:${middle.product.id}`;
  const unread = await funnelHere(store, funnel.id, "product", first.product.id).then((value) => (value ? `next ${value.next}` : "none"), () => "unknown");
  is("funnelHere throws, never sends the visitor past it to a later step", unread, "unknown");
  const states = await stepStates(store, { steps: funnel.steps }).then(() => "read", () => "unknown");
  is("stepStates reads strictly with no option", states, "unknown");
  failListing = "";
  const again = await funnelHere(store, funnel.id, "product", first.product.id);
  is("once the listing reads again, the next step is the second", String(again?.next).includes(middle.product.id), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
