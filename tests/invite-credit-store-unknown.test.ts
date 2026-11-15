/**
 * CX-123 rule 24 (audit round 7, item 1): an owed invite credit is put on the plan of the store it is owed to
 * (lib/creator-invite-credit.ts, putOnPlan). Only a store confirmed gone (its id key an exact null) may turn the credit
 * "gone" and take it off the owed list: the daily relisting puts back only credits still "owed", so a credit marked
 * "gone" is never paid. A store read that Redis answers in another shape is unknown: the credit stays owed, the run
 * counts a failure and is not complete, and the next run tries again. The same holds for the credit's own record, the
 * invited store read when earning, and the two lists the run walks. Stripe is a stand-in; nothing real is charged.
 */
import { claimHandle, setSubscription } from "@/lib/store";
import { OWED_KEY, creditKey, inviteCode, recordInvite, type Credit } from "@/lib/creator-invites";
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
const balance = new Map<string, { amount: number }[]>();
const invoices = new Map<string, Record<string, unknown>[]>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
  if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
  const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
  if (txns && method === "GET") return answer({ object: "list", data: [], has_more: false });
  if (txns && method === "POST") {
    const form = new URLSearchParams(String(init?.body ?? ""));
    const row = { id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`, amount: Number(form.get("amount")) };
    balance.set(txns[1], [...(balance.get(txns[1]) ?? []), row]);
    return answer(row);
  }
  const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
  if (customer && method === "GET") return answer({ id: customer[1], object: "customer", balance: 0, currency: "usd" });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis);

/** One run of the daily settlement with `answer` changing what Redis gives back; console errors kept quiet. */
async function runWith(answer: ((commands: Commands, replies: unknown[]) => unknown) | null) {
  if (answer) redis.pipeline = (async (commands: Commands) => answer(commands, await real(commands))) as typeof redis.pipeline;
  const errors = console.error;
  console.error = () => {};
  try {
    return await settleInvites(Date.now() + 60_000, NOW);
  } finally {
    redis.pipeline = real;
    console.error = errors;
  }
}

/** Replies with the one to `GET key` changed to `odd`. */
const oddGet = (key: string, odd: unknown) => (commands: Commands, replies: unknown[]) =>
  replies.map((reply, i) => (commands[i]?.[0] === "GET" && commands[i]?.[1] === key ? odd : reply));

/** No reply at all to a pipeline holding `GET key` (a short answer). */
const shortGet = (key: string) => (commands: Commands, replies: unknown[]) =>
  commands.some((c) => c[0] === "GET" && c[1] === key) ? [] : replies;

const recordOf = (id: string): Credit | null => {
  const raw = redis.run(["GET", creditKey(id)]);
  return typeof raw === "string" ? (JSON.parse(raw) as Credit) : null;
};
const owed = (id: string) => redis.run(["SISMEMBER", OWED_KEY, id]);
const paidTo = (customer: string) => (balance.get(customer) ?? []).map((t) => t.amount);

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_invites_only_a_stand_in";
  redis.clear();
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  const anaIdKey = `nl:store:id:${ana.sid}`;

  const owe = (id: string, to: string, cents: number) => {
    const credit: Credit = { id, kind: "bonus", to, from: to, cents, cur: "usd", at: nowS - PAST * DAY, state: "owed" };
    redis.run(["SET", creditKey(id), JSON.stringify(credit)]);
    redis.run(["SADD", OWED_KEY, id]);
  };

  part("A store read answered in another shape is unknown: the credit stays owed, never gone");
  owe("bonus_unknownstore", ana.sid, 700);
  for (const [name, answer] of [
    ["a number", oddGet(anaIdKey, 1)],
    ["a list", oddGet(anaIdKey, [1])],
    ["an empty string", oddGet(anaIdKey, "")],
    ["no reply", shortGet(anaIdKey)],
  ] as const) {
    const counts = await runWith(answer);
    is(`${name}: one failure, not complete, nothing added`, [counts.failed, counts.complete, counts.added], [1, false, 0]);
    is(`${name}: the credit is still owed and still listed`, [recordOf("bonus_unknownstore")?.state, owed("bonus_unknownstore")], ["owed", 1]);
    is(`${name}: nothing reached Stripe`, paidTo("cus_Ana0001"), []);
  }

  part("Read healthily afterward, the same credit is paid, once");
  const healed = await runWith(null);
  is("added once, complete", [healed.added, healed.failed, healed.complete], [1, 0, true]);
  is("done and off the owed list", [recordOf("bonus_unknownstore")?.state, owed("bonus_unknownstore")], ["done", 0]);
  is("Ana's plan got the credit once", paidTo("cus_Ana0001"), [-700]);
  await runWith(null);
  is("a later run pays nothing more", paidTo("cus_Ana0001"), [-700]);

  part("A store confirmed gone (its id key an exact null) still turns the credit gone");
  const goneSid = "0".repeat(32);
  owe("bonus_gonestore", goneSid, 500);
  const gone = await runWith(null);
  is("no failure, complete", [gone.failed, gone.complete], [0, true]);
  is("gone and off the owed list", [recordOf("bonus_gonestore")?.state, owed("bonus_gonestore")], ["gone", 0]);

  part("The credit's own record answered in another shape is unknown: it stays on the owed list");
  owe("bonus_unknowncredit", ana.sid, 300);
  for (const [name, answer] of [
    ["a number", oddGet(creditKey("bonus_unknowncredit"), 1)],
    ["a record that does not read", oddGet(creditKey("bonus_unknowncredit"), "{broken")],
    ["no reply", shortGet(creditKey("bonus_unknowncredit"))],
  ] as const) {
    const counts = await runWith(answer);
    is(`${name}: one failure, not complete`, [counts.failed, counts.complete], [1, false]);
    is(`${name}: still owed and still listed`, [recordOf("bonus_unknowncredit")?.state, owed("bonus_unknowncredit")], ["owed", 1]);
  }
  await runWith(null);
  is("read healthily, it is paid once", [recordOf("bonus_unknowncredit")?.state, owed("bonus_unknowncredit"), paidTo("cus_Ana0001")], ["done", 0, [-700, -300]]);

  part("A listed id whose record is confirmed absent, or no longer owed, leaves the list without a failure");
  redis.run(["SADD", OWED_KEY, "bonus_norecord"]);
  redis.run(["SADD", OWED_KEY, "bonus_unknowncredit"]);
  const tidy = await runWith(null);
  is("no failure, complete, nothing paid again", [tidy.failed, tidy.complete, tidy.added, paidTo("cus_Ana0001")], [0, true, 0, [-700, -300]]);
  is("both off the list", [owed("bonus_norecord"), owed("bonus_unknowncredit")], [0, 0]);

  part("The owed list answered in another shape is a failed, incomplete run, never an empty list");
  owe("bonus_listunknown", ana.sid, 200);
  const smembers = await runWith((commands, replies) => replies.map((reply, i) => (commands[i]?.[0] === "SMEMBERS" && commands[i]?.[1] === OWED_KEY ? 1 : reply)));
  is("one failure, not complete, nothing added", [smembers.failed, smembers.complete, smembers.added], [1, false, 0]);
  is("still owed", [recordOf("bonus_listunknown")?.state, owed("bonus_listunknown")], ["owed", 1]);
  await runWith(null);
  is("read healthily, it is paid", [recordOf("bonus_listunknown")?.state, paidTo("cus_Ana0001")], ["done", [-700, -300, -200]]);

  part("An invited store read answered in another shape fails the run; it earns once read healthily");
  const bea = await made("bea@example.com", "bea");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  invoices.set("cus_Bea0001", [{
    id: "in_BeaFirst01", object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
    created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_bea_first" } }], has_more: false },
  }]);
  const beaIdKey = `nl:store:id:${bea.sid}`;
  const unread = await runWith(oddGet(beaIdKey, 1));
  is("one failure, not complete, nothing earned", [unread.failed, unread.complete, unread.earned], [1, false, 0]);
  is("no credit written", redis.run(["EXISTS", creditKey("in_BeaFirst01")]), 0);

  part("The invited list answered in another shape is a failed, incomplete run, and the walk's place is kept");
  redis.run(["SET", "nl:ref:cursor", "1"]);
  const zrev = await runWith((commands, replies) => replies.map((reply, i) => (commands[i]?.[0] === "ZREVRANGE" ? "QUEUED" : reply)));
  is("one failure, not complete, nothing walked", [zrev.failed, zrev.complete, zrev.invited], [1, false, 0]);
  is("no credit written, the walk's place kept", [redis.run(["EXISTS", creditKey("in_BeaFirst01")]), redis.run(["GET", "nl:ref:cursor"])], [0, "1"]);

  const earned = await runWith(null);
  is("read healthily, Bea's first payment earns Ana's share and Bea's welcome bonus", [earned.failed, earned.earned, earned.complete], [0, 2, true]);
  await runWith(null);
  const bonus = paidTo("cus_Bea0001");
  is("both credits reach the plans, once", [paidTo("cus_Ana0001"), bonus.length, bonus[0] < 0], [[-700, -300, -200, -1450], 1, true]);
  done();
}

void main();
