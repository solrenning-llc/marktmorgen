/** NEW S probe, derived from author fixture; NOT recovered original source. */
import { recoverFailedPayments } from "@/lib/payment-recovery";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setDunning, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

let rejected = "";
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
    if (rejected && String(init?.body).includes(rejected)) return answer({message:"synthetic permanent refusal"},422);
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
  process.env.STRIPE_SECRET_KEY="sk_test_recovery_only_a_stand_in";
  process.env.RESEND_API_KEY="re_test_recovery_only_a_stand_in";
  reset(); const account="acct_1SRecov1108";
  const product=await makeStore("srecover@example.com", "srecover", account, true);
  active.set(account, running("srecover", product, 3, [1,2]));
  rejected="srecover-0001@example.com";
  await run(); is("healthy existing card notice sent", told("srecover-0002@example.com"), 1);
  const newest=running("srecover",product,1,[0])[0];
  newest.id="sub_SNewestCard1108";
  newest.customer={id:"cus_SNewestCard1108",email:"new-card@example.com",invoice_settings:{default_payment_method:null}};
  active.get(account)!.unshift(newest);
  for(let i=0;i<4;i++) await run();
  console.log("NEW_S_CURSOR",JSON.stringify(await redis.pipeline([["GET",`nl:dun:cards:${account}`]])));
  is("new lapsing member notified despite permanent refusal",told("new-card@example.com"),1);
  rejected="";await run();await run();
  is("refused member notified once after recovery",told("srecover-0001@example.com"),1);
  is("new lapsing member eventually notified once",told("new-card@example.com"),1);
  is("healthy existing notice never duplicated",told("srecover-0002@example.com"),1);done();
}
void main();
