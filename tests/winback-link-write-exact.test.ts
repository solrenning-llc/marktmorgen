/**
 * Rule 24, rule 30 sibling of lib/checkout-recovery.ts's stop link (docs/reviews/pf1-sweep-r24.md, F1): the come-back
 * offer (lib/winback-send.ts) is emailed with a link whose grant was just written to Redis. The write is read in its
 * exact shape: the SET "OK" and every erasure note a count. Any other answer is unknown, so the email does not go
 * with a link that may lead to "this offer has ended" or that an erasure could not find, the link that may have
 * landed is taken back, and the marks this run took are let go, so the next run sends the offer exactly once.
 * Stripe, the sender and Redis's odd answers are played by stand-ins; ids are synthetic.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setStripeAccount, setSubscription, setWinBack, storeForEmail } from "@/lib/store";
import { upsertContact } from "@/lib/contacts";
import { readWinBack, sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const DAY = 86_400;
const now = Date.now();
const nowS = Math.floor(now / 1000);
const OWNER = "wb-link-write@example.com";

type Sent = { to: string[]; text?: string };
const handed: Sent[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    handed.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  if (path === "/customers") return answer({ object: "list", data: [...customers].filter(([, e]) => e === url.searchParams.get("email")).map(([id, email]) => ({ id, object: "customer", email })), has_more: false });
  if (path === "/customers/search") return answer({ object: "search_result", data: [], has_more: false });
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
/** While `work` runs, the first pipeline that writes a come-back link answers as `odd` says (after running for real). */
async function oddLinkWrite<T>(odd: (out: unknown[], commands: Cmd[]) => unknown[], work: () => Promise<T>): Promise<T> {
  let used = false;
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    const writesLink = commands.some((cmd) => cmd[0] === "SET" && String(cmd[1]).startsWith("nl:wb:link:"));
    if (!writesLink || used) return out;
    used = true;
    return odd(out, commands);
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

function ended(id: string, customer: string, meta: Record<string, string>): void {
  events.push({
    id: `evt_${id}`,
    type: "customer.subscription.deleted",
    created: nowS - 8 * DAY,
    data: { object: { id, customer, ended_at: nowS - 8 * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
  });
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_wb_link_write_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  const made = await claimHandle(OWNER, "wblinkw", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestWbLinkW", true);
  await setSubscription(OWNER, { customerId: "cus_WbLinkWOwner", subscriptionId: "sub_WbLinkWOwner", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "wblinkw", product: club.product.id };
  const cases = [
    ["ann", "the link's SET answered something other than OK", (out: unknown[]) => out.map((reply, i) => (i === 0 ? "QUEUED" : reply))],
    ["bob", "the pipeline answered no replies at all (the write landed)", () => []],
    ["cat", "an erasure note answered something other than a count", (out: unknown[]) => out.map((reply, i) => (i === 1 ? "1" : reply))],
  ] as const;
  for (const [name] of cases) {
    const id = `cus_${name[0].toUpperCase()}${name.slice(1)}LinkW001`;
    customers.set(id, `${name}@example.com`);
    await upsertContact(store.listId as string, `${name}@example.com`, { agreed: true, explicit: true, source: "buyer" }, ROOM);
  }
  const cus = (name: string) => [...customers.entries()].find(([, email]) => email === `${name}@example.com`)![0];
  const to = (address: string) => handed.filter((e) => e.to[0] === address);
  const tokenOf = (mail: Sent | undefined) => String(mail?.text ?? "").match(/[?&]back=([0-9a-f]{40})/)?.[1] ?? "";
  const run = () => sendWinBacks(Date.now() + 30_000, now);
  const links = () => redis.keys().filter((key) => key.startsWith("nl:wb:link:")).length;

  for (const [name, how, odd] of cases) {
    part(`${how}: no email with a link that may lead nowhere, and the next run sends it once`);
    ended(`sub_${name[0].toUpperCase()}${name.slice(1)}LinkW0001`, cus(name), meta);
    const before = links();
    const first = await oddLinkWrite(odd, run);
    is(`the run counts ${name}'s offer as not sent`, first.sent, 0);
    is(`no email went to ${name}`, to(`${name}@example.com`).length, 0);
    is("the link that may have landed is taken back", links(), before);
    const second = await run();
    is(`the next run sends ${name}'s offer`, second.sent, 1);
    is(`${name} was written to exactly once`, to(`${name}@example.com`).length, 1);
    is("its link opens the offer", (await readWinBack(store, club.product.id, tokenOf(to(`${name}@example.com`)[0])))?.email, `${name}@example.com`);
    await run();
    is(`a further run does not write to ${name} again`, to(`${name}@example.com`).length, 1);
  }
  done();
}
void main().catch((error) => { console.error(error); process.exit(1); });
