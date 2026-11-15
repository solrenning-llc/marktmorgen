/**
 * CX-123 rule 24 on the emailed link to one move to yearly (lib/yearly-switch.ts, mintYearlyLink) and the one email
 * that carries it (lib/yearly-ask.ts, askStore). The link is kept only when Redis answers its SET with "OK"; any
 * other shape is unknown, so no token is handed out: the email is never sent with a link that may not open, and the
 * membership's "sent" mark is let go, so it is offered again on a later run instead of being spent for five years.
 * Synthetic Stripe and Resend stand-ins and the in-memory Redis double only.
 */
import { grantFor, mintYearlyLink } from "@/lib/yearly-switch";
import { askStore } from "@/lib/yearly-ask";
import { UnknownReplyError } from "@/lib/redis-reply";
import { upsertContact } from "@/lib/contacts";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setProductYearly, setStripeAccount, setSubscription, setYearlyAsk, storeForEmail } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

process.env.STRIPE_SECRET_KEY = "sk_test_yearly_link_unknown_only";
// An exact synthetic literal from tests/resend-fixture-credentials.ts, never a live key.
process.env.RESEND_API_KEY = "re_test_yearly_switch_only";

const OWNER = "owner@example.com";
const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
const mails: { to: string | string[]; subject: string; text: string }[] = [];
let product = "";

const member = () => ({
  id: "sub_Ana000000001",
  status: "active",
  customer: { id: "cus_Ana0000001", email: "ana@example.com" },
  created: NOW - 90 * DAY,
  start_date: NOW - 90 * DAY,
  trial_end: null,
  discount: null,
  discounts: [],
  pause_collection: null,
  metadata: { store: "harbor", product },
  items: { data: [{ id: "si_Ana000000001", quantity: 1, current_period_end: NOW + 10 * DAY, price: { unit_amount: 2000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } } }] },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown) => new Response(JSON.stringify(v));
  if (url.hostname === "api.resend.com") {
    mails.push(JSON.parse(String(init?.body)));
    return json({ id: `email_${mails.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if ((init?.method ?? "GET") === "GET" && path === "/subscriptions") return json({ object: "list", data: [member()], has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** The Redis double, answering SET on the emailed link's key in another shape. */
const real = redis.pipeline;
function answerLinkSet(shape: unknown): void {
  redis.pipeline = async (commands) => {
    const replies = await real(commands);
    return commands.map((one, i) => (String(one[0]).toUpperCase() === "SET" && String(one[1]).startsWith("nl:yearly:link:") ? shape : replies[i]));
  };
}
const restore = () => {
  redis.pipeline = real;
};

const NOT_OK: [string, unknown][] = [
  ["missing", undefined],
  ["null (not set)", null],
  ["another word", "QUEUED"],
  ["a number", 1],
  ["a list", ["OK"]],
  ["an object", { result: "OK" }],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Supper Club", "", "20", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("no product");
  product = made.product.id;
  await setProductLink(OWNER, product, "https://example.com/club");
  await setProductYearly(OWNER, product, { cents: 20000 });
  if (!(await setYearlyAsk(OWNER, { on: true, address: "1 Main St, Portland, OR 97201" })).ok) throw new Error("no yearly ask");
  const store = (await storeForEmail(OWNER))!;
  await upsertContact(store.listId as string, "ana@example.com", { agreed: true, explicit: true, source: "buyer", productId: product, title: "Supper Club" }, ROOM);
  const sentKey = `nl:yearask:${store.statsId}:sub_Ana000000001`;

  part("Control: a link kept with OK opens this one move");
  const kept = await mintYearlyLink(store, "cus_Ana0000001", "sub_Ana000000001");
  is("opened", (await grantFor(store, kept, "sub_Ana000000001"))?.emailed, true);

  part("The link's SET answered in an unknown shape: no token handed out");
  for (const [label, shape] of NOT_OK) {
    answerLinkSet(shape);
    let thrown: unknown = null;
    let token = "";
    try {
      token = await mintYearlyLink(store, "cus_Ana0000001", "sub_Ana000000001");
    } catch (error) {
      thrown = error;
    }
    restore();
    is(`${label}: refused as unknown`, thrown instanceof UnknownReplyError, true);
    is(`${label}: no token that may not open`, token, "");
  }

  part("The offer email with that link: never sent, and offered again later");
  for (const [label, shape] of NOT_OK) {
    mails.length = 0;
    await redisPipeline([["DEL", sentKey]]);
    answerLinkSet(shape);
    let sent = -1;
    try {
      sent = await askStore(store, Date.now() + 20_000);
    } catch {
      sent = -2;
    }
    restore();
    is(`${label}: nothing sent`, [sent, mails.length], [0, 0]);
    is(`${label}: the membership is not marked as written to`, (await redisPipeline([["EXISTS", sentKey]]))[0], 0);
  }

  part("Control: the email goes out with a link that opens");
  mails.length = 0;
  await redisPipeline([["DEL", sentKey]]);
  is("sent once", await askStore(store, Date.now() + 20_000), 1);
  const link = /token=([0-9a-f]{64})/.exec(mails[0]?.text ?? "")?.[1] ?? "";
  is("its link opens this one move", (await grantFor(store, link, "sub_Ana000000001"))?.emailed, true);
  is("marked as written to", (await redisPipeline([["EXISTS", sentKey]]))[0], 1);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
