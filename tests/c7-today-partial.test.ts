/**
 * Claude 7 numbers hunt (synthetic only): lib/stats.ts readToday read one page
 * of sales and dropped the reading's partial flag, so a store with more sales
 * today than one page (or a PayPal reading that failed) saw an undercount as
 * today's exact figure, kept for two minutes. Today's sales are now "not read
 * just now" (null), which the studio shows as a dash, never a number.
 */
import { readToday } from "@/lib/stats";
import { claimHandle, ensureStatsId, setPayPalSeller, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";
const order = (i: number) => `ORDER${String(i).padStart(8, "0")}`;
const record = (statsId: string, i: number, at: number) =>
  JSON.stringify({ store: statsId, order: order(i), capture: `CAP${i}`, email: `b${i}@example.com`, product: "prod000001", cents: 1_000, currency: "usd", at, handle: "harbor" });

async function main(): Promise<void> {
  const at = Math.floor(Date.now() / 1000);
  const paidKey = (o: string) => `nl:ppsell:paid:${o}`;
  part("Today's sales: a partial reading is not today's count");
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setPayPalSeller(OWNER, "7KNGBPH2U58GQ");
  const again = (await storeForEmail(OWNER))!;
  const id = again.statsId!;
  const cmds: (string | number)[][] = [];
  for (let i = 1; i <= 101; i += 1) cmds.push(["ZADD", `nl:ppsell:sales:${id}`, String(at), order(i)], ["SET", paidKey(order(i)), record(id, i, at)]);
  await redisPipeline(cmds);
  const today = await readToday(again);
  is("101 sales today, one page read: not read just now, never 100", today.sales, null);
  const cached = await redisPipeline([["GET", `nl:stats:${id}:today:${today.date}`]]);
  is("and no partial count is kept for the next two minutes", cached[0] ?? null, null);
  await redisPipeline([["DEL", ...Array.from({ length: 101 }, (_, i) => paidKey(order(i + 1)))], ["DEL", `nl:ppsell:sales:${id}`]]);
  for (let i = 1; i <= 3; i += 1) await redisPipeline([["ZADD", `nl:ppsell:sales:${id}`, String(at), order(i)], ["SET", paidKey(order(i)), record(id, i, at)]]);
  is("(control) three sales today, read whole, are three", (await readToday(again)).sales, { sales: 3, cents: 3_000 });


  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
