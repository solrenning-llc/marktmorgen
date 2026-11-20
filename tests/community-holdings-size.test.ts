/**
 * Codex X6 on #3395 (LOW): the kept reading of what a member holds (lib/community-access.ts, holdingsKey `:h:`) was
 * registered at 512 bytes while its real worst is far more (about 5.8 KB with ten-character ids). Its bound is now a
 * figure of the code, HOLDINGS_RECORD_BYTES, from the community's own caps (200 access products of at most 40
 * characters, lib/community.ts; a search page's SEARCH_PAGE products of at most 64, lib/catalog.ts SAFE_ID); a reading
 * that would take more is never kept, so no key holds more; and the store-data registry counts it at that figure.
 * Synthetic store, stand-in Redis, a stubbed Stripe that answers every list empty.
 */
import { addProduct, claimHandle, ensureStatsId, setCommunity, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { freshConfig } from "@/lib/community";
import { emailKey } from "@/lib/learn";
import { SEARCH_PAGE } from "@/lib/community-search";
import * as access from "@/lib/community-access";
import { FAMILIES } from "./store-data-registry";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const a = access as unknown as { HOLDINGS_RECORD_BYTES?: number; holdingsOf: typeof access.holdingsOf };
const OWNER = "holdings-size-owner@example.com";
const MEMBER = "holdings-size-member@example.com";
const bytes = (text: string) => new TextEncoder().encode(text).length;
const idOf = (n: number, length: number) => `${String(n).padStart(4, "0")}${"x".repeat(length - 4)}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_holdings_size_only_a_stand_in";

  part("The bound covers the worst record the caps allow");
  // The record holdingsOf writes, at its largest: every id at its longest, held and passed over together as many as
  // asked (they are apart), a reading not whole with its reason, the largest version.
  const asked = [...Array.from({ length: 200 }, (_, i) => idOf(i, 40)), ...Array.from({ length: SEARCH_PAGE }, (_, i) => idOf(1000 + i, 64))];
  const worst = JSON.stringify({ v: Number.MAX_SAFE_INTEGER, ids: asked, held: asked.slice(0, 110), lasting: true, why: "refused", s: asked.slice(110) });
  is("HOLDINGS_RECORD_BYTES is a figure of the code", typeof a.HOLDINGS_RECORD_BYTES, "number");
  is(`the worst record (${bytes(worst)} bytes) fits it`, bytes(worst) <= (a.HOLDINGS_RECORD_BYTES ?? 0), true);

  part("The registry counts the kept reading at that figure");
  const family = (FAMILIES as unknown as Record<string, { parts?: { bytes?: unknown; group?: string }[] }>)["nl:cm:@lib/community-access.ts"];
  const parts = (family?.parts ?? []).filter((p) => typeof p.bytes === "number" && p.group !== undefined);
  is("the page's and the search's parts", parts.length, 2);
  is("each at HOLDINGS_RECORD_BYTES", parts.map((p) => p.bytes), [a.HOLDINGS_RECORD_BYTES, a.HOLDINGS_RECORD_BYTES]);

  part("A reading over the bound is never kept; one within it is");
  await claimHandle(OWNER, "holdsize", "Holdings Size", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHoldSize01", true);
  await setSubscription(OWNER, { customerId: "cus_HoldSize0001", subscriptionId: "sub_HoldSize0001", active: true, period: paidPeriod() });
  const paid = await addProduct(OWNER, "Members", "", "9", null);
  if (!paid.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const base = (await storeForEmail(OWNER))!;
  const id = base.community!.id;
  const config = { ...freshConfig("Holdings Size"), access: [paid.product.id] };
  const key = `nl:cm:${id}:h:${emailKey(MEMBER)}`;
  await a.holdingsOf(base, config, MEMBER);
  is("control: a small reading is kept", typeof (await redis.pipeline([["GET", key]]))[0], "string");
  await redis.pipeline([["DEL", key]]);
  // More products than the caps let in, every id at its longest (as a store record could carry): its record is over.
  const many = Array.from({ length: 400 }, (_, i) => idOf(i, 64));
  const big = { ...base, catalog: { ...base.catalog, items: [...base.catalog.items, ...many.map((pid) => ({ id: pid, kind: 0, options: [] }))] } };
  const read = await a.holdingsOf(big, config, MEMBER, many);
  is("the reading itself is still answered", read.whole, true);
  is("but it is not kept", (await redis.pipeline([["GET", key]]))[0], null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
