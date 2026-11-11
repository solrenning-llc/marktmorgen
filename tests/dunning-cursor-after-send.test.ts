/**
 * The cursors of the daily dunning job move only past what was really handled (rule 24, R24 inventory, crons item 6).
 *
 *   - Card notices (lib/payment-recovery.ts, noticeCards): the store's card cursor used to be written before any
 *     notice went out, so a member read this run but not told (the run's time ran out, or whether a card update
 *     waits could not be read) was left behind the cursor until the whole list came round again, days later and
 *     often after the card had failed. The cursor now stops before the first member not handled.
 *   - The store walk (recoverFailedPayments): a store whose sweep threw, or that had more to do when the run
 *     stopped, used to count as done. The walk now starts the next run at it, for a few runs at most, so a store
 *     that keeps failing never holds every other store back.
 *
 * Never twice: a member already told is never told again however often a page is read again.
 * Synthetic stores, Stripe and Resend stand-ins only.
 */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail, storesAfter } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

const mails: { to: string[] | string; subject: string }[] = [];
/** Running and past-due memberships, by connected account. */
const active = new Map<string, Record<string, unknown>[]>();
const pastDue = new Map<string, Record<string, unknown>[]>();
/** Accounts whose past-due page comes back in a shape that is not a list. */
const broken = new Set<string>();
/** Accounts whose past-due page takes the rest of the run. */
const slow = new Set<string>();
/** The run's time runs out as the next email is sent. */
let outOfTimeOnSend = false;
/** Memberships told to keep the card that pays (before a first failed-payment email). */
const kept: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    if (outOfTimeOnSend) {
      outOfTimeOnSend = false;
      shift += 60_000;
    }
    return answer({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const account = String((init?.headers as Record<string, string> | undefined)?.["Stripe-Account"] ?? "");
  if (path === "/subscriptions" && method === "GET") {
    const status = url.searchParams.get("status");
    if (status === "past_due" && broken.has(account)) return answer({ object: "list", data: "not a list", has_more: false });
    if (status === "past_due" && slow.has(account)) shift += 60_000;
    const all = (status === "past_due" ? pastDue : status === "active" ? active : new Map<string, Record<string, unknown>[]>()).get(account) ?? [];
    const after = url.searchParams.get("starting_after");
    const from = after ? all.findIndex((s) => s.id === after) + 1 : 0;
    const limit = Number(url.searchParams.get("limit")) || 10;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  }
  if (/^\/subscriptions\/sub_\w+$/.test(path) && method === "POST") {
    kept.push(path.split("/").pop() as string);
    return answer({ id: path.split("/").pop() });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** Runs `run` with the reply to the first pipeline whose first command is `name` on a key starting `prefix` replaced, after it ran. */
async function withReply(name: string, prefix: string, reply: (real: unknown) => unknown, run: () => Promise<unknown>): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await real(commands);
    if (!used && commands[0]?.[0] === name && String(commands[0]?.[1] ?? "").startsWith(prefix)) {
      used = true;
      return reply(answer);
    }
    return answer;
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

const told = (to: string) => mails.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(to)).length;
const run = () => recoverFailedPayments(Date.now() + 20_000);

/** A store selling one monthly membership, with its own connected account. */
async function makeStore(owner: string, handle: string, account: string, cardNotice: boolean): Promise<string> {
  const made = await claimHandle(owner, handle, `Store ${handle}`, "");
  if (!made.ok) throw new Error(`no store ${handle}`);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, account, true);
  await setSubscription(owner, { customerId: `cus_${handle}Own01`, subscriptionId: `sub_${handle}Own01`, active: true, tier: "pro", period: paidPeriod(Date.now(), { behind: 1, ahead: 30 }) });
  const club = await addProduct(owner, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(owner, club.product.id, "https://example.com/club");
  await setDunning(owner, { reminders: 1, cardNotice });
  await storeForEmail(owner);
  return club.product.id;
}

/** `n` running memberships of `handle`, every card good, but those at `expiring`, whose card stops before the payment. */
function running(handle: string, product: string, n: number, expiring: number[]): Record<string, unknown>[] {
  const payAt = Math.floor(Date.now() / 1000) + 5 * 86_400;
  const payDay = new Date(payAt * 1000);
  const lastMonth = new Date(Date.UTC(payDay.getUTCFullYear(), payDay.getUTCMonth() - 1, 1));
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(4, "0");
    const lapses = expiring.includes(i);
    return {
      id: `sub_${handle}Run${id}`,
      status: "active",
      metadata: { store: handle, product },
      customer: { id: `cus_${handle}Run${id}`, email: `${handle}-${id}@example.com`, invoice_settings: { default_payment_method: null } },
      items: { data: [{ current_period_end: payAt }] },
      default_payment_method: {
        id: `pm_${handle}Card${id}`,
        type: "card",
        card: { brand: "visa", last4: "4242", exp_month: lapses ? lastMonth.getUTCMonth() + 1 : 12, exp_year: lapses ? lastMonth.getUTCFullYear() : 2099 },
      },
    };
  });
}

/** `n` past-due memberships of `handle`, each with an open invoice to pay. */
function behind(handle: string, product: string, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(4, "0");
    return {
      id: `sub_${handle}Due${id}`, status: "past_due", metadata: { store: handle, product },
      customer: { id: `cus_${handle}Due${id}`, email: `${handle}-due-${id}@example.com` },
      latest_invoice: { id: `in_${handle}Due${id}`, status: "open", amount_due: 2900, currency: "usd", hosted_invoice_url: `https://invoice.stripe.com/i/${handle}${id}`, next_payment_attempt: 0 },
    };
  });
}

function reset(): void {
  redis.clear();
  mails.length = 0;
  kept.length = 0;
  active.clear();
  pastDue.clear();
  broken.clear();
  slow.clear();
  outOfTimeOnSend = false;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_recovery_only_a_stand_in";

  part("Card notices: the run's time runs out after the first notice of a store with 600 running memberships");
  reset();
  {
    const product = await makeStore("cards-time@example.com", "cardtime", "acct_1TestCardTime01", true);
    active.set("acct_1TestCardTime01", running("cardtime", product, 600, [10, 20]));
    outOfTimeOnSend = true;
    await run();
    is("this run: the first member told, the second not reached", [told("cardtime-0010@example.com"), told("cardtime-0020@example.com")], [1, 0]);
    await run();
    is("the next run: the member not reached is told, from where the notices stopped", told("cardtime-0020@example.com"), 1);
    await run();
    await run();
    is("never twice, for either", [told("cardtime-0010@example.com"), told("cardtime-0020@example.com")], [1, 1]);
  }

  part("Card notices: whether a card update waits cannot be read for one member");
  reset();
  {
    const product = await makeStore("cards-open@example.com", "cardopen", "acct_1TestCardOpen01", true);
    active.set("acct_1TestCardOpen01", running("cardopen", product, 600, [10]));
    await withReply("GET", "nl:card:open:", () => [123], run);
    is("unknown: no notice on a guess this run", told("cardopen-0010@example.com"), 0);
    await run();
    is("the next run reads it again and tells the member", told("cardopen-0010@example.com"), 1);
    await run();
    is("and never twice", told("cardopen-0010@example.com"), 1);
  }

  part("Card notices: a healthy store whose list ends in one run (control)");
  reset();
  {
    const product = await makeStore("cards-ok@example.com", "cardok", "acct_1TestCardOkay01", true);
    active.set("acct_1TestCardOkay01", running("cardok", product, 30, [3, 7]));
    await run();
    await run();
    is("each member with a card that stops told once", [told("cardok-0003@example.com"), told("cardok-0007@example.com"), told("cardok-0004@example.com")], [1, 1, 0]);
  }

  /** Three stores, in the order the walk reads them. */
  async function threeStores(): Promise<{ handle: string; account: string; product: string }[]> {
    const made: { handle: string; account: string; product: string }[] = [];
    for (const [handle, account] of [["walka", "acct_1TestWalkA0001"], ["walkb", "acct_1TestWalkB0001"], ["walkc", "acct_1TestWalkC0001"]]) {
      made.push({ handle, account, product: await makeStore(`${handle}@example.com`, handle, account, false) });
    }
    const order = (await storesAfter("0")).stores.map((s) => s.handle);
    return made.filter((s) => order.includes(s.handle)).sort((a, b) => order.indexOf(a.handle) - order.indexOf(b.handle));
  }

  part("The store walk: a store whose sweep threw is not done");
  reset();
  {
    const [first, second, third] = await threeStores();
    for (const s of [first, second, third]) pastDue.set(s.account, behind(s.handle, s.product, 1));
    broken.add(first.account);
    slow.add(second.account);
    await run();
    is("this run: the first store's page unreadable, the second ran out of time, the third not reached", [told(`${first.handle}-due-0000@example.com`), told(`${second.handle}-due-0000@example.com`), told(`${third.handle}-due-0000@example.com`)], [0, 0, 0]);
    broken.clear();
    slow.clear();
    await run();
    is("the next run starts at the store that failed: every member behind is written to", [told(`${first.handle}-due-0000@example.com`), told(`${second.handle}-due-0000@example.com`), told(`${third.handle}-due-0000@example.com`)], [1, 1, 1]);
    await run();
    is("and never twice", [told(`${first.handle}-due-0000@example.com`), told(`${second.handle}-due-0000@example.com`), told(`${third.handle}-due-0000@example.com`)], [1, 1, 1]);
  }

  part("The store walk: a store with more behind than one run writes to is not done");
  reset();
  {
    const [first, second, third] = await threeStores();
    pastDue.set(first.account, behind(first.handle, first.product, 150));
    pastDue.set(second.account, behind(second.handle, second.product, 1));
    pastDue.set(third.account, behind(third.handle, third.product, 1));
    slow.add(second.account);
    const before = kept.length;
    await run();
    is("this run: a hundred of the first store's looked after", new Set(kept.slice(before)).size, 100);
    slow.clear();
    await run();
    is("the next run starts at it: the other fifty", new Set(kept.slice(before).filter((id) => id.startsWith(`sub_${first.handle}`))).size, 150);
  }

  part("The store walk: a store that keeps failing never holds the others back for good (control)");
  reset();
  {
    const [first, second, third] = await threeStores();
    for (const s of [first, second, third]) pastDue.set(s.account, behind(s.handle, s.product, 1));
    broken.add(first.account);
    await run();
    is("a store held for the next run does not stop the stores after it in this one", [told(`${second.handle}-due-0000@example.com`), told(`${third.handle}-due-0000@example.com`)], [1, 1]);
  }
  reset();
  {
    const [first, second, third] = await threeStores();
    for (const s of [first, second, third]) pastDue.set(s.account, behind(s.handle, s.product, 1));
    // The first never readable, and the second taking all that is left of every run: each is started at for at most
    // three runs in a row, then the walk goes on.
    broken.add(first.account);
    slow.add(second.account);
    for (let i = 0; i < 6; i += 1) await run();
    is("within six runs the store after them is written to", told(`${third.handle}-due-0000@example.com`), 1);
    is("the failing store still sends nothing", told(`${first.handle}-due-0000@example.com`), 0);
  }

  part("The store walk: a store held at the end of the walk never keeps the stores before it waiting (Claude 6 on #3215)");
  reset();
  {
    const [first, second, third] = await threeStores();
    for (const s of [first, second]) pastDue.set(s.account, behind(s.handle, s.product, 1));
    pastDue.set(third.account, behind(third.handle, third.product, 1));
    broken.add(third.account);
    await run();
    is("this run: the first two written to, the last one held", [told(`${first.handle}-due-0000@example.com`), told(`${second.handle}-due-0000@example.com`)], [1, 1]);
    pastDue.set(first.account, behind(first.handle, first.product, 2));
    await run();
    is("the next run starts at the held store and comes round: the first store's new member behind is written to", told(`${first.handle}-due-0001@example.com`), 1);
    is("and nobody twice", [told(`${first.handle}-due-0000@example.com`), told(`${second.handle}-due-0000@example.com`)], [1, 1]);
  }

  done();
}

void main();
