/**
 * A campaign landing's save and its list read the product's page, which can weigh hundreds of kilobytes: it is
 * measured first and its reading counted, past the request's own unit, in both (Claude 5's return on #1950), and a
 * page grown between the measure and the read is refused, never read past what was counted. The real route, session
 * and store (MemoryRedis); no outside request.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/campaign-landing/route";
import { AD_CONTEXT_UNITS, STUDIO_REQUEST_BYTES, pageReadUnits } from "@/lib/ad-context";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { parsePage } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "landing-page-cost@example.test";
  await claimHandle(owner, "landingpagecost", "Landing Page Cost", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_landingpage", subscriptionId: "sub_landingpage", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Knife Skills", "", "40");
  const product = made.ok ? made.product.id : "";
  const store = (await storeForEmail(owner))!;
  const blocks = [{ id: "hero0001", kind: "hero", headline: "Knife Skills", sub: "", media: "none", video: null }, ...Array.from({ length: 25 }, (_, i) => ({ id: `text${String(i).padStart(4, "0")}`, kind: "text", heading: "A part", body: "€".repeat(3_000) }))];
  await writePage(store.statsId!, product, parsePage({ blocks }), store);
  const [kept] = (await redis.pipeline([["STRLEN", `nl:product:page:${store.statsId}:${product}`]])) as number[];
  is("(a page of more than 200 kB is kept)", kept > 200_000, true);

  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const pipe = redis.pipeline.bind(redis);
  let moved = 0;
  const measuring = () => {
    moved = 0;
    redis.pipeline = (async (cs: (string | number)[][]) => {
      const replies = await pipe(cs);
      moved += Buffer.byteLength(JSON.stringify(cs)) + Buffer.byteLength(JSON.stringify(replies ?? null));
      return replies;
    }) as typeof redis.pipeline;
  };
  const save = () =>
    POST(new NextRequest("https://marktmorgen.com/api/store/campaign-landing", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "save", product, campaign: "spring-sale", headline: "Cook a real dinner in twenty minutes", text: "A short course on knife skills.", button: "Start cooking" }) }));
  const list = () => GET(new NextRequest(`https://marktmorgen.com/api/store/campaign-landing?product=${product}`, { headers: { cookie } }));

  part("The save");
  let before = await allowanceUsed(store, "studio");
  measuring();
  const saved = await save();
  redis.pipeline = pipe;
  is("saved", saved.status, 200);
  const saveUnits = (await allowanceUsed(store, "studio")) - before;
  is("the page's reading was counted with the reviews', before reading", saveUnits, 1 + AD_CONTEXT_UNITS + pageReadUnits(kept));
  is("what it moved fits what it was counted at", moved <= saveUnits * STUDIO_REQUEST_BYTES, true);

  part("The list");
  before = await allowanceUsed(store, "studio");
  measuring();
  const listed = await list();
  redis.pipeline = pipe;
  is("listed", listed.status, 200);
  const listUnits = (await allowanceUsed(store, "studio")) - before;
  is("the page's reading was counted, past the request's own unit", listUnits, 1 + pageReadUnits(kept));
  is("what it moved fits what it was counted at", moved <= listUnits * STUDIO_REQUEST_BYTES, true);

  part("The page grows between its measure and its read");
  let grown = false;
  redis.pipeline = (async (cs: (string | number)[][]) => {
    if (!grown && cs.some((c) => c[0] === "GETRANGE")) {
      grown = true;
      await writePage(store.statsId!, product, parsePage({ blocks: [...blocks, { id: "textmore", kind: "text", heading: "More", body: "€".repeat(3_000) }] }), store);
    }
    return pipe(cs);
  }) as typeof redis.pipeline;
  const late = await list();
  redis.pipeline = pipe;
  is("refused as changed, never read past what was counted", [late.status, ((await late.json()) as { error?: string }).error], [409, "changed"]);
  is("no outside request", outside, 0);
  done();
}
void main();
