/**
 * Synthetic only (Claude 7, MEDIUM on #3473 at 3af61c5cea): a members import step reads the catalog
 * (lib/imports.ts, membersStep) and writes its invitations several round trips later; a membership removed from the
 * studio in between had its invitations dropped before the step wrote one, so the step's invitation (the plain
 * address, the emailed link and the reminder) was kept under a product the store no longer holds, out of reach of a
 * person's erasure, which then said it had finished (VR 2).
 *
 * The step here holds the store as it read it before the removal, exactly as the import does. Checks marked
 * [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMembers } from "@/lib/move-members";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { erasePerson } from "@/lib/person-erasure";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "move-invites-race@example.com";
const ADA = "ada-race-probe@example.com";
const BEN = "ben-race-probe@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "moveinvitesrace", "Move Invites Race", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRace0001", true);
  await setSubscription(OWNER, { customerId: "cus_MoveInvitesRace", subscriptionId: "sub_MoveInvitesRace", active: true, tier: "creator", period: paidPeriod() });
  const club = await addProduct(OWNER, "Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  const other = await addProduct(OWNER, "Outer Circle", "", "19", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok || !other.ok) throw new Error("no product");
  const renews = Math.floor(Date.now() / 1000) + 20 * 86_400;
  // The import step's read of the store and its catalog, made before the removal.
  const stale = (await storeForEmail(OWNER))!;
  const listId = stale.listId!;
  const erased = { key: suppressedKey(listId), print: (email: string) => suppressionPrint(listId, email) };
  const invitesKey = `nl:mv:${stale.statsId}`;

  part("The membership is removed from the studio while the import step is between its read and its write");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", "x-nimbus-store": stale.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id: club.product.id }) }));
  is("the removal answers ok", ((await response.json()) as { ok?: boolean }).ok, true);

  part("The step then writes its invitations from the catalog it read");
  const fields = await inviteMembers(stale, "job-race", [
    { email: ADA, productId: club.product.id, option: "", renews },
    { email: BEN, productId: other.product.id, option: "", renews },
  ], Date.now(), erased);
  is("[CORRETO] the invitation to the removed membership is not made, and says so", fields[0], "gone");
  is("the invitation to the membership still in the store is made", typeof fields[1], "string");
  const left = (await redis.pipeline([["HGETALL", invitesKey]]))[0] as string[];
  const values = left.filter((_, i) => i % 2 === 1);
  is("[CORRETO] no invitation to the removed membership is kept", left.filter((f, i) => i % 2 === 0 && f.endsWith(`:${club.product.id}`)).length, 0);
  is("[CORRETO] nothing kept names Ada", values.filter((v) => v.includes(ADA)).length, 0);
  const scanned = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:mv:link:*", "COUNT", "1000"]]))[0] as [string, string[]];
  const links = scanned[1];
  is("[CORRETO] only Ben's link exists", links.length, 1);
  const due = ((await redis.pipeline([["ZRANGEBYSCORE", "nl:mv:due", "-inf", "+inf"]]))[0] as string[]).filter((m) => m.endsWith(`:${club.product.id}`));
  is("[CORRETO] no reminder for the removed membership waits", due.length, 0);

  part("Ada then asks the store to erase her");
  const answer = await erasePerson((await storeForEmail(OWNER))!, ADA, { kind: "person" });
  is("the erasure says it finished", answer.ok, true);
  const after = (await redis.pipeline([["HVALS", invitesKey]]))[0] as string[];
  is("[CORRETO] and nothing kept names her", after.filter((v) => v.includes(ADA)).length, 0);
  done();
}

void main();
