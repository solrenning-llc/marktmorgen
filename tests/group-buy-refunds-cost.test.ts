/**
 * What one run of the job that takes group places back (lib/group-buy.ts, revokeRefundedGroups) sends for one store,
 * as the cost registry states it (GROUP_REFUND_RUN and NOT_A_COST.CHARGE_REFUND_LOOKUPS in tests/plan-cost-registry.ts;
 * Claude 7's MEDIUM on #3410: the job's per-store commands were listed but no test counted one run). The figures are
 * read from what the real job sends in its worst run and must equal the registry's:
 *
 *   - the job's own commands, whatever the rows: the start's four GETs, the switch to an account with no anchor
 *     (ZSCORE, ZRANGEBYSCORE, two ZADD, ZREMRANGEBYRANK), the retry list's HGETALL, the lost disputes' place (GET,
 *     SMISMEMBER of the read set, SET or DEL) and one write of the pass after every page (or the EVAL that ends it);
 *   - at most CHARGE_REFUND_LOOKUPS charges asked a run (GET /refunds?charge=), each with one GET of its purchase's
 *     held mark before and one SET after; a group part past the lookups holds without any command of its own;
 *   - at most LOST_DISPUTE_PAGES pages of closing events;
 *   - each row of a payment that paid for no group purchase (a refund, a lost dispute or a retry entry): SISMEMBER,
 *     GET, SADD and EXPIRE, and for a retry entry its HDEL;
 *   - a group refund on its way: SISMEMBER and GET, and over a week one SET NX of its alert mark.
 *
 * The worst run: a store back on another Stripe account, a full retry list, three full pages of lost disputes, ten
 * full pages of refunds with more group parts waiting on a refund than the run may ask about, and one group refund
 * stuck. A run whose lists go on past its pages writes its pass once more instead of the EVAL, and its place in the
 * lost disputes with SET instead of DEL: the same count.
 * Synthetic only: a stand-in for Stripe and the Redis stub.
 */
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import * as groupBuy from "@/lib/group-buy";
import { LOST_DISPUTE_PAGES } from "@/lib/refunds";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const ACCOUNT_A = "acct_1GrpCostA001";
const ACCOUNT_B = "acct_1GrpCostB001";
/** Each account's refunds, newest first. */
const lists = new Map<string, Record<string, unknown>[]>();
/** Each charge's own refunds, as GET /refunds?charge= lists them. */
const chargeRefunds = new Map<string, Record<string, unknown>[]>();
let closings: Record<string, unknown>[] = [];
const calls = { charge: 0, events: 0, refunds: 0 };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const account = new Headers(init?.headers).get("stripe-account") ?? "";
  if (path === "/refunds" && method === "GET" && url.searchParams.has("charge")) {
    calls.charge += 1;
    return answer({ object: "list", data: chargeRefunds.get(url.searchParams.get("charge") ?? "") ?? [], has_more: false });
  }
  if (path === "/refunds" && method === "GET") {
    calls.refunds += 1;
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    const all = (lists.get(account) ?? []).filter((r) => (r.created as number) >= since);
    const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    return answer({ object: "list", data: all.slice(from, from + limit), has_more: from + limit < all.length });
  }
  if (path === "/events" && method === "GET") {
    calls.events += 1;
    const after = url.searchParams.get("starting_after");
    const from = after ? closings.findIndex((e) => e.id === after) + 1 : 0;
    return answer({ object: "list", data: closings.slice(from, from + 100), has_more: from + 100 < closings.length });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

type Commands = (string | number)[][];

/** Every command sent while `run` runs. */
async function recorded(run: () => Promise<unknown>): Promise<Commands> {
  const sent: Commands = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => {
    sent.push(...commands);
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    await run();
  } finally {
    redis.pipeline = pipeline;
  }
  return sent;
}

const pad = (n: number, width = 6) => String(n).padStart(width, "0");
/** A refund of a payment, as /refunds lists it with its charge expanded. */
function refund(id: string, pi: string, created: number, status = "succeeded", amount = 9800, refunded = true): Record<string, unknown> {
  return { id, object: "refund", created, status, amount, payment_intent: pi, charge: { id: `ch_${pi.slice(3)}`, object: "charge", refunded, amount: 9800, amount_refunded: 9800 } };
}
/** A dispute Stripe closed as lost, as its charge.dispute.closed event. */
function lost(n: number, pi: string): Record<string, unknown> {
  return {
    id: `evt_grpcost${pad(n, 8)}`,
    object: "event",
    type: "charge.dispute.closed",
    created: NOW - 900 + Math.floor(n / 10),
    data: { object: { object: "dispute", id: `dp_grpcost${pad(n, 8)}`, status: "lost", amount: 9800, charge: `ch_${pi.slice(3)}`, payment_intent: pi } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.STRIPE_SECRET_KEY = "sk_test_group_cost_only_a_stand_in";
  const declared = (registry as unknown as Record<string, unknown>).GROUP_REFUND_RUN as
    | { jobCommands?: number; chargeLookups?: number; commandsPerLookup?: number; lostDisputePages?: number; commandsPerOtherRow?: number }
    | undefined;
  const reason = registry.NOT_A_COST.CHARGE_REFUND_LOOKUPS;

  part("the registry states one run of the job");
  is("GROUP_REFUND_RUN is in the registry", typeof declared, "object");
  is("its lookups are the code's CHARGE_REFUND_LOOKUPS", declared?.chargeLookups, groupBuy.CHARGE_REFUND_LOOKUPS);
  is("its pages of closing events are the code's LOST_DISPUTE_PAGES", declared?.lostDisputePages, LOST_DISPUTE_PAGES);
  is("NOT_A_COST.CHARGE_REFUND_LOOKUPS names it and says it is never zero", reason.includes("GROUP_REFUND_RUN") && reason.includes("not certified, never zero"), true);

  const OWNER = "groupcost@example.com";
  await claimHandle(OWNER, "groupcost", "Group Cost", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_GroupCost001", subscriptionId: "sub_GroupCost001", active: true, period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT_A, true);
  const owner = async () => (await storeForEmail(OWNER))!;
  const sid = (await owner()).statsId!;
  const run = async () => groupBuy.revokeRefundedGroups(await owner(), Date.now() + 120_000, async () => {});
  // The store sold a purchase for several (the mark settleGroup writes), so the job reads its refunds.
  await redis.pipeline([["SET", `nl:grp:${sid}:any`, "1"]]);

  part("a run on account A that reads its list to the end anchors the store there");
  lists.set(ACCOUNT_A, []);
  await run();
  is("anchored on account A", (await redis.pipeline([["GET", `nl:grp:${sid}:refunds:acct`]]))[0], ACCOUNT_A);

  part("the worst run: back on another account, a full retry list, three pages of lost disputes, ten pages of refunds");
  await setStripeAccount(OWNER, ACCOUNT_B, true);
  // The retry list full (RETRY_CAP, 100), each of a payment that paid for no group purchase.
  const retry: Commands = [];
  for (let i = 0; i < 100; i += 1) retry.push(["HSET", `nl:grp:${sid}:refunds:retry`, `re_GCostRetry${pad(i)}`, `pi_GCostRetry${pad(i)}`]);
  await redis.pipeline(retry);
  // Three full pages of closing events, each a dispute lost on a payment that paid for no group purchase.
  closings = Array.from({ length: 300 }, (_, i) => lost(i, `pi_GCostDisp${pad(i)}`)).sort((a, b) => (b.created as number) - (a.created as number));
  // Fifteen group parts, each the half of a charge whose other half is still on its way: more than the run may ask.
  const groups = 15;
  const parts: Record<string, unknown>[] = [];
  const marks: Commands = [];
  for (let i = 0; i < groups; i += 1) {
    const pi = `pi_GCostPart${pad(i)}`;
    const half = refund(`re_GCostPart${pad(i)}`, pi, NOW - 1000 - i, "succeeded", 4900);
    parts.push(half);
    chargeRefunds.set(`ch_${pi.slice(3)}`, [
      { id: `re_GCostWait${pad(i)}`, object: "refund", created: NOW - 999 - i, status: "pending", amount: 4900, charge: `ch_${pi.slice(3)}` },
      { id: half.id, object: "refund", created: half.created, status: "succeeded", amount: 4900, charge: `ch_${pi.slice(3)}` },
    ]);
    marks.push(["SET", `nl:grp:pi:${pi}`, `grp_${(i + 1).toString(16).padStart(24, "0")}`]);
  }
  // And one group refund pending for more than a week.
  const stuckPi = "pi_GCostStuck0001";
  marks.push(["SET", `nl:grp:pi:${stuckPi}`, `grp_${"f".repeat(24)}`]);
  await redis.pipeline(marks);
  const stuck = refund("re_GCostStuck0001", stuckPi, NOW - 7 * 86_400 - 100, "pending");
  // Ten full pages of refunds, the most a run reads: the group rows, the rest of other payments, the stuck one the oldest.
  const others = Array.from({ length: 1000 - groups - 1 }, (_, i) => refund(`re_GCostOther${pad(i)}`, `pi_GCostOther${pad(i)}`, NOW - 2000 - i));
  lists.set(ACCOUNT_B, [...parts, ...others, stuck].sort((a, b) => (b.created as number) - (a.created as number)));
  calls.charge = 0;
  calls.events = 0;
  calls.refunds = 0;
  // The store read before the run is counted, so only the job's own commands are.
  const onB = await owner();
  const sent = await recorded(() => groupBuy.revokeRefundedGroups(onB, Date.now() + 120_000, async () => {}));

  const job = new Set([`nl:grp:${sid}:any`, `nl:grp:${sid}:refunds`, `nl:grp:${sid}:refunds:pass`, `nl:grp:${sid}:refunds:acct`, `nl:grp:${sid}:refunds:left`, `nl:lostdispute:cursor:group:${sid}`]);
  const own = sent.filter((c) =>
    job.has(String(c[1])) ||
    c[0] === "EVAL" ||
    (c[0] === "HGETALL" && c[1] === `nl:grp:${sid}:refunds:retry`) ||
    (c[0] === "SMISMEMBER" && c[1] === `nl:grp:${sid}:seen`));
  const held = sent.filter((c) => /^nl:grp:grp_[0-9a-f]{24}:held$/.test(String(c[1])));
  const alerts = sent.filter((c) => /^nl:grp:grp_[0-9a-f]{24}:stuck$/.test(String(c[1])));
  const rows = sent.filter((c) => !own.includes(c) && !held.includes(c) && !alerts.includes(c));
  const handledRows = rows.filter((c) => c[0] === "SISMEMBER").length;
  const otherRows = rows.filter((c) => c[0] === "SADD").length;
  const retried = rows.filter((c) => c[0] === "HDEL" && c[1] === `nl:grp:${sid}:refunds:retry`).length;

  is("ten pages of refunds read", calls.refunds, 10);
  is("the run's own commands are the registry's", own.length, declared?.jobCommands);
  is("its own commands, by kind", own.map((c) => String(c[0])).sort().join(" "), [
    // The start's four GETs, the switch's five, the retry list, the lost disputes' place read, confirmed and let go
    // (read to the end), nine pages kept and the EVAL that ends the pass.
    "GET", "GET", "GET", "GET", "ZSCORE", "ZRANGEBYSCORE", "ZADD", "ZADD", "ZREMRANGEBYRANK", "HGETALL", "GET", "SMISMEMBER", "DEL",
    ...Array.from({ length: 9 }, () => "SET"), "EVAL",
  ].sort().join(" "));
  is("the closing events: the registry's pages", calls.events, declared?.lostDisputePages);
  is("the charges asked: the registry's lookups", calls.charge, declared?.chargeLookups);
  is("the held marks: one GET and one SET a lookup, nothing for a part past them", held.length, (declared?.commandsPerLookup ?? 0) * (declared?.chargeLookups ?? -1));
  is("one alert mark for the refund stuck a week", alerts.map((c) => String(c[0])), ["SET"]);
  is("every row of a payment that paid for no group purchase: the registry's commands, a retry entry one HDEL more", rows.length, otherRows * (declared?.commandsPerOtherRow ?? 0) + retried + 2 * (handledRows - otherRows));
  is("rows of other payments: the retry list, three pages of disputes and the rest of the ten pages", otherRows, 100 + 300 + (1000 - groups - 1));
  is("the retry list let go", retried, 100);

  done();
}

void main();
