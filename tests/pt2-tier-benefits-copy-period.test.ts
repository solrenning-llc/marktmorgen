/**
 * Claude 4 (LEVE 2, 6717420460) and Claude 1 (review of ed0b3ce9) on #3014: a person's copy showed a monthly
 * benefit's period as the key it is kept under ("m<seconds>"), and a mark kept under a key in another shape was copied
 * raw. A month is now shown as the date it began, and a mark whose key is not benefit:subscription:period in its exact
 * shape makes the copy unknown (it throws), never copied as it is. The fix is the one Claude 6 wrote on
 * claude6/c5-fix-3014 (2befe4b1f), carried to this head.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { addBenefit, benefitMarksOf } from "@/lib/tier-benefits";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const owner = "copy-period@example.com";
const person = "d".repeat(32);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(owner, "copyperiod", "Copy Period", "");
  await ensureStatsId(owner);
  const store = (await storeForEmail(owner))!;
  const added = await addBenefit(store, { product: "p0000000000001", text: "A monthly call", cadence: "monthly" }, 1_790_000_000_000).catch(() => null);
  const id = added && added.ok ? added.benefit.id : "b000000000001";
  const marks = `nl:tben:given:${store.statsId}:${person}`;
  const mark = JSON.stringify({ at: 1_790_000_300, by: "team@example.com" });

  part("A monthly period is shown as the date its month began");
  await redis.pipeline([["HSET", marks, `${id}:sub_abcdef123456:m1790000000`, mark]]);
  const copy = await benefitMarksOf(store, person).catch((e: unknown) => `threw ${String(e)}`);
  is("the period is a date, never the key", Array.isArray(copy) ? copy.map((c) => c.period) : copy, [new Date(1_790_000_000 * 1000).toISOString()]);

  part("A mark kept under a key in another shape is not copied raw");
  await redis.pipeline([["HSET", marks, `${id}:not-a-sub:whenever`, mark]]);
  is("the copy throws, so it is said as not whole", await benefitMarksOf(store, person).then(() => "copied", () => "threw"), "threw");
  done();
}

void main();
