/** Codex S independent second-review probe; fixture/helpers adapted from C6 l9-invite-invoice-list.test.ts. */
/**
 * Claude 6's rule-24 audit, finding B1 (made a permanent test): the paid invoices of an invited store's customer are
 * what proves whether that customer paid us before the invite ("not brought to us by anyone"). A reply that is not
 * Stripe's list, a page that does not say whether more follow, a row that cannot be read, or a list that goes on past
 * the first page must never be read as "these are all the invoices": the older page may hold the payment made before
 * the invite. Each such store fails the run (retried the next day), earns nothing and is not marked. The healthy
 * single-page read and a confirmed empty list are unchanged; a second page is read to its end before anything is
 * decided.
 */
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { claimHandle, setSubscription } from "@/lib/store";
import { settleInvites } from "@/lib/creator-invite-credit";
import { ALL_KEY, byKey, creditKey } from "@/lib/creator-invites";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";

const DAY = 86_400;
const NOW_MS = Date.UTC(2026, 9, 16, 12);
const NOW = Math.floor(NOW_MS / 1000);
const INVITED_AT = NOW - 60 * DAY;
const CUSTOMER = "cus_Invited01";

type Reply = (startingAfter: string | null, page: number) => unknown;
let invoiceReply: Reply = () => ({ object: "list", data: [], has_more: false });
let invoiceReads: string[] = [];
let posted: string[] = [];

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (url.hostname !== "api.stripe.com") return answer({}, 404);
  if (method === "GET" && path === "/invoices") {
    invoiceReads.push(url.search);
    return answer(invoiceReply(url.searchParams.get("starting_after"), invoiceReads.length));
  }
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  if (method === "GET" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    return answer({ object: "list", data: [], has_more: false });
  }
  if (method === "POST" && /^\/customers\/cus_[A-Za-z0-9]+\/balance_transactions$/.test(path)) {
    const credit = new URLSearchParams(String(init?.body ?? "")).get("metadata[nimbus_invite_credit]") ?? "";
    posted.push(credit);
    return answer({ id: `cbtxn_${posted.length}abcdef`, object: "customer_balance_transaction" });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid subscription invoice. `daysAgo` sets when it was made and paid. */
function invoice(id: string, daysAgo: number): Record<string, unknown> {
  const at = NOW - daysAgo * DAY;
  return {
    id,
    object: "invoice",
    status: "paid",
    amount_paid: 2_900,
    post_payment_credit_notes_amount: 0,
    currency: "usd",
    created: at,
    status_transitions: { paid_at: at },
    parent: { type: "subscription_details" },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: `pi_${id.slice(3)}` } }], has_more: false },
  };
}

/** Paid after the invite and past the refund window: it would earn the inviter a share. */
const RIPE = (id: string) => invoice(id, INVITE_HOLD_DAYS + 4);
/** Paid long before the invite: the store was not brought to us. */
const BEFORE = (id: string) => invoice(id, 400);

type Outcome = { failed: number; complete: boolean; credit: unknown; back: boolean; posted: string[]; reads: string[] };

async function runCase(handle: string, reply: Reply, watch: string): Promise<Outcome> {
  redis.clear();
  invoiceReply = reply;
  invoiceReads = [];
  posted = [];
  const inviter = await claimHandle("inviter@example.com", "inviter-b1", "Inviter", "");
  if (!inviter.ok) throw new Error("inviter fixture failed");
  await setSubscription("inviter@example.com", { customerId: "cus_Inviter01", subscriptionId: "sub_Inviter01", active: true });
  const made = await claimHandle(`${handle}@example.com`, handle, handle, "");
  if (!made.ok) throw new Error(`fixture failed: ${handle}`);
  await setSubscription(`${handle}@example.com`, { customerId: CUSTOMER, subscriptionId: "sub_Invited01", active: true });
  redis.run(["SET", byKey(made.store.sid), JSON.stringify({ r: inviter.store.sid, at: INVITED_AT, terms: { version: 1, sharePercent: 50, bonusCents: 0 } })]);
  redis.run(["ZADD", ALL_KEY, INVITED_AT, made.store.sid]);
  const run = await settleInvites(Date.now() + 60_000, NOW_MS);
  const by = JSON.parse(String(redis.run(["GET", byKey(made.store.sid)]))) as { back?: boolean };
  return { failed: run.failed, complete: run.complete, credit: redis.run(["GET", creditKey(watch)]), back: by.back === true, posted, reads: invoiceReads };
}

const refused = (o: Outcome) => [o.failed >= 1, o.complete, o.credit, o.back, o.posted];
const REFUSED = [true, false, null, false, []];

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_s3221_stand_in_only";
  const healthy = await runCase("s-healthy", () => ({ object: "list", data: [RIPE("in_SHealthy001")], has_more: false }), "in_SHealthy001");
  is("healthy real settlement still posts one share", [healthy.failed,healthy.complete,healthy.back,healthy.posted], [0,true,false,["in_SHealthy001"]]);
  const cases: [string, Record<string,unknown>][] = [
    ["missing-list-object", {}],
    ["credit-notes-text", {post_payment_credit_notes_amount:"2900"}],
    ["paid-amount-text", {amount_paid:"2900"}],
    ["created-text", {created:"1760000000"}],
    ["paid-at-text", {status_transitions:{paid_at:String(NOW-40*DAY)}}],
    ["currency-number", {currency:978}],
    ["parent-array", {parent:[]}],
  ];
  for (const [name,patch] of cases) {
    const o=await runCase(`s-${name}`,()=> name === "missing-list-object" ? {data:[RIPE("in_SFault0001")],has_more:false} : {object:"list",data:[{...RIPE("in_SFault0001"),...patch}],has_more:false},"in_SFault0001");
    is(`${name}: unknown fails without permanent credit/back or Stripe post`,refused(o),REFUSED);
  }
  const before=await runCase("s-pre-invite",after=>({object:"list",data:[after===null?RIPE("in_SPage00002"):BEFORE("in_SPage00001")],has_more:after===null}),"in_SPage00002");
  is("older paid invoice on page2 refuses credit before any post",[before.failed,before.complete,before.back,before.credit,before.posted,before.reads.length],[0,true,true,null,[],2]);
  done();
}
void main();
