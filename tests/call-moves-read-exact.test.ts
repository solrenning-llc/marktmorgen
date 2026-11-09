/**
 * A booking's move, read only in its exact shape (CX-123 rule 24; audit r24 round 5, finding 5). Synthetic only: the
 * in-memory Redis double, through lib/call-records.ts readMoves, lib/affiliate-leads.ts bookingEnds and the real route
 * app/api/store/affiliates/route.ts.
 *
 * readMoves turned every reply it could not read into "this booking was never moved": an MGET answered in another
 * shape, a pipeline cut short, a value that was not null and not a string, or a string that was not a move. The
 * booking was then read at its old time everywhere:
 *   - the reminder job (lib/call-reminders.ts) took the reminder planned for the real time for one planned before a
 *     move and dropped it for good, and the pending confirmation went out with the old time;
 *   - a move (lib/calls.ts moveBooking) read `moves: 0`, so MAX_MOVES stopped holding, and the old reminders and the
 *     "moved from" email named the wrong time;
 *   - the creator's approval of a booking lead (decideLeads "approve") judged the call over at its old end, so a lead
 *     was approved, and its commission made payable, before the moved call took place.
 * Now readMoves throws UnknownReplyError on any of those, and each of them refuses or tries again later: the approval
 * answers 503 "unavailable" and the lead stays open.
 *
 * Controls: a key that is gone (or holds no string, which MGET answers null) is never moved; healthy moves read as
 * written, a hundred keys an MGET; no session reads nothing; a healthy later move keeps the lead waiting
 * ("lead_not_ready"); a booking never moved is approved.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { type LeadRecord, leadsKey } from "@/lib/affiliate-lead-rules";
import { bookingEnds } from "@/lib/affiliate-leads";
import { movedKey, readMoves, writeMove } from "@/lib/call-records";
import { UnknownReplyError } from "@/lib/redis-reply";
import { POST as affiliatesRoute } from "@/app/api/store/affiliates/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const real = redis.pipeline.bind(redis);
/** What the next pipeline of MGETs of moves is answered with, instead of the database's own reply. */
let answer: ((replies: unknown[]) => unknown) | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const moves = commands.length > 0 && commands.every((c) => c[0] === "MGET" && String(c[1]).startsWith("nl:call:moved:"));
  const replies = await real(commands);
  return moves && answer ? answer(replies) : replies;
}) as typeof redis.pipeline;

const session = (i: number) => `cs_test_${String(i).padStart(24, "0")}`;

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return `no error: ${JSON.stringify(value instanceof Map ? [...value.entries()] : value)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const ANA = "aaaaaaaaaaaa";
const id = (n: number) => n.toString(16).padStart(24, "0");

async function main(): Promise<void> {
  redis.clear();

  part("Controls: gone, no string, healthy, none");
  const sessions = Array.from({ length: 150 }, (_, i) => session(i));
  await writeMove(sessions[0], { s: 10, e: 20, n: 1 });
  await writeMove(sessions[120], { s: 30, e: 40, n: 0 });
  await real([["HSET", movedKey(sessions[5]), "s", "10"]]);
  is(
    "a key gone or holding a hash (MGET answers null) is never moved; the healthy moves read as written",
    [...(await readMoves(sessions)).entries()],
    [[sessions[0], { s: 10, e: 20, n: 1 }], [sessions[120], { s: 30, e: 40, n: 0 }]],
  );
  is("no session, or only empty ones, reads nothing", [(await readMoves([])).size, (await readMoves(["", ""])).size], [0, 0]);

  part("A reply of another shape is never \"never moved\"");
  const shapes: [string, (replies: unknown[]) => unknown][] = [
    ["the pipeline answered with a string", () => "x"],
    ["the pipeline answered null", () => null],
    ["the pipeline cut short (one MGET of two answered)", (replies) => replies.slice(0, 1)],
    ["an MGET answered with a string", (replies) => [replies[0], "x"]],
    ["an MGET answered with an object", (replies) => [{ a: 1 }, replies[1]]],
    ["an MGET answered with fewer values than keys", (replies) => [(replies[0] as unknown[]).slice(0, 99), replies[1]]],
    ["an MGET answered with more values than keys", (replies) => [replies[0], [...(replies[1] as unknown[]), null]]],
    ["a value that is a number", (replies) => [replies[0], (replies[1] as unknown[]).map((v, i) => (i === 3 ? 7 : v))]],
    ["a value that is a list", (replies) => [replies[0], (replies[1] as unknown[]).map((v, i) => (i === 3 ? ["x"] : v))]],
  ];
  for (const [what, shape] of shapes) {
    answer = shape;
    is(`${what}: readMoves throws UnknownReplyError`, await thrown(() => readMoves(sessions)), "UnknownReplyError");
    answer = null;
  }

  part("A kept value that is not a move is never \"never moved\"");
  const unreadable: [string, string][] = [
    ["broken JSON", "{not json"],
    ["the JSON null", "null"],
    ["a number", "5"],
    ["a list", "[1,2,3]"],
    ["an end before its start", JSON.stringify({ s: 20, e: 10, n: 1 })],
    ["a count that is not whole", JSON.stringify({ s: 10, e: 20, n: 1.5 })],
    ["a count below zero", JSON.stringify({ s: 10, e: 20, n: -1 })],
    ["a start as text", JSON.stringify({ s: "10", e: 20, n: 1 })],
    ["no count", JSON.stringify({ s: 10, e: 20 })],
  ];
  for (const [what, value] of unreadable) {
    await real([["SET", movedKey(sessions[7]), value]]);
    is(`${what}: readMoves throws UnknownReplyError`, await thrown(() => readMoves(sessions)), "UnknownReplyError");
    is(`${what}: read alone, it throws too`, await thrown(() => readMoves([sessions[7]])), "UnknownReplyError");
  }
  await real([["DEL", movedKey(sessions[7])]]);
  is("the broken value gone, the same read is whole again", (await readMoves(sessions)).size, 2);

  part("A booking lead is never approved before a move that could not be read");
  const OWNER = "moves-read@example.com";
  await claimHandle(OWNER, "movesread", "Moves Read", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, `acct_1${"movesread".padEnd(15, "x")}`, true);
  await setSubscription(OWNER, { customerId: "cus_movesread", subscriptionId: "sub_movesread", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER)) as Store;
  const key = leadsKey(store.statsId as string);
  const cookie = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const booked = session(900);
  // A booking bought for a call that ended twenty days ago, its week's hold long passed: ready for approval, unless
  // its buyer moved it.
  const lead: LeadRecord = {
    id: id(1),
    aff: ANA,
    kind: "booking",
    at: NOW - 30 * DAY,
    end: NOW - 20 * DAY,
    ref: booked,
    pi: "pi_moves_read",
    paid: 9_900,
    title: "",
    email: "buyer@example.com",
    cents: 500,
    currency: "usd",
    hold: 7,
    daily: 10,
    budget: 1_000,
    state: "open",
    d: 0,
    why: "",
  };
  const approve = async () => {
    const response = await affiliatesRoute(
      new NextRequest("https://marktmorgen.com/api/store/affiliates", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "leads", ids: [id(1)], decision: "approve" }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; changed?: number } };
  };
  const reset = async () => {
    await real([["DEL", key, movedKey(booked)]]);
    await real([["HSET", key, id(1), JSON.stringify(lead)]]);
  };
  const stateOf = async () => (JSON.parse(String((await real([["HGET", key, id(1)]]))[0])) as LeadRecord).state;

  // Moved to tomorrow: the call has not taken place.
  await reset();
  await writeMove(booked, { s: (NOW + DAY) * 1000, e: (NOW + DAY + 3_600) * 1000, n: 1 });
  is("control: moved to tomorrow, the lead waits for the call", [await approve(), await stateOf()], [{ status: 400, body: { ok: false, error: "lead_not_ready" } }, "open"]);
  is("control: bookingEnds reads the moved end", [...(await bookingEnds([lead])).entries()], [[booked, NOW + DAY + 3_600]]);

  await reset();
  await real([["SET", movedKey(booked), `{"s":${(NOW + DAY) * 1000},"e":`]]);
  is("the move kept but unreadable: bookingEnds throws UnknownReplyError", await thrown(() => bookingEnds([lead])), "UnknownReplyError");
  is("the move kept but unreadable: the approval answers 503 and the lead stays open", [await approve(), await stateOf()], [{ status: 503, body: { ok: false, error: "unavailable" } }, "open"]);

  await reset();
  await writeMove(booked, { s: (NOW + DAY) * 1000, e: (NOW + DAY + 3_600) * 1000, n: 1 });
  answer = () => ["x"];
  is("the moves' MGET answered in another shape: bookingEnds throws UnknownReplyError", await thrown(() => bookingEnds([lead])), "UnknownReplyError");
  is("the moves' MGET answered in another shape: the approval answers 503 and the lead stays open", [await approve(), await stateOf()], [{ status: 503, body: { ok: false, error: "unavailable" } }, "open"]);
  answer = null;

  await reset();
  is("control: never moved (the key gone), the lead is approved", [await approve(), await stateOf()], [{ status: 200, body: { ok: true, changed: 1 } }, "approved"]);

  done();
}

void main();
