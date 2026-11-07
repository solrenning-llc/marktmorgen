/**
 * The link in the email that tells a member their card stops working before the next payment (lib/card-update.ts,
 * cardLink; lib/payment-recovery.ts, noticeCards) is emailed only once Redis said, with an exact "OK", that it
 * stored it (CX-123 rules 24 and 30, the "exact SET of the link" pattern of lib/membership-manage.ts and
 * lib/buyer-library.ts). Synthetic only: the in-memory Redis double and stand-ins for Stripe and the email provider
 * through `fetch`.
 *
 * Before: the SET's reply was never read, so with no reply, nil, "QUEUED", two replies for one command or a reply
 * lost after the SET landed, the notice still went out (or the link was left behind), and a member could get a link
 * that does not open. Now any reply but exactly ["OK"] sends nothing, removes the link in case it landed, and lets
 * the notice's mark go so the next daily run tells them, with a link that opens.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { cardGrant } from "@/lib/card-update";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Mail = { to: string[] | string; subject: string; text: string };
const mails: Mail[] = [];
const state = { active: [] as Record<string, unknown>[] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)) as Mail);
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/subscriptions" && method === "GET") {
    const status = url.searchParams.get("status");
    return answer({ object: "list", data: status === "active" ? state.active : [], has_more: false });
  }
  if (path === "/invoices" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const original = redis.pipeline.bind(redis);
const isLinkSet = (commands: (string | number)[][]) =>
  commands.length === 1 && String(commands[0][0]).toUpperCase() === "SET" && String(commands[0][1]).startsWith("nl:card:link:");
const links = () => redis.keys().filter((k) => k.startsWith("nl:card:link:"));
const marks = () => redis.keys().filter((k) => k.startsWith("nl:dun:card:"));
const tokenIn = (mail: Mail) => mail.text.match(/manage\/card\?t=([0-9a-f]{64})/)?.[1] ?? "";

/** How the link's SET is answered: each a reply Redis never gives for one SET, or one lost after it landed. */
const CASES: { name: string; applied: boolean; reply: (real: unknown[]) => unknown[] }[] = [
  { name: "no reply at all", applied: false, reply: () => [] },
  { name: "nil", applied: false, reply: () => [null] },
  { name: "\"QUEUED\"", applied: false, reply: () => ["QUEUED"] },
  { name: "two replies for one SET", applied: true, reply: () => ["OK", "OK"] },
  { name: "the SET landed and its reply was lost", applied: true, reply: () => { throw new Error("the connection closed before the reply"); } },
];

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_card_link_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";
  redis.clear();

  const OWNER = "owner@example.com";
  const made = await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  const store = (await storeForEmail(OWNER))!;

  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  state.active = [{
    id: "sub_Running000001",
    status: "active",
    metadata: { store: "harbor", product: club.product.id },
    customer: { id: "cus_Member000001", email: "cy@example.com", invoice_settings: { default_payment_method: null } },
    items: { data: [{ current_period_end: payAt }] },
    default_payment_method: { id: "pm_OldCard0000001", type: "card", card: { brand: "visa", last4: "4242", exp_month: lastMonth.getUTCMonth() + 1, exp_year: lastMonth.getUTCFullYear() } },
  }];
  const run = () => recoverFailedPayments(Date.now() + 20_000);

  for (const c of CASES) {
    part(`The card link's SET answers: ${c.name}`);
    let sets = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!isLinkSet(commands)) return original(commands);
      sets += 1;
      const real = c.applied ? await original(commands) : [];
      return c.reply(real);
    }) as typeof redis.pipeline;
    const before = mails.length;
    await run();
    redis.pipeline = original as typeof redis.pipeline;
    const sent = mails.slice(before);
    const opens = await Promise.all(sent.map(async (m) => (await cardGrant(store, tokenIn(m))) !== null));
    is(`${c.name}: the link was asked for once`, sets, 1);
    is(`${c.name}: no notice is emailed with a link Redis did not say it stored`, sent.length, 0);
    is(`${c.name}: no member holds a link that does not open`, opens.filter((open) => !open).length, 0);
    is(`${c.name}: no link is left behind`, links().length, 0);
    is(`${c.name}: the notice's mark is let go, so the next run tells them`, marks().length, 0);
    // Each case starts from the same place, whatever the one before it left (so each is proved on its own).
    for (const key of [...links(), ...marks()]) await original([["DEL", key]]);
  }

  part("Redis answers exactly \"OK\"");
  const before = mails.length;
  await run();
  is("the notice the failed runs did not send now goes out, once", mails.length - before, 1);
  is("its link opens", (await cardGrant(store, tokenIn(mails.at(-1)!)))?.s, "sub_Running000001");
  await run();
  is("and the member is not told twice", mails.length - before, 1);

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
