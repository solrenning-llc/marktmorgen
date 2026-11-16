/**
 * The cart-link builder settles at what it really read (Claude 4,
 * C4-20261106-1740-C3-104, #1928): when listing records grow between their
 * STRLEN and their GET, the bytes beyond what was taken before the read are
 * debited from the same studio count afterwards, with no new read, past the
 * figure if it must (C4-20261106-1810-C3-107): it was already spent. The next
 * opening is then refused as usual.
 */
import { cartLinkProducts, cartLinkUnits, CART_LINK_UNIT_BYTES } from "@/lib/cart-link-products";
import { KIND, productIds } from "@/lib/catalog";
import { addDraftProducts, claimHandle, ensureStatsId, setProductFile, setProductHidden, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "cart-link-settle@example.test";
  await claimHandle(owner, "cart-link-settle", "Synthetic store", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_CartLinkSettle", subscriptionId: "sub_CartLinkSettle", active: true, tier: "pro", period: paidPeriod() });
  const drafts = [
    ...Array.from({ length: 30 }, (_, i) => ({ title: "Free " + i, summary: "", priceCents: 0, link: "https://example.test/free" })),
    ...Array.from({ length: 24 }, (_, i) => ({ title: "Paid " + i, summary: "", priceCents: 1900, link: "https://example.test/paid" })),
  ];
  const added = await addDraftProducts(owner, drafts);
  if (!added.ok) throw new Error("fixture creation refused");
  let shop = (await storeForEmail(owner))!;
  for (const id of productIds(shop)) await setProductHidden(owner, id, false);
  shop = (await storeForEmail(owner))!;
  const paidIds = shop.catalog.items.filter((p) => (p.kind & KIND.paid) !== 0).map((p) => p.id);

  // The month's studio requests nearly all used: what the read is charged before it fits, and nothing more.
  const figure = allowanceFor(shop, "studio");
  const used = await allowanceUsed(shop, "studio");
  const spare = figure - used - 10;
  if (spare > 0) await takeAllowance(shop, "studio", spare);
  const base = redis.pipeline.bind(redis);
  const debits: number[] = [];
  let bytes = 0;
  let paidBeforeRead = -1;
  let grown = false;
  const spy = (async (commands: (string | number)[][]) => {
    const isGet = commands.some((c) => c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1])));
    if (isGet && paidBeforeRead < 0) paidBeforeRead = debits.reduce((a, b) => a + b, 0);
    const answer = await base(commands);
    commands.forEach((c, i) => {
      if (c[0] === "INCRBY" && String(c[1]).includes(":studio:")) debits.push(Number(c[2]));
      if (c[0] === "GET" && /^nl:catalog:.*:l:/.test(String(c[1]))) bytes += Buffer.byteLength(String(answer[i] ?? ""));
    });
    // Between the STRLENs and the GETs, every record grows (real writers, synthetic file metadata).
    if (!grown && commands.some((c) => c[0] === "STRLEN" && /^nl:catalog:.*:l:/.test(String(c[1])))) {
      grown = true;
      redis.pipeline = base;
      try {
        for (const id of paidIds) {
          const result = await setProductFile(owner, id, { pathname: `stores/synthetic/${id}/file.pdf`, name: "x".repeat(80_000) + ".pdf", bytes: 1, contentType: "application/pdf", addedAt: "2026-11-06" });
          if (!result.ok) throw new Error("synthetic growth refused");
        }
      } finally {
        redis.pipeline = spy;
      }
    }
    return answer;
  }) as typeof redis.pipeline;
  redis.pipeline = spy;
  let listed: Awaited<ReturnType<typeof cartLinkProducts>> = [];
  try {
    listed = await cartLinkProducts(shop);
  } finally {
    redis.pipeline = base;
  }
  const total = debits.reduce((a, b) => a + b, 0);
  console.log("CART_LINK_SETTLE", JSON.stringify({ debits, paidBeforeRead, bytes, listed: listed.length }));
  is("the records grew between their measure and their read, beyond what was taken before it", [grown, bytes > paidBeforeRead * CART_LINK_UNIT_BYTES], [true, true]);
  is("the builder still lists the 24 products", listed.length, 24);
  is("what was really read is taken in all, the difference after the read", total >= cartLinkUnits(2 * 24, bytes), true);
  const after = await allowanceUsed(shop, "studio");
  is("the figure now counts past its limit, what was really spent", after > figure, true);
  is("the next opening is refused as usual, with nothing read", (await cartLinkProducts(shop)).length, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
