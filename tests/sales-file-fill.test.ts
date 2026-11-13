/**
 * The one-time filling of the sales file's short copies (lib/sales-file-fill.ts,
 * scripts/sales-file-fill.mjs) and the bound of a PayPal sale's line
 * (lib/paypal-sale-summary.ts PAYPAL_SUMMARY_BYTES):
 *
 *   - a counting run changes nothing and counts every sale and product
 *     without its copy; a writing run writes each, the same line settle writes
 *     and the same names a save writes, kept no longer than the record; a
 *     counting run after it says nothing is left;
 *   - a record that does not read is counted, never taken as filled; a page of
 *     stores that does not read throws (CX-123 rule 24);
 *   - the run says what it cost, from the commands and bytes it moved;
 *   - no line made from any record, however adversarial, passes its bound.
 */
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { MAX_STORE_NAMES_BYTES } from "@/lib/catalog";
import { PAYPAL_SUMMARY_BYTES, readSaleSummary, saleSummary } from "@/lib/paypal-sale-summary";
import { addFill, emptyFill, fillSalesFileStep, nothingLeft, spendOf, type FillStep } from "@/lib/sales-file-fill";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function run(write: boolean): Promise<FillStep> {
  let total = emptyFill();
  let cursor = "0";
  do {
    total = addFill(total, await fillSalesFileStep(cursor, write));
    cursor = total.next;
  } while (cursor !== "0");
  return total;
}

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "fill@example.com";
  await claimHandle(OWNER, "fillshop", "Fill Shop", "");
  await ensureStatsId(OWNER);
  const one = await addProduct(OWNER, "Bread \"Basics\"", "", "19", null);
  const two = await addProduct(OWNER, "Pastry", "", "29", null);
  if (!one.ok || !two.ok) throw new Error("no products");
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const namesKey = `nl:catalog:${store.catalog.id}:n`;
  const [savedOne, savedTwo] = await redis.pipeline([["HGET", namesKey, one.product.id], ["HGET", namesKey, two.product.id]]);
  // As products saved before the names existed.
  await redis.pipeline([["DEL", namesKey]]);

  const now = Math.floor(Date.now() / 1000);
  const orders = Array.from({ length: 3 }, (_, n) => `9F1234567890AB${n}`);
  const record = (order: string, n: number) => ({
    store: statsId, order, capture: `CAP${n}`, email: `old${n}@example.com`, product: one.product.id, cents: 1900, currency: "usd",
    at: now - 86_400 * (n + 1), handle: "fillshop", meta: { title: "Bread", channel: "x".repeat(200), bump: two.product.id },
  });
  for (const [n, order] of orders.entries()) {
    await redis.pipeline([
      ["SET", `nl:ppsell:paid:${order}`, JSON.stringify(record(order, n)), "EX", 400 * 86_400 - 86_400 * (n + 1)],
      ["ZADD", `nl:ppsell:sales:${statsId}`, String(record(order, n).at), order],
    ]);
  }

  part("A counting run changes nothing and counts what is missing");
  {
    const counted = await run(false);
    is("every sale and product without its copy counted", [counted.stores, counted.sales, counted.salesWithout, counted.products, counted.productsWithout], [1, 3, 3, 2, 2]);
    is("nothing written", [counted.salesWritten, counted.productsWritten], [0, 0]);
    const [line, names] = await redis.pipeline([["GET", `nl:ppsell:sum:${orders[0]}`], ["HLEN", namesKey]]);
    is("no line, no names", [line, names], [null, 0]);
    is("not yet nothing left", nothingLeft(counted), false);
    is("its cost said, from the commands and bytes it moved", counted.commands > 0 && counted.bytes > 0 && spendOf(counted) > 0, true);
  }

  part("A writing run writes each, as settle and a save would");
  {
    const wrote = await run(true);
    is("every one written", [wrote.salesWritten, wrote.productsWritten], [3, 2]);
    const [line, lineTtl, recordTtl] = await redis.pipeline([["GET", `nl:ppsell:sum:${orders[2]}`], ["TTL", `nl:ppsell:sum:${orders[2]}`], ["TTL", `nl:ppsell:paid:${orders[2]}`]]);
    is("the line settle writes for that record", line, saleSummary(record(orders[2], 2), orders[2], statsId));
    is("kept no longer than the record", Number(lineTtl) > 0 && Number(lineTtl) <= Number(recordTtl), true);
    const [namesOne, namesTwo] = await redis.pipeline([["HGET", namesKey, one.product.id], ["HGET", namesKey, two.product.id]]);
    is("the names a save writes", [namesOne, namesTwo], [savedOne, savedTwo]);
    const again = await run(false);
    is("a counting run after it: nothing left", [again.salesWithout, again.productsWithout, nothingLeft(again)], [0, 0, true]);
  }

  part("A record that does not read is counted, never taken as filled (rule 24)");
  {
    const bad = "9F1234567890ABX";
    await redis.pipeline([["SET", `nl:ppsell:paid:${bad}`, "{not json", "EX", 3600], ["ZADD", `nl:ppsell:sales:${statsId}`, String(now), bad]]);
    const counted = await run(true);
    is("counted unreadable, no line written", [counted.salesUnreadable, nothingLeft(counted), (await redis.pipeline([["GET", `nl:ppsell:sum:${bad}`]]))[0]], [1, false, null]);
    const original = redis.pipeline;
    redis.pipeline = (async (cmds: (string | number)[][]) => (cmds[0]?.[0] === "SCAN" ? ["0"] : original.call(redis, cmds))) as typeof redis.pipeline;
    let outcome = "";
    try {
      await fillSalesFileStep("0", false);
      outcome = "went on";
    } catch {
      outcome = "said";
    } finally {
      redis.pipeline = original;
    }
    is("a page of stores that does not read: said", outcome, "said");
  }

  part("No line passes its bound");
  {
    is("the bound is 1,038 bytes (tests/plan-cost-registry.ts, the studio line)", PAYPAL_SUMMARY_BYTES, 1_038);
    is("a store's names are at most 2,176,000 bytes", MAX_STORE_NAMES_BYTES, 2_176_000);
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    const units = ["\u0000", "\u001f", '"', "\\", "a", "é", "€", "😀", "\ud800", "\udfff", " ", "​"];
    const text = (n: number) => Array.from({ length: n }, () => units[Math.floor(rand() * units.length)]).join("");
    let widest = 0;
    let readBack = 0;
    for (let i = 0; i < 4_000; i += 1) {
      const order = `ORDER${String(i).padStart(10, "0")}${"Z".repeat(Math.floor(rand() * 22))}`;
      const line = saleSummary({
        store: "s", order, product: "p".repeat(1 + Math.floor(rand() * 64)), cents: Number.MAX_SAFE_INTEGER, currency: "eur", at: 999_999_999_999,
        email: text(Math.floor(rand() * 900)), off: Number.MIN_SAFE_INTEGER,
        meta: { title: text(Math.floor(rand() * 400)), option: text(Math.floor(rand() * 400)), kind: "plan", bump: "a".repeat(64), bump2: "b".repeat(64), bump3: "c".repeat(64) },
      }, order, "s");
      if (!line) throw new Error("no line");
      widest = Math.max(widest, new TextEncoder().encode(line).length);
      if (readSaleSummary(line, order, "s")) readBack += 1;
    }
    is(`the widest of 4,000 adversarial lines is within ${PAYPAL_SUMMARY_BYTES} bytes`, widest <= PAYPAL_SUMMARY_BYTES ? "within" : `${widest} bytes`, "within");
    is("and every one reads back", readBack, 4_000);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
