/**
 * CX-123 rule 24, A8 sweep of app/[handle]: a funnel's own address
 * (app/[handle]/go/[funnel]/route.ts) reads the store's funnels before it
 * sends anyone on. Only a confirmed reading in which no funnel has the address
 * leads to the store front. A reading out of shape (a reply of the wrong type,
 * a row that is not a funnel, no reply, a failed request) is unknown: the
 * route says "try again later" and redirects nowhere, never as if the funnel
 * did not exist. Synthetic store; one reply injected per case.
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
const OWNER = "a8-funnel-go@example.test";
const real = redis.pipeline.bind(redis);
let key = "";
let inject: ((values: unknown[]) => unknown[] | Promise<unknown[]>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
