/**
 * CX-123 rule 24, lot L6 (C4-20261105-1945-C2-2 (5)): the come-back offer
 * (lib/winback-send.ts) decides to email somebody from Stripe lists and Redis
 * marks. A list read in part, or a reply in an unknown shape, never counts as
 * "they have not come back" or "the mark is ours": the email is not sent, and
 * a claim taken for nothing is let go so the next run can decide on a whole
 * reading. The ended memberships of the window are read past their first
 * page. Stripe and the email sender are played by a stand-in for `fetch`; the
 * replies Upstash could give and the stand-in never does are injected for one
 * command only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "l6-winback@example.com";

type Sent = { to: string[] };
const emails: Sent[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();
/** What /subscriptions?customer= answers, per customer: the body Stripe would send. */
const subsBody = new Map<string, unknown>();
/** The events list, as pages of at most `eventsPage`. */
let eventsPage = 100;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    const after = url.searchParams.get("starting_after");
    const all = events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte);
    const from = after ? all.findIndex((e) => e.id === after) + 1 : 0;
    const page = all.slice(from, from + eventsPage);
    return answer({ object: "list", data: page, has_more: from + eventsPage < all.length });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/subscriptions") return answer(subsBody.get(url.searchParams.get("customer") ?? "") ?? { object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

function ended(id: string, customer: string, daysAgo: number, meta: Record<string, string>): void {
  events.push({
    id: `evt_${id}`,
    type: "customer.subscription.deleted",
    created: nowS - daysAgo * DAY,
    data: { object: { id, customer, ended_at: nowS - daysAgo * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
}

/** Runs one sweep with the reply to the first command named `name` (and matching `when`) replaced, after the
 * command itself ran: Upstash may have written it and still answered in a shape nobody can read. */
async function withReply(name: string, when: (command: (string | number)[]) => boolean, reply: () => unknown, run: () => Promise<unknown>): Promise<void> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!used && commands[0]?.[0] === name && when(commands[0])) {
      used = true;
      await real(commands);
      return reply();
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_l6_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const made = await claimHandle(OWNER, "lsixback", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestLsixBack1", true);
  await setSubscription(OWNER, { customerId: "cus_LsixOwner1", subscriptionId: "sub_LsixOwner1", active: true, period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "lsixback", product: club.product.id };
  const people = ["ann", "bob", "cat", "dan", "eve"];
  for (const name of people) {
    const id = `cus_${name[0].toUpperCase()}${name.slice(1)}0000001`.slice(0, 18);
    customers.set(id, `${name}@example.com`);
    await upsertContact(store.listId as string, `${name}@example.com`, { agreed: true, explicit: true, source: "buyer" }, ROOM);
  }
  const cus = (name: string) => [...customers.entries()].find(([, email]) => email === `${name}@example.com`)![0];
  const sentTo = () => emails.map((e) => e.to[0]);

  part("Has the member come back? Only a whole list says no");
  // Ann came back: her live membership is on the second page of her memberships, which this page says exists.
  ended("sub_Ann0000001", cus("ann"), 8, meta);
  subsBody.set(cus("ann"), { object: "list", data: Array.from({ length: 100 }, (_, i) => ({ status: "canceled", metadata: { store: "lsixback", product: `old${i}` } })), has_more: true });
  // Bob: Stripe answered with no list at all.
  ended("sub_Bob0000001", cus("bob"), 8, meta);
  subsBody.set(cus("bob"), { object: "list" });
  await sendWinBacks(Date.now() + 30_000, now);
  is("a list read in part, or no list, never counts as \"has not come back\": nobody is written to", sentTo(), []);
  subsBody.set(cus("bob"), { object: "list", data: [], has_more: false });
  await sendWinBacks(Date.now() + 30_000, now);
  is("the claim taken on an unknown reading was let go: the next whole reading writes to Bob, once", sentTo(), ["bob@example.com"]);

  part("Is the mark ours? Only an exact OK says yes");
  ended("sub_Cat0000001", cus("cat"), 8, meta);
  const claimOf = (key: string) => (command: (string | number)[]) => String(command[1]).includes(key);
  await withReply("SET", claimOf("sub_Cat0000001"), () => [undefined], () => sendWinBacks(Date.now() + 30_000, now));
  is("a claim answered in an unknown shape (no reply) is not taken for ours: Cat is not written to", sentTo().includes("cat@example.com"), false);
  await withReply("SET", claimOf("sub_Cat0000001"), () => ["QUEUED"], () => sendWinBacks(Date.now() + 30_000, now));
  is("nor answered with anything but OK", sentTo().includes("cat@example.com"), false);
  await sendWinBacks(Date.now() + 30_000, now);
  is("a mark that may be ours is kept: the next run does not write to Cat either, so nothing is ever sent twice", sentTo().includes("cat@example.com"), false);


  part("Every ended membership of the window, past the first page");
  eventsPage = 1;
  ended("sub_Dan0000001", cus("dan"), 8, meta);
  ended("sub_Eve0000001", cus("eve"), 8, meta);
  await sendWinBacks(Date.now() + 30_000, now);
  is("Dan and Eve are both read, though the window's events come one a page", [sentTo().includes("dan@example.com"), sentTo().includes("eve@example.com")], [true, true]);
  is("and nobody is written to twice", sentTo().length, new Set(sentTo()).size);
  eventsPage = 100;
  done();
}

void main();
