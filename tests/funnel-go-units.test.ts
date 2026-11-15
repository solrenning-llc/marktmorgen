/**
 * MM-SA-53 (docs/security-audit-2026-10-28.md), item /go/[funnel]: a funnel's
 * own address (app/[handle]/go/[funnel]/route.ts) is an entry page like the
 * others, so it takes one of the store's public requests before it reads the
 * store's funnels and their products, as the store's other entry pages do
 * (lib/traffic.ts, takePublicRequest). A store whose month of public requests
 * is spent reads nothing more and sends the visitor to its front page, which
 * says it is resting.
 *
 * One request is enough: measured at its worst (MAX_PAGE_FUNNELS funnels of
 * MAX_FUNNEL_PAGES product steps each, the last one opened), the hop costs a
 * fifth of a later page (tests/traffic-cost.ts, laterPageCost), the price of
 * one public request; this test holds it there.
 */
import { NextRequest } from "next/server";
import { MAX_FUNNEL_PAGES, MAX_PAGE_FUNNELS, readFunnelInput } from "@/lib/page-funnel";
import { writePageFunnel } from "@/lib/page-funnel-store";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { takePublicRequest } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { GET as goRoute } from "@/app/[handle]/go/[funnel]/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { paidPeriod } from "./billing-period-fixture";
import { apiReadCost } from "./plan-cost-registry";
import { laterPageCost } from "./traffic-cost";

type Command = (string | number)[];
const OWNER = "funnel-units@example.test";
const CALL = 0.6 / 1_000_000;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "funnelunits", "Funnel Units", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_FunnelUnits1", subscriptionId: "sub_FunnelUnits1", active: true, tier: "pro", period: paidPeriod() });
  const ids: string[] = [];
  for (let i = 0; i < MAX_FUNNEL_PAGES; i += 1) {
    const made = await addProduct(OWNER, `Product number ${i} with a long title for its bytes`, "x".repeat(400), "19", null);
    if (!made.ok) throw new Error("product fixture");
    ids.push(made.product.id);
  }
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  for (let f = 0; f < MAX_PAGE_FUNNELS; f += 1) {
    const input = readFunnelInput({ name: `Launch ${f}`, steps: ids.map((id) => ({ kind: "product", id })) }, [], 1_760_000_000 + f);
    if (!input.ok) throw new Error("funnel fixture");
    await writePageFunnel(statsId, input.funnel, [], ROOM);
  }

  const real = redis.pipeline.bind(redis);
  const seen = { commands: 0, trips: 0, bytes: 0, funnels: 0 };
  redis.pipeline = (async (batch: Command[]) => {
    seen.commands += batch.length;
    seen.trips += 1;
    if (batch.some((c) => c[0] === "HVALS" && String(c[1]).startsWith("nl:pfunnels:"))) seen.funnels += 1;
    const values = await real(batch);
    seen.bytes += JSON.stringify(values).length;
    return values;
  }) as typeof redis.pipeline;
  const go = async (slug: string) => {
    Object.assign(seen, { commands: 0, trips: 0, bytes: 0, funnels: 0 });
    const response = await goRoute(new NextRequest(`https://marktmorgen.com/@funnelunits/go/${slug}`), { params: Promise.resolve({ handle: "@funnelunits", funnel: slug }) });
    return [response.status, response.headers.get("location")];
  };
  const counted = async () => {
    const [, keys] = (await real([["SCAN", 0, "MATCH", "nl:traffic:r:*", "COUNT", 1000]]))[0] as [string, string[]];
    return keys.length ? Number((await real([["GET", keys[0]]]))[0]) || 0 : 0;
  };

  part("A funnel's address takes one of the store's public requests");
  const before = await counted();
  const opened = await go("launch-9");
  is("the visitor goes on to the funnel's first step", [opened[0], String(opened[1]).includes("/@funnelunits/p/")], [307, true]);
  is("one public request counted", (await counted()) - before, 1);

  part("Its worst read is inside the price of that one request");
  const hop = apiReadCost({ commands: seen.commands, bytes: seen.bytes, sent: 500, stripePages: 0, roundTrips: seen.trips } as never) + CALL;
  is(`${seen.commands} commands and ${seen.bytes} bytes read, under a later page`, hop <= laterPageCost(), true);

  part("A store whose month of public requests is spent reads no funnel");
  const store = (await storeForEmail(OWNER))!;
  const limit = publicVisitLimit(requestLimitFor(store));
  await takePublicRequest(store, "public", Date.now(), Math.max(1, limit - (await counted())), { shared: true });
  const resting = await go("launch-9");
  is("sent to the store's front page, which says it is resting", resting, [307, "https://marktmorgen.com/@funnelunits"]);
  is("and the funnels were not read", seen.funnels, 0);

  redis.pipeline = real;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
