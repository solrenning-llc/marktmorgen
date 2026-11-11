/**
 * 630 [HN6](4), unit 2: the share of several affiliates at once, with undo,
 * through the real route. Only approved affiliates change; one already at the
 * share is left out of the undo; a share out of range is refused; the undo
 * puts back only shares still as the change left them; the studio says a
 * sale keeps the share it was made at.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readAffiliate } from "@/lib/affiliates";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "bulkrate@example.com";
  await claimHandle(owner, "bulkrate", "Bulk Rate", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Ratexxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_rate", subscriptionId: "sub_rate", active: true, tier: "creator", period: paidPeriod() });
  const person = (id: string, status: string, rate: number | null) => ({ id, email: `${id}@example.com`, code: `c${id}`, status, appliedAt: 1, decidedAt: 5, note: "", rate, paypal: "", share: null, cleared: null, by: null });
  const [a, b, c, d] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
  for (const p of [person(a, "approved", null), person(b, "approved", 40), person(c, "approved", 25), person(d, "pending", null)]) await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, p.id, JSON.stringify(p)]]);
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok?: boolean; error?: string; before?: { id: string; rate: number | null }[]; undone?: number };
  };
  const rate = async (id: string) => (await readAffiliate((await storeForEmail(owner))!, id))?.rate;

  part("Several at once");
  const changed = await post({ action: "bulk-rate", ids: [a, b, c, d], rate: 25 });
  is("approved ones change; one already at it and a pending one are left out", changed.before, [{ id: a, rate: null }, { id: b, rate: 40 }]);
  is("the shares are 25%", [await rate(a), await rate(b), await rate(c), await rate(d)], [25, 25, 25, null]);
  for (const bad of [0, 91, 7.5, "x"]) is(`share ${JSON.stringify(bad)} refused`, (await post({ action: "bulk-rate", ids: [a], rate: bad })).error, "rate");

  part("Undo");
  await post({ action: "rate", id: b, rate: 30 });
  const undone = await post({ action: "bulk-rate-undo", before: changed.before, rate: 25 });
  is("the one still at 25% goes back; the one changed by hand since stays", [undone.undone, await rate(a), await rate(b)], [1, null, 30]);
  const cleared = await post({ action: "bulk-rate", ids: [b, c], rate: null });
  is("empty gives the program's share back", [cleared.ok, await rate(b), await rate(c)], [true, null, null]);

  part("The studio");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("a labeled list and share, with the rule in words", studio.includes("Affiliates whose share changes") && studio.includes('htmlFor="share-many"') && studio.includes("It applies to sales from now on."), true);
  // Altered 2026-11-07 (rule 23): the undo says only what came back (lib/affiliate-bulk-words.ts undoWords).
  is("an undo in a status note", studio.includes('undoWords(') && studio.includes('role="status"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
