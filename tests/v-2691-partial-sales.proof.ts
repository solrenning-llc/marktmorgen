import { readVerified, verifiedFrom } from "@/lib/verified-numbers";
import type { StatsData } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const now = Date.UTC(2026, 10, 5, 12);
const statsId = "b".repeat(32);
const key = `nl:verified:${statsId}`;
const window = { visitors: 12, views: 20, checkouts: 4, sales: 2, cents: 500 };
const partial = {
  currency: "usd",
  sales: "ok",
  partial: true,
  totals: { d7: window, d30: window, d90: window },
  channels: { d30: [{ source: "direct", visits: 12, sales: 2, cents: 500 }] },
  products: [{ id: "guide", title: "A guide", d30: { sales: 2, cents: 500 } }],
  salesCountries: { d90: [{ country: "US", sales: 2 }] },
} as unknown as StatsData;

async function main() {
  redis.clear();
  part("A partial paid reading is unavailable, never a confirmed total");
  const record = verifiedFrom(partial, new Map(), now);
  is("the stored record does not certify partial sales", record.salesRead, false);
  is("partial window sales stay unknown", record.windows.d30.sales, null);
  is("partial window revenue stays unknown", record.windows.d30.cents, null);
  is("partial product totals are not shared", record.products, []);
  is("partial country shares are not shared", record.countries, []);

  await redis.pipeline([["SET", key, JSON.stringify(record)]]);
  const shared = await readVerified({ statsId });
  is("the reader cannot turn the partial copy back into confirmed sales", shared?.salesRead, false);
  done();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
