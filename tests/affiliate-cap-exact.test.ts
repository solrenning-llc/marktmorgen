/**
 * The cap of MAX_AFFILIATES records per program is checked on the exact count of the people hash (CX-123 rule 24).
 * Synthetic only: the in-memory Redis double, a stand-in Stripe that answers one settled checkout, a stand-in
 * Resend, the real lib/affiliates.ts and the real route app/api/store/affiliates/route.ts.
 *
 * (MEDIUM) invitePartner, recordFromLink (an emailed link opened, a studio offer accepted) and joinAsBuyer compared a
 * raw HLEN reply with `Number(count) >= MAX_AFFILIATES`. A reply missing (undefined: NaN) or null (0) is not a count,
 * and both read as "room left": the 1,001st affiliate was let in, past the program's cap and past the store's data
 * limit for the people hash (tests/store-data-registry.ts). Now the count is read exactly (peopleCount): an unknown
 * reply throws UnknownReplyError before anything is written or sent, and each caller answers the honest "try again"
 * (503, or the page's status=error) with the link or the offer kept.
 *
 * (MEDIUM, the same pattern next to it, rule 30) bookSize, which counts the book before the affiliate page reads it
 * (lib/affiliate-page-admission.ts), read its eight counts with `.map(Number)`: null is 0 and [3] is 3, so an unknown
 * count read as a small book and fewer public requests were taken than the read then made. Now each is read with
 * countOf, and one not known makes the size null, which reads nothing.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { bookSize, invitePartner, joinAsBuyer, openAffiliateLink } from "@/lib/affiliates";
import { MAX_AFFILIATES } from "@/lib/affiliate-setting";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.RESEND_API_KEY = "re_test_cap_hlen";
process.env.STRIPE_SECRET_KEY = "sk_test_cap_hlen_a_stand_in";
/** A settled checkout of this store for each order id cs_test_capbuyer000NN, paid by buyerNN@example.com. */
const order = (n: number) => `cs_test_capbuyer${String(n).padStart(5, "0")}`;
let emails = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const paid = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_test_capbuyer(\d{5}))$/);
  if (paid) {
    return new Response(
      JSON.stringify({
        id: paid[1],
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        amount_total: 2700,
        currency: "usd",
        created: Math.floor(Date.now() / 1000),
        customer_details: { email: `buyer${Number(paid[2])}@example.com` },
        metadata: { store: "capshop", product: "p8w2m4q9zz" },
      }),
      { status: 200 },
    );
  }
  if (url.hostname === "api.resend.com") emails += 1;
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** What the people hash's HLEN answers instead of Redis; undefined: Redis itself. */
let countReply: { reply: unknown } | undefined;
/** What the people hash's count answers inside bookSize's eight; undefined: Redis itself. */
let sizeReply: { reply: unknown } | undefined;
/** Invitation links written (an invitation made), counted with the emails sent. */
let invitations = 0;
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const c of commands) if (c[0] === "SET" && /^nl:aff:link:/.test(String(c[1])) && String(c[2]).includes('"k":1')) invitations += 1;
  const one = commands.length === 1 ? commands[0] : null;
  if (countReply && one?.[0] === "HLEN" && /:people$/.test(String(one[1]))) return [countReply.reply];
  // bookSize's eight counts, the people hash's first.
  if (sizeReply && commands.length === 8 && commands[0][0] === "HLEN" && /:people$/.test(String(commands[0][1]))) {
    const replies = await real(commands);
    return [sizeReply.reply, ...replies.slice(1)];
  }
  return real(commands);
}) as typeof redis.pipeline;

const outcome = (x: { ok: boolean; reason?: string }) => (x.ok ? "let in" : (x.reason as string));
const thrown = (e: unknown) => `threw ${(e as Error).name}`;

async function main(): Promise<void> {
  redis.clear();
  const owner = "capper@example.com";
  await claimHandle(owner, "capshop", "Cap store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1capshop8300", true);
  await setSubscription(owner, { customerId: "cus_cap", subscriptionId: "sub_cap", active: true, tier: "creator", period: paidPeriod() });
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const settings = { action: "settings", enabled: true, rule: "last", payday: 0, hold: 0, recurring: 0, secondTier: 0, bonuses: [], percent: 30, days: 60, rates: {}, buyers: true };
  const r = await affiliatesRoute(new NextRequest("https://marktmorgen.com/api/store/affiliates", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(settings) }));
  is("(program on)", r.status, 200);
  const store = (await storeForEmail(owner))!;
  const people = `nl:aff:${store.statsId}:people`;
  const fill: (string | number)[] = ["HSET", people];
  for (let i = 0; i < MAX_AFFILIATES; i += 1) fill.push(i.toString(16).padStart(12, "0"), "{}");
  await real([fill]);
  is("(the program is full)", (await real([["HLEN", people]]))[0], MAX_AFFILIATES);
  const count = async () => (await real([["HLEN", people]]))[0];

  /** A fresh emailed link for its own address, so each case reaches the cap check (nobody known yet). */
  const link = async (n: number, email: string) => {
    const token = n.toString(16).padStart(64, "f");
    const key = `nl:aff:link:${createHash("sha256").update(`nimbus-aff-link:${token}`).digest("hex").slice(0, 40)}`;
    await real([["SET", key, JSON.stringify({ s: store.statsId, e: email, n: "" })]]);
    return { token, key };
  };
  const share = { percent: 10, products: ["p8w2m4q9zz"] };
  const titles = new Map([["p8w2m4q9zz", "A course"]]);

  part("An emailed link opened (recordFromLink)");
  const exact = await link(1, "exact@example.com");
  is("(a full program answers full on an exact count)", await openAffiliateLink(store, exact.token).then(outcome, thrown), "full");
  let n = 2;
  for (const [label, reply] of [["null", null], ["no reply", undefined], ["a string", "1"], ["a list", [0]]] as const) {
    const one = await link(n, `newone${n}@example.com`);
    n += 1;
    countReply = { reply };
    const got = await openAffiliateLink(store, one.token).then(outcome, thrown);
    countReply = undefined;
    is(`an HLEN answered ${label} never lets a person in past the cap`, got === "let in", false);
    is(`(after ${label}, the link is kept, to open again)`, typeof (await real([["GET", one.key]]))[0], "string");
  }
  is("the program holds at most MAX_AFFILIATES", await count(), MAX_AFFILIATES);

  part("A partner invited (invitePartner)");
  is("(a full program answers full on an exact count)", await invitePartner({ store, email: "partner@example.com", share, titles, origin: "https://marktmorgen.com" }).catch(thrown), "full");
  for (const [label, reply] of [["null", null], ["no reply", undefined]] as const) {
    countReply = { reply };
    emails = 0;
    invitations = 0;
    const got = await invitePartner({ store, email: "partner@example.com", share, titles, origin: "https://marktmorgen.com" }).catch(thrown);
    countReply = undefined;
    is(`an HLEN answered ${label} makes no invitation past the cap`, [got === "sent" || got === "waiting", invitations, emails], [false, 0, 0]);
  }

  part("A buyer joining after an order (joinAsBuyer)");
  is("(a full program answers full on an exact count)", await joinAsBuyer(store, order(1)).then(outcome, thrown), "full");
  let o = 2;
  for (const [label, reply] of [["null", null], ["no reply", undefined]] as const) {
    countReply = { reply };
    const got = await joinAsBuyer(store, order(o++)).then(outcome, thrown);
    countReply = undefined;
    is(`an HLEN answered ${label} never lets a buyer in past the cap`, got === "let in", false);
  }
  is("the program still holds at most MAX_AFFILIATES", await count(), MAX_AFFILIATES);

  part("The book's size, counted before it is read (bookSize), is never read as small");
  is("(counted exactly, every person is in it)", ((await bookSize(store))?.fields ?? 0) >= MAX_AFFILIATES, true);
  for (const [label, reply] of [["null", null], ["no reply", undefined], ["a list", [3]]] as const) {
    sizeReply = { reply };
    const got = await bookSize(store);
    sizeReply = undefined;
    is(`a count answered ${label} is not counted: null, which reads nothing`, got, null);
  }
  done();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
