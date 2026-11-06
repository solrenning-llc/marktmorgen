/**
 * 630 [HN6](4), unit 1: several applications approved or declined at once,
 * with undo, through the real route (app/api/store/affiliates/route.ts) and
 * lib/affiliates.ts decideMany/undoMany. Only pending applications are
 * touched; the undo puts back exactly those still as the press left them,
 * within ten minutes, never one decided by hand since and never anything
 * that was not pending; the studio offers it with words.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { BULK_UNDO_MS, readAffiliate, undoMany } from "@/lib/affiliates";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "bulk@example.com";
  await claimHandle(owner, "bulkshop", "Bulk Shop", "");
  const statsId = (await ensureStatsId(owner))!.statsId!;
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Bulkxxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_bulk", subscriptionId: "sub_bulk", active: true, tier: "creator", period: paidPeriod() });
  const person = (id: string, status: string) => ({ id, email: `${id}@example.com`, code: `c${id}`, status, appliedAt: 1, decidedAt: status === "pending" ? 0 : 5, note: "", rate: null, paypal: "", share: null, cleared: null, by: null });
  const ids = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
  for (const [i, id] of ids.entries()) await redis.pipeline([["HSET", `nl:aff:${statsId}:people`, id, JSON.stringify(person(id, i === 3 ? "declined" : "pending"))]]);
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>) => {
    const response = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return (await response.json()) as { ok?: boolean; error?: string; before?: { id: string; status: string; decidedAt: number }[]; undone?: number };
  };
  const store = async () => (await storeForEmail(owner))!;
  const status = async (id: string) => (await readAffiliate(await store(), id))?.status;

  part("Several at once");
  const declined = await post({ action: "bulk", decision: "decline", ids: [ids[0], ids[1], ids[3], ids[0]] });
  is("only pending ones are decided, each once", declined.before?.map((b) => b.id), [ids[0], ids[1]]);
  is("they are declined", [await status(ids[0]), await status(ids[1])], ["declined", "declined"]);
  is("one decided before is left as it was", await status(ids[3]), "declined");
  is("an unknown decision is refused", (await post({ action: "bulk", decision: "remove", ids })).error, "unknown");

  part("Undo");
  // Decided by hand since the press: never overwritten.
  await post({ action: "approve", id: ids[1] });
  const undone = await post({ action: "bulk-undo", decision: "decline", before: declined.before });
  is("the one still as the press left it goes back; the one decided since stays", [undone.undone, await status(ids[0]), await status(ids[1])], [1, "pending", "approved"]);
  is("a non-pending state sent in an undo is ignored", (await post({ action: "bulk-undo", decision: "decline", before: [{ id: ids[3], status: "approved", decidedAt: 0 }] })).undone, 0);
  await post({ action: "bulk", decision: "decline", ids: [ids[2]] });
  const late = await undoMany(await store(), [{ id: ids[2], status: "pending", decidedAt: 0 }], "decline", Date.now() + BULK_UNDO_MS + 1);
  is("after ten minutes nothing goes back", [late, await status(ids[2])], [0, "declined"]);

  part("The studio");
  const studio = readFileSync("components/affiliate-studio.tsx", "utf8");
  is("select all, and each one by its address", studio.includes("Select all") && studio.includes("{`Select ${row.affiliate.email}`}"), true);
  is("the undo says approval emails cannot be taken back", studio.includes("cannot take that email back"), true);
  is("the result is announced", studio.includes('role="status"'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
