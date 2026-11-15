/**
 * Security audit 506 [SG1], MM-SA-22 (the part left after #2290): the store's outgoing calendar feed
 * (/api/store/calendar/<token>.ics, lib/calendar-sync.ts) lists each booked buyer's name or email and the call's
 * video room, behind one token per store that the studio shows to every member with "settings". A member taken off
 * the team kept that address, and with it the buyers' names and rooms, for as long as the token lived.
 *
 * Checked: taking off a member with "settings" (an Admin) replaces the token (the old address answers nothing, the
 * new one answers), the studio says why the address changed, and the owner's email about the exit says it; taking
 * off a member without "settings" (Support) leaves the address as it was; a store with no address yet gets none.
 */
import { calendarView, ensureFeedToken, storeIdForToken } from "@/lib/calendar-sync";
import { putMember, removeMember } from "@/lib/team";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "calendar.owner@example.com";
const tokenOf = (url: string | null) => /\/api\/store\/calendar\/([0-9a-f]+)\.ics/.exec(url ?? "")?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "calshop", "Cal Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCalExit01", true);
  await setSubscription(OWNER, { customerId: "cus_CalExit0001", subscriptionId: "sub_CalExit0001", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await putMember(store, "sam.support@example.com", "support");
  await putMember(store, "ada.admin@example.com", "admin");
  await ensureFeedToken(store);
  const first = tokenOf((await calendarView(store)).subscribeUrl);
  is("control: the store has a subscription address that answers", [first.length > 0, (await storeIdForToken(first))?.statsId], [true, store.statsId]);

  part("A member without \"settings\" leaves: the address stays");
  is("Support is taken off", await removeMember(store, "sam.support@example.com"), true);
  is("the same address, still answering", [tokenOf((await calendarView(store)).subscribeUrl), (await storeIdForToken(first))?.statsId], [first, store.statsId]);

  part("A member with \"settings\" leaves: the address is replaced");
  mails.length = 0;
  is("Admin is taken off", await removeMember(store, "ada.admin@example.com"), true);
  const view = await calendarView(store);
  const second = tokenOf(view.subscribeUrl);
  is("RED: the old address answers nothing", await storeIdForToken(first), null);
  is("RED: a new address, which answers", [second.length > 0 && second !== first, (await storeIdForToken(second))?.statsId], [true, store.statsId]);
  is("RED: the studio says why the address changed", typeof (view as { leftAt?: unknown }).leftAt === "string" && Boolean((view as { leftAt?: string }).leftAt), true);
  const told = mails.find((m) => m.to === OWNER);
  is("RED: the owner's email about the exit says the calendar address changed", Boolean(told && /calendar/i.test(told.text) && /ada\.admin@example\.com/.test(told.text)), true);

  part("A store with no address yet gets none");
  redis.clear();
  await claimHandle(OWNER, "calshop", "Cal Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CalExit0001", subscriptionId: "sub_CalExit0001", active: true, tier: "pro", period: paidPeriod() });
  const bare = (await storeForEmail(OWNER))!;
  await putMember(bare, "ada.admin@example.com", "admin");
  is("Admin is taken off", await removeMember(bare, "ada.admin@example.com"), true);
  is("still no address", (await calendarView(bare)).subscribeUrl, null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
