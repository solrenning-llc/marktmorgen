/**
 * What the kept refunds (lib/held-refunds.ts) cost each five-minute run, as the cost registry states it (rule 24:
 * unknown is never zero; MR: a ceiling before each cost). Claude 5's pre-review of claude5/plan-refund-own-dispute
 * added, in the three jobs that take a paid thing back on a full refund (lib/call-meetings.ts, lib/licence-keys.ts,
 * lib/review-proof.ts), a read of the kept set every run, up to HELD_REFUND_READS GET /v1/refunds/{id} a job and store
 * a run, a keep (ZCARD, ZADD NX, EXPIRE) on every page of refunds, and the read set's SADD and EXPIRE and the kept
 * set's ZREM for each refund read back; and the cost tests stayed green, because nothing in tests/plan-cost-registry.ts
 * named it (HELD_REFUND_READS is not a name the registry's sweep of lib/ looks for).
 *
 * What fails here:
 *   - the registry without HELD_REFUND_RUN, or without NOT_A_COST.HELD_REFUND_READS naming the module, the three jobs
 *     and every constant lib/held-refunds.ts exports;
 *   - a job's pages in the registry that are not the job's own REFUND_PAGES;
 *   - a job's worst run sending more commands to the kept set and the read set, or more GET /v1/refunds/{id}, than the
 *     registry counts for it (measured on the real job, at its worst: every page with refunds to keep, and
 *     HELD_REFUND_READS kept refunds read back that now give everything back, or that Stripe now answers failed);
 *   - a command the kept refunds read back cause that the measure does not see: every command naming one of them or
 *     the kept set is counted, the read set's EXPIRE sent with its SADD too, and any other command naming one fails
 *     (Claude 5's pre-review of claude5/licence-refunds-combined, MEDIUM: the license keys' SISMEMBER a row read back
 *     went unseen, as did the SMISMEMBER the other two jobs send with their first page).
 *
 * Synthetic only: a stand-in for Stripe's API and the Redis stub.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { revokeRefunded } from "@/lib/licence-keys";
import { markRefundedReviews } from "@/lib/review-proof";
import * as heldModule from "@/lib/held-refunds";
import { HELD_REFUND_MAX_KEPT, HELD_REFUND_READS } from "@/lib/held-refunds";
import { KIND } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_held_refunds_cost_only";
const ACCOUNT = "acct_1TestHeldCost001";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
type Command = (string | number)[];
type Run = { file: string; pages: number; commands: number; stripeReads: number };
type HeldRun = {
  rangeReads: number;
  seenReads: number;
  perMemberRead: number;
  perRowReadBack: number;
  perPageKeep: number;
  pages: Record<string, number>;
  runsPerMonth: number;
  commandsPerJobRun: (file: string) => number;
  stripeReadsPerJobRun: number;
};
const declared = (registry as unknown as { HELD_REFUND_RUN?: HeldRun }).HELD_REFUND_RUN;
const why = (registry.NOT_A_COST as Record<string, string | undefined>).HELD_REFUND_READS;

let refunds: Row[] = [];
let byId = new Map<string, Row>();
let readBack = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const list = (data: unknown[], more = false) => new Response(JSON.stringify({ object: "list", data, has_more: more }));
  const one = url.pathname.match(/^\/v1\/refunds\/([A-Za-z0-9_]+)$/);
  if (one) {
    readBack += 1;
    const found = byId.get(one[1]);
    return found ? new Response(JSON.stringify(found)) : new Response(JSON.stringify({ error: { message: "No such refund" } }), { status: 404 });
  }
  if (url.pathname === "/v1/refunds") {
    const gte = Number(url.searchParams.get("created[gte]") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const after = url.searchParams.get("starting_after");
    const all = refunds.filter((r) => Number(r.created) >= gte).sort((a, b) => Number(b.created) - Number(a.created));
    const from = after ? all.findIndex((r) => r.id === after) + 1 : 0;
    return list(all.slice(from, from + limit), from + limit < all.length);
  }
  if (url.pathname.startsWith("/v1/payment_intents/")) return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "payment_intent", metadata: {} }));
  return list([]);
}) as typeof fetch;

/** Every pipeline the job sent, in order, so the read set's EXPIRE is told apart by the SADD sent with it. */
let sent: Command[][] = [];
const orig = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof orig }).pipeline = async (c) => {
  sent.push(c);
  return orig(c);
};

/** A refund on a charge of 1,000 cents; with no payment, so a job reads it with no lookup of its own. */
function refund(id: string, created: number, status: string, full: boolean): Row {
  return { id: `re_${id}`, object: "refund", status, created, payment_intent: null, charge: { id: `ch_${id}`, object: "charge", refunded: full, amount: 1_000, amount_refunded: full ? 1_000 : 0 } };
}

/**
 * The worst run of one job: HELD_REFUND_READS kept refunds due that now give everything back (each read back, handled
 * and let go: the most commands a member read back can take), or that Stripe now answers `dueStatus`, outside the
 * job's pages; and the job's REFUND_PAGES full pages, each with ten refunds to keep and has_more, so the keep runs on
 * every page and the set stays under its cap.
 */
async function worst(file: string, pages: number, heldKey: string, seenKey: string, run: () => Promise<unknown>, dueStatus = "succeeded"): Promise<Run> {
  redis.clear();
  refunds = [];
  byId = new Map();
  const due: (string | number)[] = [];
  for (let i = 0; i < HELD_REFUND_READS; i += 1) {
    const r = refund(`HeldCostDue${String(i).padStart(4, "0")}x`, NOW - 2 * 86_400, dueStatus, dueStatus === "succeeded");
    byId.set(String(r.id), r);
    due.push(NOW - 60, `${r.id}|${r.created}`);
  }
  await orig([["ZADD", heldKey, ...due]]);
  for (let p = 0; p < pages + 1; p += 1) {
    for (let i = 0; i < 100; i += 1) {
      const keep = i < 10;
      refunds.push(refund(`HeldCostP${p}R${String(i).padStart(3, "0")}x`, NOW - 600 - p * 200 - i, keep ? "pending" : "failed", false));
    }
  }
  sent = [];
  readBack = 0;
  await run();
  const heldIds = new Set([...byId.keys()]);
  const names = (c: Command) => c.slice(2).some((a) => heldIds.has(String(a)));
  const flat = sent.flat();
  const onHeld = flat.filter((c) => c[1] === heldKey).length;
  // The read set asked about them (SISMEMBER a row, or one SMISMEMBER with them in it), whatever else it names.
  const seenReads = flat.filter((c) => c[1] === seenKey && (c[0] === "SISMEMBER" || c[0] === "SMISMEMBER") && names(c)).length;
  const seenOfHeld = flat.filter((c) => c[0] === "SADD" && c[1] === seenKey && names(c)).length;
  // The read set's expiry renewed with the SADD of one of them (once a pipeline).
  const expiries = sent.filter((p) => p.some((c) => c[0] === "SADD" && c[1] === seenKey && names(c)) && p.some((c) => c[0] === "EXPIRE" && c[1] === seenKey)).length;
  // Anything else naming one of them is a cost the registry does not say.
  const other = flat.filter((c) => c[1] !== heldKey && names(c) && !(c[1] === seenKey && ["SISMEMBER", "SMISMEMBER", "SADD"].includes(String(c[0])))).length;
  const kept = ((await orig([["ZCARD", heldKey]]))[0] as number) ?? -1;
  is(`${file} (${dueStatus}): the set stays under its cap in the worst run (${kept} of ${HELD_REFUND_MAX_KEPT})`, kept <= HELD_REFUND_MAX_KEPT, true);
  if (dueStatus === "succeeded") is(`${file}: every kept refund read back was handled and let go`, seenOfHeld, HELD_REFUND_READS);
  is(`${file} (${dueStatus}): every kept refund read back was let go`, (((await orig([["ZRANGEBYSCORE", heldKey, "-inf", "+inf"]]))[0] as string[]) ?? []).filter((m) => heldIds.has(m.split("|")[0])), []);
  is(`${file} (${dueStatus}): no command naming one of them that the measure does not count`, other, 0);
  return { file, pages, commands: onHeld + seenReads + seenOfHeld + expiries, stripeReads: readBack };
}

async function main(): Promise<void> {
  part("The registry names what the kept refunds cost");
  is("HELD_REFUND_RUN is in tests/plan-cost-registry.ts", typeof declared, "object");
  is("NOT_A_COST.HELD_REFUND_READS is there", typeof why, "string");
  const text = why ?? "";
  for (const name of ["lib/held-refunds.ts", "lib/call-meetings.ts", "lib/licence-keys.ts", "lib/review-proof.ts", "GET /v1/refunds/{id}"]) {
    is(`it names ${name}`, text.includes(name), true);
  }
  // Every constant the module exports is said there, so a new one cannot come in unpriced.
  const exported = Object.keys(heldModule).filter((name) => /^[A-Z][A-Z0-9_]+$/.test(name));
  is("it names every constant lib/held-refunds.ts exports", exported.filter((name) => !text.includes(name)), []);

  part("The pages counted are each job's own");
  const pagesOf = (file: string) => Number(readFileSync(join(process.cwd(), file), "utf8").match(/^const REFUND_PAGES = (\d+);$/m)?.[1]);
  for (const file of ["lib/call-meetings.ts", "lib/licence-keys.ts", "lib/review-proof.ts"]) {
    is(`${file}: REFUND_PAGES as the registry counts it`, declared?.pages[file], pagesOf(file));
  }

  part("Each job's worst run, measured, against the registry");
  const runs: Run[] = [];
  const callsId = "h".repeat(16);
  const callStore = { statsId: "i".repeat(32), callsId, stripeAccountId: ACCOUNT, handle: "held-cost-calls", previousHandles: [] } as unknown as Store;
  runs.push(
    await worst("lib/call-meetings.ts", pagesOf("lib/call-meetings.ts"), `nl:meet:rf:${callsId}:held`, `nl:meet:rf:${callsId}:seen`, async () => {
      await orig([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|held-cost-calls`]]);
      return syncMeetings(async (h) => (h === "held-cost-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
    }),
  );
  const keysStore = { statsId: "j".repeat(32), stripeAccountId: ACCOUNT, handle: "held-cost-keys", previousHandles: [], catalog: { items: [{ id: "keyproduct", kind: KIND.paid | KIND.keys }] } } as unknown as Store;
  runs.push(await worst("lib/licence-keys.ts", pagesOf("lib/licence-keys.ts"), `nl:keys:${keysStore.statsId}:refunds:held`, `nl:keys:${keysStore.statsId}:refunds:seen`, () => revokeRefunded(keysStore, Date.now() + 60_000)));
  const reviewStore = { statsId: "m".repeat(32), stripeAccountId: ACCOUNT, handle: "held-cost-reviews", previousHandles: [] } as unknown as Store;
  runs.push(await worst("lib/review-proof.ts", pagesOf("lib/review-proof.ts"), `nl:rev:refunds:held:${reviewStore.statsId}`, `nl:rev:refunds:seen:${reviewStore.statsId}`, () => markRefundedReviews(reviewStore, Date.now() + 60_000)));
  for (const run of runs) {
    console.log(`    ${run.file}: ${run.commands} commands, ${run.stripeReads} GET /v1/refunds/{id} in its worst run`);
    is(`${run.file}: the commands of its worst run are the registry's`, run.commands, declared?.commandsPerJobRun(run.file));
    is(`${run.file}: the refunds read back by id are the registry's`, run.stripeReads, declared?.stripeReadsPerJobRun);
  }

  part("Kept refunds Stripe now answers failed: the license keys read them as rows (HIGH 1), never past the registry");
  const ended = [
    await worst("lib/call-meetings.ts", pagesOf("lib/call-meetings.ts"), `nl:meet:rf:${callsId}:held`, `nl:meet:rf:${callsId}:seen`, async () => {
      await orig([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|held-cost-calls`]]);
      return syncMeetings(async (h) => (h === "held-cost-calls" ? callStore : null), Date.now() + 60_000, "https://marktmorgen.com");
    }, "failed"),
    await worst("lib/licence-keys.ts", pagesOf("lib/licence-keys.ts"), `nl:keys:${keysStore.statsId}:refunds:held`, `nl:keys:${keysStore.statsId}:refunds:seen`, () => revokeRefunded(keysStore, Date.now() + 60_000), "failed"),
    await worst("lib/review-proof.ts", pagesOf("lib/review-proof.ts"), `nl:rev:refunds:held:${reviewStore.statsId}`, `nl:rev:refunds:seen:${reviewStore.statsId}`, () => markRefundedReviews(reviewStore, Date.now() + 60_000), "failed"),
  ];
  for (const run of ended) {
    console.log(`    ${run.file}: ${run.commands} commands, ${run.stripeReads} GET /v1/refunds/{id} with the kept ones failed`);
    is(`${run.file}: with the kept ones failed, within the registry's commands`, run.commands <= (declared?.commandsPerJobRun(run.file) ?? -1), true);
  }
  const keysEnded = ended.find((run) => run.file === "lib/licence-keys.ts");
  is(`${keysEnded?.file}: a failed one read back costs what one that went through does`, keysEnded?.commands, declared?.commandsPerJobRun("lib/licence-keys.ts"));

  part("The month, per store, as the registry says it");
  if (declared) {
    const perRun = runs.reduce((sum, run) => sum + declared.commandsPerJobRun(run.file), 0);
    const month = perRun * declared.runsPerMonth;
    console.log(`    per store: ${perRun} commands a run, ${month} a month; ${runs.length * declared.stripeReadsPerJobRun * declared.runsPerMonth} GET /v1/refunds/{id} a month`);
    is("the month's commands are written in NOT_A_COST.HELD_REFUND_READS", text.includes(month.toLocaleString("en-US")), true);
    is("and the month's reads by id", text.includes((runs.length * declared.stripeReadsPerJobRun * declared.runsPerMonth).toLocaleString("en-US")), true);
  }
  done();
}

void main();
