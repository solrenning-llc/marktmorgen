/**
 * A refund Stripe has not finished is kept for a later look, with an end, in the jobs that take a paid thing back on
 * a full refund (rule 30; Claude 5's pre-review of claude5/plan-refund-own-dispute, lib/held-refunds.ts). The branch
 * first held each job's anchor at the oldest such refund, with no end: every later run re-read every refund since it,
 * one Redis command a row, and once more than the job's pages of refunds came after it (Stripe lists newest first)
 * the run never got down to it again, so it was never read when it went through. A row with no `created` dragged the
 * anchor back five minutes a run. Synthetic Stripe with real pagination (limit, starting_after, has_more), in-memory
 * Redis; nothing real is reached.
 *
 * What fails here, for the call meetings (lib/call-meetings.ts) and the license keys (lib/licence-keys.ts):
 *   - a quiet run, nothing new, issuing a Redis command for every refund already read;
 *   - an unfinished refund, past the job's pages of later refunds, never read again once it goes through;
 *   - an anchor moved backwards by a row with no `created`;
 *   - an unfinished refund kept past HELD_REFUND_MAX_SECONDS, or read back more often than HELD_REFUND_RECHECK_SECONDS;
 *   - a kept refund let go on a reply that is not its own;
 *   - more than HELD_REFUND_MAX_KEPT kept, or one not kept and the anchor moved past it all the same.
 */
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { revokeRefunded } from "@/lib/licence-keys";
import { HELD_REFUND_MAX_KEPT, HELD_REFUND_MAX_SECONDS, HELD_REFUND_RECHECK_SECONDS } from "@/lib/held-refunds";
import { KIND } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_anchor_ceiling_only";
const ACCOUNT = "acct_1TestPrerevCeil01";
const realNow = Date.now;
let shift = 0;
Date.now = () => realNow() + shift;

type Row = Record<string, unknown>;
let refunds: Row[] = [];
const lookedUp: string[] = [];
const readBack: string[] = [];
/** A refund id whose GET /refunds/{id} answers another refund (not its own reply). */
let answerWrong = "";
let stripeCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  stripeCalls += 1;
  const list = (data: unknown[], more = false) => new Response(JSON.stringify({ object: "list", data, has_more: more }));
  if (url.pathname === "/v1/checkout/sessions") {
    lookedUp.push(String(url.searchParams.get("payment_intent")));
    return list([]);
  }
  // Rule 23: the pre-review draft's stand-in answered only the refunds list. Kept refunds are now read back by id
  // (GET /v1/refunds/{id}, docs.stripe.com/api/refunds/retrieve), so the stand-in answers that too, with the row.
  const one = url.pathname.match(/^\/v1\/refunds\/([A-Za-z0-9_]+)$/);
  if (one) {
    readBack.push(one[1]);
    const found = refunds.find((r) => r.id === one[1]);
    if (!found) return new Response(JSON.stringify({ error: { message: "No such refund" } }), { status: 404 });
    return new Response(JSON.stringify(one[1] === answerWrong ? { ...found, id: "re_SomeoneElse01" } : found));
  }
  if (url.pathname === "/v1/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    const all = refunds.filter((r) => r.created === undefined || Number(r.created) >= gte).sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0));
    const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    const data = all.slice(from, from + limit);
    return list(data, from + limit < all.length);
  }
  if (url.pathname.startsWith("/v1/payment_intents/")) return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "payment_intent", metadata: {} }));
  return list([]);
}) as typeof fetch;

let cmds = 0;
let trips = 0;
const orig = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof orig }).pipeline = async (c) => {
  cmds += c.length;
  trips += 1;
  return orig(c);
};

function refund(id: string, created: number, status: string, full: boolean): Row {
  return { id: `re_${id}`, object: "refund", status, created, payment_intent: `pi_${id}`, charge: { id: `ch_${id}`, object: "charge", refunded: full, amount: 1_000, amount_refunded: full ? 1_000 : 0 } };
}
const anchorOf = async (key: string) => Number((await orig([["GET", key]]))[0]);
const keptOf = async (key: string) => ((await orig([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[]).map((m) => m.split("|")[0]);
const step = () => {
  shift += 5 * 60_000;
};

type Job = { name: string; run: () => Promise<unknown>; anchor: string; held: string; seen: string };

async function scenarios(job: Job): Promise<void> {
  redis.clear();
  // Each job from the clock as it stands: the first job's runs move it on by more than a month.
  const NOW = Math.floor(Date.now() / 1000);
  part(`${job.name}: a quiet run while a refund is unfinished`);
  const held = refund(`${job.name}Held01`, NOW - 30_000, "requires_action", false);
  refunds = [held];
  // 150 later full refunds, handled over several runs (each run looks up at most its REFUND_LOOKUPS).
  for (let i = 0; i < 150; i += 1) refunds.push(refund(`${job.name}Later${String(i).padStart(4, "0")}x`, NOW - 29_000 + i * 60, "succeeded", true));
  await job.run();
  // Enough runs for the slower job: a license key's refund may take three lookups of its twenty a run.
  for (let k = 0; k < 40; k += 1) {
    step();
    await job.run();
  }
  // Rule 23: the draft asserted "anchor still held at the unfinished refund" (anchor <= its time). The hold had no end
  // and is gone: the refund is kept by its id instead, and the anchor moves on.
  is("the unfinished refund is kept for a later look", await keptOf(job.held), [String(held.id)]);
  is("and the anchor moves on past it", (await anchorOf(job.anchor)) > NOW - 30_000, true);
  step();
  cmds = 0;
  trips = 0;
  stripeCalls = 0;
  await job.run();
  is("a quiet run (nothing new) issues at most ~10 Redis commands", cmds <= 20, true);
  console.log(`    quiet run while held: ${cmds} Redis commands in ${trips} round trips, ${stripeCalls} Stripe calls`);

  part(`${job.name}: past REFUND_PAGES x 100 newer refunds, the kept one is read once it goes through`);
  for (let i = 150; i < 600; i += 1) refunds.push(refund(`${job.name}Later${String(i).padStart(4, "0")}x`, NOW - 29_000 + i * 60, "succeeded", true));
  for (let k = 0; k < 60; k += 1) {
    step();
    await job.run();
  }
  held.status = "succeeded";
  held.charge = { ...(held.charge as Row), refunded: true, amount_refunded: 1_000 };
  lookedUp.length = 0;
  // Read back at most once an hour while unfinished: within an hour and a run it is due again.
  for (let k = 0; k < HELD_REFUND_RECHECK_SECONDS / 300 + 1; k += 1) {
    step();
    await job.run();
  }
  is("once it goes through, the held refund's payment is looked up", lookedUp.includes(String(held.payment_intent)), true);
  is("it is taken as read", (await orig([["SISMEMBER", job.seen, String(held.id)]]))[0], 1);
  is("and let go", await keptOf(job.held), []);

  part(`${job.name}: a row with no \`created\` never drags the anchor back`);
  redis.clear();
  refunds = [{ ...refund(`${job.name}NoCreated01`, 0, "pending", false), created: undefined }, refund(`${job.name}FreshFull01`, NOW + 1_000_000, "succeeded", true)];
  step();
  await job.run();
  const a1 = await anchorOf(job.anchor);
  step();
  await job.run();
  const a2 = await anchorOf(job.anchor);
  console.log(`    anchors: ${a1} -> ${a2}`);
  is("the anchor never moves backwards", a2 >= a1, true);

  part(`${job.name}: a kept refund has an end, and is read back at most once an hour`);
  redis.clear();
  const stuck = refund(`${job.name}Stuck01`, Math.floor(Date.now() / 1000) - 60, "pending", false);
  refunds = [stuck];
  await job.run();
  is("kept", await keptOf(job.held), [String(stuck.id)]);
  readBack.length = 0;
  for (let k = 0; k < 24; k += 1) {
    step();
    await job.run();
  }
  const reads = readBack.filter((id) => id === stuck.id).length;
  console.log(`    read back ${reads} times in two hours`);
  is("read back, but at most once an hour after its first look", reads >= 1 && reads <= 3, true);
  answerWrong = String(stuck.id);
  shift += HELD_REFUND_RECHECK_SECONDS * 1_000;
  await job.run();
  is("a reply that is not its own keeps it", await keptOf(job.held), [String(stuck.id)]);
  answerWrong = "";
  shift += (HELD_REFUND_MAX_SECONDS + 60) * 1_000;
  readBack.length = 0;
  await job.run();
  is("past its ceiling it is let go", await keptOf(job.held), []);
  is("without a request", readBack.includes(String(stuck.id)), false);

  part(`${job.name}: a refund that ends without giving everything back is let go`);
  redis.clear();
  const failing = refund(`${job.name}Failing01`, Math.floor(Date.now() / 1000) - 60, "requires_action", false);
  refunds = [failing];
  await job.run();
  failing.status = "failed";
  step();
  step();
  await job.run();
  is("failed: let go", await keptOf(job.held), []);

  part(`${job.name}: at most HELD_REFUND_MAX_KEPT kept; one more keeps the anchor instead`);
  redis.clear();
  const t = Math.floor(Date.now() / 1000);
  const fill: (string | number)[] = [];
  for (let i = 0; i < HELD_REFUND_MAX_KEPT; i += 1) fill.push(t + 86_400, `re_${job.name}Fill${String(i).padStart(4, "0")}x|${t - 60}`);
  await orig([["ZADD", job.held, ...fill]]);
  const extra = refund(`${job.name}Extra01`, t - 120, "requires_action", false);
  refunds = [extra, refund(`${job.name}After01`, t - 60, "succeeded", true)];
  await job.run();
  const kept = await keptOf(job.held);
  is("the set stays at its cap", [kept.length, kept.includes(String(extra.id))], [HELD_REFUND_MAX_KEPT, false]);
  is("and the anchor does not move past the one not kept", (await anchorOf(job.anchor)) <= t - 120, true);
}

async function main(): Promise<void> {
  const callsId = "p".repeat(16);
  const callStore = { statsId: "q".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "ceil-calls", previousHandles: [] } as unknown as Store;
  await scenarios({
    name: "Calls",
    run: async () => {
      await orig([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|ceil-calls`]]);
      return syncMeetings(async (h) => (h === "ceil-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
    },
    anchor: `nl:meet:rf:${callsId}:since`,
    held: `nl:meet:rf:${callsId}:held`,
    seen: `nl:meet:rf:${callsId}:seen`,
  });

  const keysStore = { statsId: "k".repeat(32), stripeAccountId: ACCOUNT, handle: "ceil-keys", previousHandles: [], catalog: { items: [{ id: "keyproduct", kind: KIND.paid | KIND.keys }] } } as unknown as Store;
  await scenarios({
    name: "Keys",
    run: () => revokeRefunded(keysStore, Date.now() + 60_000),
    anchor: `nl:keys:${keysStore.statsId}:refunds:since`,
    held: `nl:keys:${keysStore.statsId}:refunds:held`,
    seen: `nl:keys:${keysStore.statsId}:refunds:seen`,
  });
  done();
}

void main();
