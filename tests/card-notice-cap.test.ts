/**
 * Card notices have a ceiling per store and per run (lib/payment-recovery.ts, noticeCards, CARD_NOTICES_PER_RUN;
 * 16 November 2026). Until then the only bound on the notices one store's run could send, with their database
 * commands and Stripe calls, was the job's deadline: a cost with no ceiling before it is spent (regra MR). A notice
 * past the ceiling waits for the next run, never dropped: the run that stopped at it reads the same pages again next
 * time, and a member already told is never told twice (the claim per membership and card).
 *
 * What fails here:
 *   - a run that sends more than CARD_NOTICES_PER_RUN notices for one store;
 *   - a member whose notice was due and not sent never told (the cursor moved past them);
 *   - a member told twice;
 *   - a store under the ceiling told less than every member due in one run (control).
 * Synthetic store, Stripe and email stand-ins.
 */
import { CARD_NOTICES_PER_RUN, CARD_PAGES, recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const sent: string[] = [];
let active: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const mail = JSON.parse(String(init?.body)) as { to: string[] | string };
    sent.push([mail.to].flat()[0]);
    return answer({ id: `email_${sent.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") {
    if (url.searchParams.get("status") !== "active") return answer({ object: "list", data: [], has_more: false });
    // Paged as Stripe pages: `limit` rows after `starting_after`.
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    const from = after ? active.findIndex((s) => s.id === after) + 1 : 0;
    const data = active.slice(from, from + limit);
    return answer({ object: "list", data, has_more: from + limit < active.length });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const run = () => recoverFailedPayments(Date.now() + 60_000);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_card_cap_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "scale", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  is("the store is set up", Boolean(await storeForEmail(OWNER)), true);

  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  const member = (i: number) => ({
    id: `sub_Member${String(i).padStart(8, "0")}`,
    status: "active",
    metadata: { store: "harbor", product: club.product.id },
    cancel_at_period_end: false,
    cancel_at: null,
    pause_collection: null,
    customer: { id: `cus_Member${String(i).padStart(8, "0")}`, email: `m${i}@example.com`, invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: `pm_Card${String(i).padStart(10, "0")}`, type: "card", card: { brand: "visa", last4: "4242", exp_month: lastMonth.getUTCMonth() + 1, exp_year: lastMonth.getUTCFullYear() } },
  });

  part("A ceiling per store and per run");
  is("a whole number, below what one run reads", Number.isSafeInteger(CARD_NOTICES_PER_RUN) && CARD_NOTICES_PER_RUN > 0 && CARD_NOTICES_PER_RUN < CARD_PAGES * 100, true);
  const many = CARD_PAGES * 100 + 100;
  active = Array.from({ length: many }, (_, i) => member(i));
  await run();
  is(`one run sends at most ${CARD_NOTICES_PER_RUN}`, sent.length, CARD_NOTICES_PER_RUN);

  part("Past the ceiling, the next run, never dropped, never twice");
  let runs = 1;
  while (new Set(sent).size < many && runs < 40) {
    const before = sent.length;
    await run();
    runs += 1;
    is(`run ${runs}: at most the ceiling`, sent.length - before <= CARD_NOTICES_PER_RUN, true);
  }
  is("every member due was told", new Set(sent).size, many);
  is("and none twice", sent.length, many);

  part("Control: a store under the ceiling, in one run");
  redis.clear();
  sent.length = 0;
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, tier: "scale", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const again = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!again.ok) throw new Error("no product");
  await setProductLink(OWNER, again.product.id, "https://example.com/club");
  active = Array.from({ length: 7 }, (_, i) => ({ ...member(i), metadata: { store: "harbor", product: again.product.id } }));
  await run();
  is("all seven told in one run", new Set(sent).size, 7);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
