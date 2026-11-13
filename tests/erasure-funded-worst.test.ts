/**
 * The automatic ceiling of the company's funded exposure `erasure_overflow`
 * (owner's decision DONO-20261113-DEC-1, 13 November 2026; lib/erasure-funded.ts):
 * the largest erasure there can be, held here in commands, bytes, studio units
 * and dollars, and in docs/funded-exposure-review.md.
 *
 *   - every count of the worst size is its own module's cap;
 *   - its units cover what an erasure of that size sends, as tests/person-erasure.test.ts holds for every size;
 *   - one case costs the company at most $3.07, and a month of it is unknown (null, never zero) until a case cap is reviewed;
 *   - a size past the ceiling is unknown: refused as "unavailable", nothing counted for the company or the store.
 *
 * Synthetic: an in-memory Redis; nothing leaves the process.
 */
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ERASE_FUNDED_SCOPE, ERASE_WORST_SIZE, ERASE_WORST_UNITS, erasureFundedMonth, takeErasureUnits } from "@/lib/erasure-funded";
import { erasureUnits, erasureWork } from "@/lib/erasure-rules";
import { EXPOSURE_SCOPES } from "@/lib/funded-exposure-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_LESSONS } from "@/lib/course";
import { MAX_DEALS } from "@/lib/crm-rules";
import { MAX_CONVERSATIONS as INBOX } from "@/lib/inbox-rules";
import { MAX_CONVERSATIONS as DMS, MAX_REQUESTS } from "@/lib/community-dm";
import { MAX_CHAT_KEPT } from "@/lib/community-chat-rules";
import { MAX_KEPT_EVENTS } from "@/lib/community-text";
import { LEGACY_SCAN } from "@/lib/certificate";
import { ERASE_ROLE_CALLS } from "@/lib/discord-access";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { ERASURE_OVERFLOW, UNIT_COST, erasureOverflowCaseUsd, erasureOverflowMonthlyUsd, request } from "./plan-cost-registry";

async function main(): Promise<void> {
  part("The largest erasure there can be");
  is("its counts are each module's own cap", ERASE_WORST_SIZE, {
    products: MAX_PRODUCTS,
    courses: MAX_PRODUCTS,
    lessons: MAX_PRODUCTS * MAX_LESSONS,
    deals: MAX_DEALS,
    conversations: INBOX,
    dmConversations: DMS + MAX_REQUESTS,
    roomMessages: MAX_CHAT_KEPT,
    events: MAX_KEPT_EVENTS,
    certificates: MAX_PRODUCTS * LEGACY_SCAN,
  });
  const work = erasureWork(ERASE_WORST_SIZE);
  is("what it sends at the most", work, { commands: 462_850, bytes: 970_515_000 });
  is("the ceiling of one erasure, in studio units", ERASE_WORST_UNITS, 42_569);
  is("is erasureUnits of the worst size", ERASE_WORST_UNITS, erasureUnits(ERASE_WORST_SIZE));
  const cost = request("write", work.commands, work.bytes) + ERASE_ROLE_CALLS * request("wait", 0, 0);
  is("its units cover what it sends, at the studio unit's price", ERASE_WORST_UNITS * UNIT_COST.studio >= cost, true);
  is("a store of MAX_PRODUCTS products and no course takes far less", erasureUnits({ products: MAX_PRODUCTS }), 1_810);
  is("and every size under the caps stays under the ceiling", erasureUnits({ ...ERASE_WORST_SIZE, certificates: 0 }) < ERASE_WORST_UNITS, true);

  part("The company's exposure for it");
  is("it is one of the funded exposure scopes", EXPOSURE_SCOPES.includes(ERASE_FUNDED_SCOPE as (typeof EXPOSURE_SCOPES)[number]), true);
  is("the registry line prices the same ceiling", ERASURE_OVERFLOW.unitsPerCase, ERASE_WORST_UNITS);
  const usd = erasureOverflowCaseUsd();
  is("one case at its ceiling, in dollars", Math.round(usd * 10_000) / 10_000, 3.0669);
  is("never more than $3.07", usd <= 3.07, true);
  is("a month without a reviewed case cap is unknown, never zero", erasureOverflowMonthlyUsd(null, 0), null);
  is("a month counted above its cap is unknown", erasureOverflowMonthlyUsd(10, 11), null);
  is("a month at a reviewed cap is the cap's cases at the ceiling, and its counts", Math.round((erasureOverflowMonthlyUsd(10, 3) ?? 0) * 100) / 100, Math.round(10 * usd * 100) / 100);
  const doc = readFileSync("docs/funded-exposure-review.md", "utf8");
  is("the review says the decision", doc.includes("DONO-20261113-DEC-1"), true);
  is("the review says the ceiling in units", doc.includes("42,569 studio units"), true);
  is("the review says the ceiling in dollars", doc.includes("$3.07"), true);

  part("Past the ceiling is unknown");
  redis.clear();
  const owner = "ceiling-owner@example.com";
  await claimHandle(owner, "ceiling-shop", "Ceiling Shop", "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: "cus_ceiling", subscriptionId: "sub_ceiling", active: true, tier: "creator" });
  await setSubscription(owner, { active: false });
  const store = await storeForEmail(owner);
  if (!store) throw new Error("no store");
  const month = new Date().toISOString().slice(0, 7);
  const over = await takeErasureUnits(store, ERASE_WORST_UNITS + 1, ERASE_WORST_UNITS + 1, true);
  is("an erasure past the ceiling is refused as unavailable", over.ok ? "ok" : over.reason, "unavailable");
  is("nothing is counted for the company", await erasureFundedMonth(month), { month, cases: 0, units: 0 });
  const at = await takeErasureUnits(store, ERASE_WORST_UNITS, ERASE_WORST_UNITS, true);
  is("one at the ceiling is taken", at.ok ? [at.fromStore, at.fromCompany] : at.reason, [100, ERASE_WORST_UNITS - 100]);
  is("and counted as one case", await erasureFundedMonth(month), { month, cases: 1, units: ERASE_WORST_UNITS - 100 });

  done();
}

void main();
