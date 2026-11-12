/**
 * CX-123 rule 24, A8 sweep of app/[handle]: a funnel's own address
 * (app/[handle]/go/[funnel]/route.ts) reads the store's funnels before it
 * sends anyone on. Only a confirmed reading in which no funnel has the address
 * leads to the store front. A reading out of shape (a reply of the wrong type,
 * a row that is not a funnel, no reply, a failed request) is unknown: the
 * route says "try again later" and redirects nowhere, never as if the funnel
 * did not exist. The same holds for each product step: a product the store
 * still lists whose listing cannot be read is unknown, never "a deleted
 * product", so the visitor is neither sent to the store front nor moved past
 * it to a later step. Synthetic store; one reply injected per case.
 */
import { NextRequest } from "next/server";
import { readFunnelInput } from "@/lib/page-funnel";
import { writePageFunnel } from "@/lib/page-funnel-store";
import { addProduct, claimHandle, ensureStatsId, removeProduct, storeForEmail } from "@/lib/store";
import { GET as goRoute } from "@/app/[handle]/go/[funnel]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Command = (string | number)[];
const OWNER = "a8-funnel-go@example.test";
const real = redis.pipeline.bind(redis);
let key = "";
let inject: ((values: unknown[]) => unknown[] | Promise<unknown[]>) | null = null;
let failListing = "";
redis.pipeline = (async (batch: Command[]) => {
  if (failListing && batch.some((c) => c[0] === "GET" && c[1] === failListing)) throw new Error("synthetic Redis timeout");
  const values = await real(batch);
  if (inject && batch.some((c) => c[0] === "HVALS" && c[1] === key)) return inject(values);
  return values;
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "a8funnel", "A8 Funnel", "");
  await ensureStatsId(OWNER);
  const guide = await addProduct(OWNER, "Free Guide", "", "0", null);
  if (!guide.ok) throw new Error("product fixture");
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  key = `nl:pfunnels:${statsId}`;
  const input = readFunnelInput({ name: "Launch", steps: [{ kind: "product", id: guide.product.id }] }, [], 1_760_000_000);
  if (!input.ok) throw new Error("funnel fixture");
  const funnel = await writePageFunnel(statsId, input.funnel, [], ROOM);

  const go = async (slug: string) => {
    const response = await goRoute(new NextRequest(`https://marktmorgen.com/@a8funnel/go/${slug}`), {
      params: Promise.resolve({ handle: "@a8funnel", funnel: slug }),
    });
    return [response.status, response.headers.get("location"), response.headers.get("cache-control")];
  };

  part("Confirmed readings");
  const opened = await go("launch");
  is("a funnel on sends the visitor to its first step, with its mark", [opened[0], String(opened[1]).endsWith(`?f=${funnel.id}`)], [307, true]);
  is("an address no funnel has leads to the store", (await go("nothing")).slice(0, 2), [307, "https://marktmorgen.com/@a8funnel"]);

  const cases: [string, (values: unknown[]) => unknown[] | Promise<unknown[]>][] = [
    ["HVALS answered with a string", () => ["launch"]],
    ["HVALS answered with a number", () => [3]],
    ["a row that is not text", (values) => [[...(values[0] as unknown[]), 7]]],
    ["a row that is half a record", () => [["{\"id\":"]]],
    ["a row that is not a funnel", () => [[JSON.stringify({ id: "x" })]]],
    ["no reply at all", () => []],
    ["a failed request", () => Promise.reject(new Error("synthetic Redis failure"))],
  ];
  for (const [name, reply] of cases) {
    part(`Unknown: ${name}`);
    inject = reply;
    const answer = await go("launch");
    is("says try again later, never sent to the store as an address no funnel has", answer, [503, null, "no-store"]);
    inject = null;
  }
  is("once the reading is whole again, the funnel opens", (await go("launch"))[0], 307);

  // Two more funnels: a paid product step first, the free guide after it; and one whose only product was deleted.
  const paid = await addProduct(OWNER, "Paid Guide", "", "19", null);
  const gone = await addProduct(OWNER, "Old Guide", "", "5", null);
  if (!paid.ok || !gone.ok) throw new Error("product fixture");
  const two = readFunnelInput({ name: "Two Steps", steps: [{ kind: "product", id: paid.product.id }, { kind: "product", id: guide.product.id }] }, [funnel], 1_760_000_000);
  if (!two.ok) throw new Error("funnel fixture");
  const twoFunnel = await writePageFunnel(statsId, two.funnel, [funnel], ROOM);
  const old = readFunnelInput({ name: "Old", steps: [{ kind: "product", id: gone.product.id }] }, [funnel, twoFunnel], 1_760_000_000);
  if (!old.ok) throw new Error("funnel fixture");
  await writePageFunnel(statsId, old.funnel, [funnel, twoFunnel], ROOM);
  if (!(await removeProduct(OWNER, gone.product.id)).ok) throw new Error("remove fixture");
  // A catalog larger than its head: each product's listing is read from Redis, not from the store record.
  for (const k of redis.keys()) {
    const [raw] = await real([["GET", k]]).catch(() => [null]);
    if (typeof raw !== "string" || !raw.includes('"catalog"') || !raw.includes('"a8funnel"')) continue;
    const value = JSON.parse(raw);
    if (!value.catalog?.head) continue;
    value.catalog.head = [];
    await real([["SET", k, JSON.stringify(value)]]);
  }
  const catalogId = (await storeForEmail(OWNER))!.catalog.id;

  part("Confirmed product steps");
  const both = await go("two-steps");
  is("both listings read: the first step, with the funnel's mark", [both[0], String(both[1]).includes(`/p/paid-guide-${paid.product.id}`), String(both[1]).endsWith(`?f=${twoFunnel.id}`)], [307, true, true]);
  is("a funnel whose only product was deleted leads to the store", (await go("old")).slice(0, 2), [307, "https://marktmorgen.com/@a8funnel"]);

  part("Unknown: a product step's listing cannot be read");
  failListing = `nl:catalog:${catalogId}:l:${guide.product.id}`;
  is("its only step unread: try again later, never the store front", await go("launch"), [503, null, "no-store"]);
  failListing = `nl:catalog:${catalogId}:l:${paid.product.id}`;
  is("the first step unread: try again later, never the store front or the next step", await go("two-steps"), [503, null, "no-store"]);
  failListing = "";
  is("once the listing reads again, the funnel opens", (await go("two-steps"))[0], 307);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
