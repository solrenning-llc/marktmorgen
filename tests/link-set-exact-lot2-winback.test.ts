/**
 * The come-back offer (lib/winback-send.ts sendWinBacks) emails a link to its
 * discount only once Redis said it stored that link (rule 24, the
 * signin-link-set-exact pattern, lot 2):
 *
 *   - the link's write (its SET and the three commands that note it for the
 *     person's erasure) answered short, long, or with anything but exactly "OK"
 *     for the SET sends no paid email; the link, in case it landed with its
 *     answer lost, is deleted; and this run's own marks are let go, so the next
 *     run, inside the same window, sends the offer once;
 *   - with Redis answering "OK", the offer goes once, as before.
 *
 * Stripe and the email sender are played by a stand-in for `fetch`.
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
const OWNER = "set-winback@example.com";

const emails: { to: string[]; text: string }[] = [];
const events: Record<string, unknown>[] = [];
const customers = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)) as { to: string[]; text: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/events") {
    const gte = Number(url.searchParams.get("created[gte]"));
    const lte = Number(url.searchParams.get("created[lte]"));
    return answer({ object: "list", data: events.filter((e) => Number(e.created) >= gte && Number(e.created) <= lte), has_more: false });
  }
  const customer = path.match(/^\/customers\/(cus_\w+)$/);
  if (customer) return answer({ id: customer[1], email: customers.get(customer[1]) ?? null });
  if (path === "/subscriptions") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

type Pipeline = typeof redis.pipeline;
type Commands = Parameters<Pipeline>[0];

const LINK = "nl:wb:link:";

/** Runs `work` with the write of a come-back link answered by `reply(n)` for its n commands; with `apply` the write is still made. */
async function linkWriteAnswered<T>(reply: (n: number) => unknown[], work: () => Promise<T>, apply: boolean): Promise<T> {
  const original: Pipeline = redis.pipeline;
  redis.pipeline = (async (commands: Commands) => {
    if (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith(LINK)) {
      if (apply) await original.call(redis, commands);
      return reply(commands.length);
    }
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

/** Answers to the link's write that do not say the SET stored it. */
const ODD: [string, (n: number) => unknown[]][] = [
  ["no reply at all", () => []],
  ["a null SET reply", (n) => [null, ...Array(n - 1).fill(1)]],
  ["an undefined SET reply", (n) => [undefined, ...Array(n - 1).fill(1)]],
  ["a SET reply of another word", (n) => ["QUEUED", ...Array(n - 1).fill(1)]],
  ["the SET's reply alone", () => ["OK"]],
  ["one reply too many", (n) => ["OK", ...Array(n).fill(1)]],
];

const links = () => redis.keys().filter((key) => key.startsWith(LINK)).length;
const tokenIn = (text: string) => /[?&]back=([0-9a-f]{40})/.exec(text)?.[1] ?? "";

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_l6_winback_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();

  if (!(await claimHandle(OWNER, "setwinback", "Harbor Kitchen", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSetWinBack", true);
  await setSubscription(OWNER, { customerId: "cus_SetWbOwner1", subscriptionId: "sub_SetWbOwner1", active: true, tier: "pro", period: paidPeriod() });
  const club = await addProduct(OWNER, "The Inner Circle", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!club.ok) throw new Error("no product");
  await setProductLink(OWNER, club.product.id, "https://example.com/club");
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  const store = (await storeForEmail(OWNER))!;
  const meta = { store: "setwinback", product: club.product.id };
  let n = 0;
  /** A member whose membership ended eight days ago, on the list. */
  const member = async () => {
    n += 1;
    const id = String(n).padStart(4, "0");
    const customer = `cus_SetWbMember${id}`;
    const email = `m${id}@example.com`;
    customers.set(customer, email);
    await upsertContact(store.listId as string, email, { agreed: true, explicit: true, source: "buyer" }, ROOM);
    events.push({
      id: `evt_SetWb${id}`,
      type: "customer.subscription.deleted",
      created: nowS - 8 * DAY,
      data: { object: { id: `sub_SetWb${id}`, customer, ended_at: nowS - 8 * DAY, metadata: meta, items: { data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }] } } },
    });
    return email;
  };
  const sentTo = (email: string) => emails.filter((e) => [e.to].flat()[0] === email);

  part("Control: Redis answers OK, the offer goes once and its link opens");
  const control = await member();
  await sendWinBacks(Date.now() + 30_000, now);
  await sendWinBacks(Date.now() + 30_000, now);
  is("one offer", sentTo(control).length, 1);
  is("its link opens the offer for that address", (await readWinBack(store, club.product.id, tokenIn(sentTo(control)[0]?.text ?? "")))?.email, control);

  part("A link whose write was not confirmed: no email, no link left, the offer goes on the next run");
  for (const [what, reply] of ODD) {
    for (const apply of [false, true]) {
      const email = await member();
      const before = links();
      await linkWriteAnswered(reply, () => sendWinBacks(Date.now() + 30_000, now), apply);
      const label = `${what}${apply ? " (the write landed)" : ""}`;
      is(`${label}: no come-back email`, sentTo(email).length, 0);
      is(`${label}: no come-back link left behind`, links(), before);
      await sendWinBacks(Date.now() + 30_000, now);
      is(`${label}: the next run sends the offer, once`, sentTo(email).length, 1);
    }
  }

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
