/**
 * #4422, the money-twice side: when Stripe made an invite credit but its
 * reply was lost (answered as {}), the credit stays owed, and the run that
 * tries again never makes a second credit, whether it comes within Stripe's
 * 24 hours of idempotency or after Stripe has forgotten the key.
 *
 * Two defences, both checked here: every POST of a credit carries the same
 * Idempotency-Key, derived from the credit alone (`nimbus-invite-<id>`); and
 * every run reads the customer's balance history first
 * (lib/creator-invite-credit.ts creditedAt), so a credit already made, found by
 * its `metadata[nimbus_invite_credit]`, is never posted again, even once the
 * key is forgotten. A history that cannot be read sends nothing.
 *
 * Stripe is a stand-in that keeps each row's metadata and replays a key's
 * first answer for 24 hours, as Stripe does; nothing real is charged.
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { inviteCode, recordInvite, creditKey, OWED_KEY } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAST = INVITE_HOLD_DAYS + 4;
const INVITED = PAST + 20;
const SHARE = "in_BeaFirst01";

type Row = { id: string; object: "customer_balance_transaction"; amount: number; metadata: Record<string, string> };
const balance = new Map<string, Row[]>();
const invoices = new Map<string, Record<string, unknown>[]>();
/** Stripe's idempotency: a key's first answer, replayed while the key is younger than 24 hours. */
const keys = new Map<string, { at: number; answer: unknown }>();
/** Stripe's clock, in seconds. */
let clock = nowS;
/** "lost": the POST is applied, but its answer reaches us as {}. "history-down": the history cannot be read. */
let mode: "normal" | "lost" | "history-down" = "normal";
const calls: { method: string; path: string; key: string; credit: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") {
    calls.push({ method, path, key: "", credit: "" });
    if (mode === "history-down") return answer({ error: { message: "down" } }, 500);
    return answer({ object: "list", data: balance.get(txns[1]) ?? [], has_more: false });
  }
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const key = headers.get("Idempotency-Key") ?? "";
    const credit = form.get("metadata[nimbus_invite_credit]") ?? "";
    calls.push({ method, path, key, credit });
    const kept = key ? keys.get(key) : undefined;
    if (kept && clock - kept.at < DAY) return answer(kept.answer);
    const row: Row = { id: `cbtxn_${credit.replace(/[^A-Za-z0-9]/g, "")}${balance.size}${calls.length}`, object: "customer_balance_transaction", amount: Number(form.get("amount")), metadata: { nimbus_invite_credit: credit } };
    balance.set(txns[1], [...(balance.get(txns[1]) ?? []), row]);
    const reply = mode === "lost" ? {} : row;
    if (key) keys.set(key, { at: clock, answer: reply });
    return answer(reply);
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") return answer({ id: customer[1], object: "customer", balance: 0, currency: "usd" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** Ana invites Bea; Bea's first payment earns Ana a share, held past INVITE_HOLD_DAYS. */
async function world(): Promise<void> {
  redis.clear();
  balance.clear();
  invoices.clear();
  keys.clear();
  calls.length = 0;
  clock = nowS;
  mode = "normal";
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  invoices.set("cus_Bea0001", [{
    id: SHARE, object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
    created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_bea_first" } }], has_more: false },
  }]);
}

const run = () => settleInvites(Date.now() + 60_000, NOW);
const record = () => JSON.parse(String(redis.run(["GET", creditKey(SHARE)]))) as { state: string; txn?: string };
const anaShares = () => (balance.get("cus_Ana0001") ?? []).filter((row) => row.metadata.nimbus_invite_credit === SHARE);
const sharePosts = () => calls.filter((c) => c.method === "POST" && c.credit === SHARE);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invites_only_a_stand_in";

  part("Made, its answer lost, then tried again within Stripe's 24 hours");
  await world();
  mode = "lost";
  await run();
  mode = "normal";
  is("Stripe made it once", anaShares().length, 1);
  is("but with no receipt it stays owed and listed", [record().state, redis.run(["SISMEMBER", OWED_KEY, SHARE])], ["owed", 1]);
  clock += 3_600;
  await run();
  is("the next run makes no second credit", anaShares().length, 1);
  is("it found the one made, in the history, and keeps its receipt", [record().state, record().txn, redis.run(["SISMEMBER", OWED_KEY, SHARE])], ["done", anaShares()[0]?.id, 0]);
  is("every POST of it carried the same key, from the credit alone", [...new Set(sharePosts().map((c) => c.key))], [`nimbus-invite-${SHARE}`]);

  part("Made, its answer lost, then tried again after Stripe forgot the key");
  await world();
  mode = "lost";
  await run();
  mode = "normal";
  clock += 2 * DAY;
  const before = calls.length;
  await run();
  const second = calls.slice(before);
  const firstRead = second.findIndex((c) => c.method === "GET" && c.path === "/customers/cus_Ana0001/balance_transactions");
  const firstPost = second.findIndex((c) => c.method === "POST" && c.path === "/customers/cus_Ana0001/balance_transactions");
  is("Ana's history is read before anything is posted to her", [firstRead >= 0, firstPost === -1 || firstRead < firstPost], [true, true]);
  is("no second credit, though Stripe would have taken the key again", anaShares().length, 1);
  is("done, with the receipt of the one made", [record().state, record().txn], ["done", anaShares()[0]?.id]);

  part("Made, its answer lost, then the history cannot be read");
  await world();
  mode = "lost";
  await run();
  clock += 2 * DAY;
  mode = "history-down";
  const posted = sharePosts().length;
  const blind = await run();
  mode = "normal";
  is("nothing is posted on a guess", sharePosts().length, posted);
  is("it stays owed, and the run says it did not finish", [record().state, blind.complete], ["owed", false]);
  is("still one credit", anaShares().length, 1);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
