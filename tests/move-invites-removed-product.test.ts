/**
 * Synthetic only (sibling of audit A1, found by the imports audit, 9 November 2026): a membership whose members were
 * invited over from another platform (lib/move-members.ts), then removed from the studio. Each invitation (the
 * member's address and renewal date), its link and its reminder are kept under the product's id; a person's erasure
 * and the copy of their data read only the products the catalogue holds now, so once the product is gone they were
 * never reached, and the erasure said it had finished. The removal must take them with the product.
 *
 * Checks marked [CORRETO] say what should happen; a FAIL there is the defect.
 */
import { NextRequest } from "next/server";
import { POST as productRoute } from "@/app/api/store/product/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteMembers, readInvite } from "@/lib/move-members";
import { erasePerson } from "@/lib/person-erasure";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "move-invites-removed@example.com";
const ADA = "ada-moved@example.com";
const BEN = "ben-moved@example.com";

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "moveinvitesgone", "Move Invites Gone", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_MoveInvitesGone1", true);
  await setSubscription(OWNER, { customerId: "cus_MoveInvitesGone", subscriptionId: "sub_MoveInvitesGone", active: true, tier: "creator", period: paidPeriod() });
  const club = await addProduct(OWNER, "Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  const other = await addProduct(OWNER, "Outer Circle", "", "19", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok || !other.ok) throw new Error("no product");
  const renews = Math.floor(Date.now() / 1000) + 20 * 86_400;
  const store = (await storeForEmail(OWNER))!;
  const fields = await inviteMembers(store, "job1", [
    { email: ADA, productId: club.product.id, option: "", renews },
    { email: BEN, productId: club.product.id, option: "", renews },
    { email: ADA, productId: other.product.id, option: "", renews },
  ]);
  is("three invitations are made", fields.every((f) => typeof f === "string"), true);
  const invitesKey = `nl:mv:${store.statsId}`;
  // inviteMembers answers false for an address deleted from the store (main's INVITE_UNLESS_ERASED); all three are text, checked above.
  const adaLink = (await readInvite(store.statsId!, fields[0] as string))!.t;

  part("The membership with invited members is removed from the studio");
  const session = await openSession(OWNER);
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers, body: JSON.stringify({ action: "remove", id: club.product.id }) }));
  is("the removal answers ok", ((await response.json()) as { ok?: boolean }).ok, true);
  const fieldsLeft = (await redis.pipeline([["HKEYS", invitesKey]]))[0] as string[];
  is("[CORRETO] no invitation to the removed membership is kept", fieldsLeft.filter((f) => f.endsWith(`:${club.product.id}`)).length, 0);
  is("the invitation to the other membership stays", fieldsLeft.filter((f) => f.endsWith(`:${other.product.id}`)).length, 1);
  is("[CORRETO] Ada's link to it is gone", (await redis.pipeline([["GET", `nl:mv:link:${adaLink}`]]))[0], null);
  const due = ((await redis.pipeline([["ZRANGEBYSCORE", "nl:mv:due", "-inf", "+inf"]]))[0] as string[]).filter((m) => m.endsWith(`:${club.product.id}`));
  is("[CORRETO] no reminder for it waits", due.length, 0);

  part("Ben then asks the store to erase him");
  const erased = await erasePerson((await storeForEmail(OWNER))!, BEN, { kind: "person" });
  is("the erasure says it finished", erased.ok, true);
  const values = (await redis.pipeline([["HVALS", invitesKey]]))[0] as string[];
  is("[CORRETO] nothing kept names him", values.filter((v) => v.includes(BEN)).length, 0);
  done();
}

void main();
