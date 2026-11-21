/**
 * A store's look at a buyer's past refunds and disputes is held until its screen exists (Claude 7's MEDIUM 2 on
 * #3841, rule VR 2: what does not work today does not appear; Claude 3 (local), 16/11/2026: option (b)).
 *
 * The studio has no control that asks for it (components/inbox-history.tsx is not built), yet the Privacy Policy and
 * the person-data list described it in the present tense, and the inbox route's "history" action read the creator's
 * Stripe account for anyone who called it. While REFUND_HISTORY_SCREEN.shown is false: the action is refused before
 * anything is read, counted or kept, the policy has no paragraph for it, and the person-data list no entry. Building
 * the screen is future work; with it, the switch, the paragraph and the entry come back together
 * (tests/buyer-history.test.ts and tests/buyer-history-privacy.test.ts hold them on).
 * Synthetic stores, the memory Redis, a stand-in Stripe.
 */
import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setInboxSetting, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import * as history from "@/lib/buyer-history";
import { readInbox, startChat } from "@/lib/inbox";
import { PERSON_DATA } from "@/lib/person-data";
import { POST as inboxRoute } from "@/app/api/store/inbox/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_inbox_only_a_stand_in";
process.env.STRIPE_SECRET_KEY = "sk_test_buyer_history_held_only";

const OWNER = "mara@example.com";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.stripe.com/")) {
    stripeCalls += 1;
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }
  return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "mara", "mara shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setInboxSetting(OWNER, { chat: true, saved: [] });
  await setStripeAccount(OWNER, "acct_TestHistory1", true);
  const store = (await storeForEmail(OWNER))!;
  await startChat({ store, email: "buyer@example.com", name: "", text: "Hello there", ip: "10.0.0.1" });
  const [conversation] = await readInbox(store.statsId!);

  part("The screen does not exist, and the switch says so");
  const screen = (history as Record<string, unknown>).REFUND_HISTORY_SCREEN as { shown?: unknown } | undefined;
  is("REFUND_HISTORY_SCREEN.shown is false", screen?.shown, false);
  is("no studio control asks for it", existsSync("components/inbox-history.tsx"), false);

  part("The route refuses it before anything is read, counted or kept");
  const before = new Set(redis.keys());
  stripeCalls = 0;
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const response = await inboxRoute(new NextRequest("https://marktmorgen.com/api/store/inbox", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "history", id: conversation.id }) }));
  is("refused as not found", [response.status, await response.json()], [404, { ok: false, error: "none" }]);
  is("Stripe is not asked", stripeCalls, 0);
  is("no day's check counted", redis.keys().filter((key) => !before.has(key) && key.startsWith("nl:rl:refund-history")), []);

  part("Nothing tells buyers about it while it is held");
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("no Privacy Policy paragraph", privacy.includes('id="inbox-refund-history"'), false);
  is("no person-data entry", (PERSON_DATA as readonly { file: string }[]).some((row) => row.file === "lib/buyer-history.ts"), false);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
