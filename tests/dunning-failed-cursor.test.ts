/**
 * A store with more past-due memberships than one run reads is read through, page after page, across runs
 * (R1 on #3215, MÉDIO: lib/payment-recovery.ts, remindFailed).
 *
 * The defect this file was written around: one run reads at most FAILED_PAGES pages of a connected account's
 * past-due memberships, and every run started that list at its top again. Once the first pages' members were told,
 * they stayed past due and were read again, run after run, and the members after the fifth page were never read,
 * so their failed payment was never written about. Now the store keeps where its list was read to: the next run goes
 * on from there, a list read to its end is read from the top again, and a member not handled is read again (never
 * stepped past while the run made no progress, never pinning the walk). Never twice: each member is told once.
 * Synthetic Stripe and Resend stand-ins only.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const emails: string[] = [];
/** Addresses the sender refuses (422), every time. */
const refused = new Set<string>();
/** Each connected account's past-due memberships, newest first. */
const pastDue = new Map<string, Record<string, unknown>[]>();
let reads = 0;

const slice = (all: Record<string, unknown>[], url: URL) => {
  const after = url.searchParams.get("starting_after");
  const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
  const limit = Number(url.searchParams.get("limit")) || 10;
  return { object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length };
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const to = Array.isArray(body.to) ? body.to[0] : body.to;
    if (refused.has(to)) return answer({ message: "refused", name: "validation_error" }, 422);
    emails.push(to);
    return answer({ id: `email_${emails.length}` });
  }
  const account = String((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] ?? "");
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/subscriptions" && method === "GET") {
    if (account && url.searchParams.get("status") === "past_due") {
      reads += 1;
      return answer(slice(pastDue.get(account) ?? [], url));
    }
    return answer({ object: "list", data: [], has_more: false });
  }
  if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") return answer({ id: path.split("/").pop() });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const sentTo = (address: string) => emails.filter((to) => to === address).length;

async function makeStore(owner: string, handle: string, account: string): Promise<string> {
  const made = await claimHandle(owner, handle, `Store ${handle}`, "");
  if (!made.ok) throw new Error(`no store ${handle}`);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${handle}Own01`, subscriptionId: `sub_${handle}Own01`, active: true, tier: "pro", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  await setDunning(owner, { reminders: 1, cardNotice: false });
  await storeForEmail(owner);
  return club.product.id;
}

/** A past-due membership of `handle`; its invoice still open (owed) when `owed`, else already settled. */
function behind(handle: string, product: string, n: number, owed: boolean): Record<string, unknown> {
  const id = String(n).padStart(4, "0");
  return {
    id: `sub_${handle}Due${id}`,
    status: "past_due",
    metadata: { store: handle, product },
    customer: { id: `cus_${handle}Due${id}`, email: `${handle}-${id}@example.com` },
    latest_invoice: { id: `in_${handle}Due${id}`, status: owed ? "open" : "paid", amount_due: owed ? 2900 : 0, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/${handle}${id}`, next_payment_attempt: NOW + 3 * DAY },
  };
}
const recover = () => recoverFailedPayments(Date.now() + 20_000);

async function main(): Promise<void> {
  part("Six hundred members past due, one owed in fifty: the members after the fifth page are reached");
  redis.clear();
  {
    const product = await makeStore("due-many@example.com", "duemany", "acct_1TestDueMany01");
    pastDue.set("acct_1TestDueMany01", Array.from({ length: 600 }, (_, i) => behind("duemany", product, i, i % 50 === 0)));
    for (let i = 0; i < 4; i += 1) await recover();
    const owed = Array.from({ length: 12 }, (_, i) => `duemany-${String(i * 50).padStart(4, "0")}@example.com`);
    is("the members past the fifth page are told", [sentTo("duemany-0500@example.com"), sentTo("duemany-0550@example.com")], [1, 1]);
    is("every member owed is told once, never twice", owed.map(sentTo), owed.map(() => 1));
  }

  part("The same, with the sender always refusing the first member owed: the walk still moves on");
  redis.clear();
  emails.length = 0;
  {
    const product = await makeStore("due-pin@example.com", "duepin", "acct_1TestDuePin001");
    pastDue.set("acct_1TestDuePin001", Array.from({ length: 600 }, (_, i) => behind("duepin", product, i, i % 50 === 0)));
    refused.add("duepin-0000@example.com");
    for (let i = 0; i < 4; i += 1) await recover();
    is("the member past the fifth page is told", sentTo("duepin-0550@example.com"), 1);
    is("the refused one is never counted as told", sentTo("duepin-0000@example.com"), 0);
    refused.clear();
    for (let i = 0; i < 3; i += 1) await recover();
    is("once the sender takes it, it is told, and nobody twice", [sentTo("duepin-0000@example.com"), sentTo("duepin-0550@example.com"), sentTo("duepin-0250@example.com")], [1, 1, 1]);
  }

  part("A short list read to its end is read from the top again: a member who falls behind later is told");
  redis.clear();
  emails.length = 0;
  {
    const product = await makeStore("due-short@example.com", "dueshort", "acct_1TestDueShort1");
    pastDue.set("acct_1TestDueShort1", [behind("dueshort", product, 1, true), behind("dueshort", product, 2, true)]);
    await recover();
    pastDue.get("acct_1TestDueShort1")!.unshift(behind("dueshort", product, 3, true));
    reads = 0;
    await recover();
    is("read from the top again", reads >= 1, true);
    is("the newer member is told, the others not again", ["0001", "0002", "0003"].map((id) => sentTo(`dueshort-${id}@example.com`)), [1, 1, 1]);
  }

  done();
}

void main();
