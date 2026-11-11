/**
 * A booking's move, and the reminders and calendar marks after it, written only on an exact reply (CX-123 rules 24
 * and 30; Claude 6, audit r24 round 8, finding 3). Synthetic only: the in-memory Redis and a stand-in for Stripe and
 * the mail provider, through the real lib/calls.ts moveBooking and lib/call-records.ts.
 *
 * writeMove sent the SET of `nl:call:moved:<session>` and never read its reply. When the move was not written (a
 * reply in another shape), moveBooking went on as if it were: the diary took the new time, the old reminders were
 * dropped, new ones planned, and the buyer and the creator were emailed "moved to X". readMoves still gave the old
 * time, so the reminder job dropped the reminders for the real time for good, a second move started from the wrong
 * time and count (MAX_MOVES), and a booking lead could be approved by the old end (lib/affiliate-leads.ts).
 *
 * Now the move is written on an exact "OK"; any other reply is read back once, and only the key holding exactly this
 * move counts as written; anything else throws UnknownReplyError, so moveBooking refuses ("error") before the diary,
 * the reminders and the emails. planReminders, planCheck and markBookingsChanged read their ZADD (0 or 1), SET ("OK"),
 * INCRBY (one or more) and EXPIRE (0 or 1) replies exactly too and throw otherwise; their callers already log the throw
 * and go on, so the healthy path is unchanged.
 *
 * A move left half-written (its key kept while both its reply and the read-back came in another shape, so the move
 * was refused and the diary kept the old time) is finished by a retry of the same move: the diary, the confirmed mark,
 * the reminders, the emails and a team's host claim end at the new time, the move counted once; a retry whose new time
 * was taken since is refused as taken, never booked twice (Claude 2's LOW 1 on #3303).
 *
 * Controls: a healthy move is written, the diary and readMoves agree, the reminders are planned at the new time and
 * the emails go out; planning the same reminders twice (ZADD 0) is fine.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import type { Product, Store } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { type CallListing, holdAndCheckout, moveBooking } from "@/lib/calls";
import { type CallSetup, zonedToUtc } from "@/lib/call-setup";
import { REMINDER_QUEUE, markBookingsChanged, movedKey, planCheck, planReminders, readMoves } from "@/lib/call-records";
import { UnknownReplyError } from "@/lib/redis-reply";
import { writeTeam } from "@/lib/team-booking";
import { hostId, readClaims } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NY = "America/New_York";

let opened = 0;
let mails = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails += 1;
    return answer({ id: `e${mails}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/checkout/sessions") {
    opened += 1;
    const id = `cs_test_movewrite${String(opened).padStart(10, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/**
 * While set, the reply put in place of the real one for a command: `moved` for the SET of a booking's move (which is
 * then not run at all, so the move is really not written), `zadd` for a ZADD to the reminder queue, `changed` for the
 * SET, INCRBY or EXPIRE of a store's calendar mark (named by its command). `landed` answers the move's SET in another
 * shape after running it (the move is written), and `get` answers the GET that reads a move back.
 */
const swap: {
  moved?: { value: unknown };
  landed?: { value: unknown };
  get?: { value: unknown };
  zadd?: { value: unknown };
  changed?: { command: string; value: unknown };
} = {};
const run = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const skipped = commands.map((c) => swap.moved !== undefined && c[0] === "SET" && String(c[1]).startsWith("nl:call:moved:"));
  const kept = commands.filter((_, i) => !skipped[i]);
  const real = kept.length ? await run(kept) : [];
  let k = 0;
  return commands.map((c, i) => {
    if (skipped[i]) return swap.moved?.value;
    const reply = real[k++];
    const key = String(c[1] ?? "");
    if (swap.landed && c[0] === "SET" && key.startsWith("nl:call:moved:")) return swap.landed.value;
    if (swap.get && c[0] === "GET" && key.startsWith("nl:call:moved:")) return swap.get.value;
    if (c[0] === "ZADD" && key === REMINDER_QUEUE && swap.zadd) return swap.zadd.value;
    if (swap.changed && c[0] === swap.changed.command && key.startsWith("nl:cal:chg:")) return swap.changed.value;
    return reply;
  });
}) as typeof redis.pipeline;
function unswap(): void {
  delete swap.moved;
  delete swap.landed;
  delete swap.get;
  delete swap.zadd;
  delete swap.changed;
}

const WEEKDAYS: [number, number][][] = [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []];
const weekly = {
  kind: "weekly",
  minutes: 60,
  tz: NY,
  weekly: WEEKDAYS,
  noticeHours: 1,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

function weekdayAt(days: number, minute: number): number {
  for (let d = days; d < days + 8; d += 1) {
    const day = new Date(Date.now() + d * DAY);
    const p = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    if (get("weekday") === "Sat" || get("weekday") === "Sun") continue;
    return zonedToUtc(Number(get("year")), Number(get("month")), Number(get("day")), minute, NY) as number;
  }
  throw new Error("no weekday");
}

type World = { store: Store; call: CallListing; full: Product & { call: CallSetup } };

async function callStore(email: string, handle: string, account: string): Promise<World> {
  return callStoreAs(email, handle, account, "creator");
}

async function callStoreAs(email: string, handle: string, account: string, tier: "creator" | "pro"): Promise<World> {
  await claimHandle(email, handle, `${handle} studio`, "");
  await ensureStatsId(email);
  await setStripeAccount(email, account, true);
  await setSubscription(email, { customerId: `cus_${handle}00001`, subscriptionId: `sub_${handle}00001`, active: true, tier, period: paidPeriod() });
  const made = await addProduct(email, "Strategy call", "", "120", null);
  if (!made.ok) throw new Error("no product");
  await setProductCall(email, made.product.id, weekly);
  const store = (await storeForEmail(email)) as Store;
  const call = (await readListing(store, made.product.id)) as CallListing;
  const full = (await readProduct(store, call.id)) as Product & { call: CallSetup };
  return { store, call, full };
}

async function sellSession(w: World, start: number): Promise<string> {
  const held = await holdAndCheckout({ store: w.store, product: w.full, start, buyerTz: NY, origin: "https://marktmorgen.com" });
  if (!held.ok) throw new Error(`no checkout: ${held.reason}`);
  return held.session;
}

const diaryOf = (w: World) => `nl:call:busy:${w.store.callsId}`;

/** Every diary entry written for a session, whatever its field, as its start and `until`. */
async function diaryOfSession(w: World, session: string): Promise<{ s: number; until: number }[]> {
  const [flat] = await run([["HGETALL", diaryOf(w)]]);
  const rows = flat as string[];
  const out: { s: number; until: number }[] = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const entry = JSON.parse(rows[i + 1]) as { s?: number; until: number; session?: string };
    if (entry.session === session) out.push({ s: entry.s ?? Number(rows[i]), until: entry.until });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** The start of a session's one diary entry (null when it has none or more than one). */
async function diaryStart(w: World, session: string): Promise<number | null> {
  const rows = await diaryOfSession(w, session);
  return rows.length === 1 ? rows[0].s : null;
}
const lockOf = (w: World) => `nl:call:lock:${w.store.callsId}`;

/** The reminder queue's members for a session. */
async function queued(session: string): Promise<string[]> {
  const [rows] = await run([["ZRANGEBYSCORE", REMINDER_QUEUE, "-inf", "+inf"]]);
  return (rows as string[]).filter((m) => m.includes(`|${session}|`)).sort();
}

async function thrown(go: () => Promise<unknown>): Promise<string> {
  try {
    await go();
    return "no error";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_move_write_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const w = await callStore("movewrite@example.com", "movewrite", "acct_1MoveWrite");
  const move = (session: string, from: number, to: number) =>
    moveBooking({ store: w.store, product: w.call, session, booked: { start: from, end: from + HOUR, email: "buyer@example.com", buyerTz: NY }, start: to, origin: "https://marktmorgen.com" });

  part("Control: a healthy move is written, and the diary, the reminders and the emails follow it");
  const A = weekdayAt(10, 600);
  const healthy = await sellSession(w, A);
  let sent = mails;
  const done1 = await move(healthy, A, A + 3 * HOUR);
  is("the move is reported as done", done1.ok ? [done1.start, done1.moves] : done1, [A + 3 * HOUR, 1]);
  is("readMoves gives the new time", (await readMoves([healthy])).get(healthy), { s: A + 3 * HOUR, e: A + 4 * HOUR, n: 1 });
  const [entry] = await run([["HGET", diaryOf(w), healthy]]);
  is("the diary has the new time", (JSON.parse(String(entry)) as { s: number }).s, A + 3 * HOUR);
  is(
    "the reminders are planned for the new time",
    (await queued(healthy)).filter((m) => !m.includes("|c|")),
    [`|1|${A + 3 * HOUR}`, `|24|${A + 3 * HOUR}`].map((tail) => `${w.store.callsId}|movewrite|${healthy}${tail}`),
  );
  is("the move emails go out", mails > sent, true);
  const firstMoveMails = mails - sent;

  part("A move's SET answered in another shape is not written, and nothing after it happens");
  const shapes: [string, unknown][] = [
    ["nothing (undefined)", undefined],
    ["null", null],
    ["a number", 1],
    ["other text", "QUEUED"],
    ["a list holding OK", ["OK"]],
    ["an object", { ok: true }],
  ];
  // One weekday each, none of them the healthy one's: weekdayAt skips a weekend to the Monday after it.
  const days = [...new Set(Array.from({ length: 16 }, (_, i) => weekdayAt(11 + i, 600)))].filter((t) => t !== A);
  for (const [n, [what, value]] of shapes.entries()) {
    const B = days[n];
    const session = await sellSession(w, B);
    const [diaryBefore] = await run([["HGET", diaryOf(w), session]]);
    const queueBefore = await queued(session);
    await run([["DEL", lockOf(w)]]);
    sent = mails;
    swap.moved = { value };
    const result = await move(session, B, B + 2 * HOUR);
    unswap();
    is(`SET as ${what}: the move is refused`, result, { ok: false, reason: "error" });
    is(`SET as ${what}: no "moved" email to the buyer or the creator`, mails - sent, 0);
    const [diaryAfter] = await run([["HGET", diaryOf(w), session]]);
    is(`SET as ${what}: the diary keeps the time the buyer paid for`, diaryAfter, diaryBefore);
    is(`SET as ${what}: no move is read, and none was kept`, [(await readMoves([session])).size, (await run([["EXISTS", movedKey(session)]]))[0]], [0, 0]);
    is(`SET as ${what}: the reminders are not touched`, await queued(session), queueBefore);
  }

  part("A move that landed though its SET was answered in another shape is read back, and is done");
  const L = days[shapes.length + 1];
  const landed = await sellSession(w, L);
  await run([["DEL", lockOf(w)]]);
  sent = mails;
  swap.landed = { value: undefined };
  const readBack = await move(landed, L, L + 2 * HOUR);
  unswap();
  is("the move is reported as done, as readMoves gives it", [readBack.ok ? readBack.start : readBack, (await readMoves([landed])).get(landed)?.s], [L + 2 * HOUR, L + 2 * HOUR]);
  is("the diary has the new time, and the emails go out", [(JSON.parse(String((await run([["HGET", diaryOf(w), landed]]))[0])) as { s: number }).s, mails > sent], [L + 2 * HOUR, true]);

  const G = days[shapes.length + 2];
  const unread = await sellSession(w, G);
  const [unreadBefore] = await run([["HGET", diaryOf(w), unread]]);
  await run([["DEL", lockOf(w)]]);
  sent = mails;
  swap.landed = { value: undefined };
  swap.get = { value: ["x"] };
  const unreadMove = await move(unread, G, G + 2 * HOUR);
  unswap();
  is("a SET and its read-back both in another shape: the move is refused", unreadMove, { ok: false, reason: "error" });
  is("…with no email, and the diary as it was", [mails - sent, (await run([["HGET", diaryOf(w), unread]]))[0]], [0, unreadBefore]);

  part("A move left half-written (the move kept, the diary not) is finished by a retry of the same move, once");
  // Claude 2's LOW 1 on #3303: the SET landed while it and its read-back both answered in another shape. The move
  // was refused, readMoves already gave the new time and the diary the old one; a retry answered "same" for good.
  const H = days[0] + 4 * HOUR;
  const half = await sellSession(w, H);
  await run([["DEL", lockOf(w)]]);
  swap.landed = { value: undefined };
  swap.get = { value: ["x"] };
  const refused = await move(half, H, H + 2 * HOUR);
  unswap();
  is("half-written: the first try is refused", refused, { ok: false, reason: "error" });
  is("half-written: readMoves gives the new time, the diary the old one", [(await readMoves([half])).get(half), (await diaryStart(w, half))], [{ s: H + 2 * HOUR, e: H + 3 * HOUR, n: 1 }, H]);
  await run([["DEL", lockOf(w)]]);
  sent = mails;
  const retried = await move(half, H, H + 2 * HOUR);
  const retryMails = mails - sent;
  is("the retry is not answered \"same\": it finishes the move, counted once", retried.ok ? [retried.start, retried.end, retried.moves] : retried, [H + 2 * HOUR, H + 3 * HOUR, 1]);
  is("the move is still counted once in readMoves", (await readMoves([half])).get(half), { s: H + 2 * HOUR, e: H + 3 * HOUR, n: 1 });
  is("the diary holds this booking once, at the new time, and the old time is let go", await diaryOfSession(w, half), [{ s: H + 2 * HOUR, until: 0 }]);
  is("the booking is marked confirmed, so no \"Booked\" email for the old time follows", (await run([["EXISTS", `nl:call:confirmed:${half}`]]))[0], 1);
  is(
    "the reminders are for the new time only",
    (await queued(half)).filter((m) => !m.includes("|c|")),
    [`|1|${H + 2 * HOUR}`, `|24|${H + 2 * HOUR}`].map((tail) => `${w.store.callsId}|movewrite|${half}${tail}`),
  );
  is("the move emails go out once, as many as a healthy move sends", retryMails, firstMoveMails);
  await run([["DEL", lockOf(w)]]);
  sent = mails;
  is("a further retry, the move now whole, is \"same\" and sends nothing", [await move(half, H, H + 2 * HOUR), mails - sent], [{ ok: false, reason: "same" }, 0]);

  part("A half-written move whose new time was taken since is refused by its retry, never booked twice");
  const T = days[1] + 4 * HOUR;
  const halfTaken = await sellSession(w, T);
  await run([["DEL", lockOf(w)]]);
  swap.landed = { value: undefined };
  swap.get = { value: ["x"] };
  await move(halfTaken, T, T + 2 * HOUR);
  unswap();
  await run([["DEL", lockOf(w)]]);
  const other = await sellSession(w, T + 2 * HOUR);
  await run([["DEL", lockOf(w)]]);
  sent = mails;
  is("the retry is refused as taken", await move(halfTaken, T, T + 2 * HOUR), { ok: false, reason: "taken" });
  is(
    "…with no email, this booking still at its old time only and the other buyer's alone at the new one",
    [mails - sent, (await diaryOfSession(w, halfTaken)).map((e) => e.s), (await diaryOfSession(w, other)).map((e) => e.s)],
    [0, [T], [T + 2 * HOUR]],
  );

  part("A team booking's half-written move: the retry keeps the hosts' claim at the new time only");
  const team = await callStoreAs("movewriteteam@example.com", "movewriteteam", "acct_1MoveWriteTeam", "pro");
  await writeTeam(team.store, team.call.id, { mode: "round_robin", hosts: [{ email: "movewriteteam@example.com", tz: NY, weekly: WEEKDAYS, bufferMinutes: 0, noticeHours: 1, dailyCap: 4 }], createdAt: "2026-10-05T00:00:00.000Z" });
  const teamCall = (await readListing(team.store, team.call.id)) as CallListing;
  const M = days[2] + 4 * HOUR;
  const teamSession = await sellSession({ ...team, call: teamCall }, M);
  const hostClaims = async () => ((await readClaims([hostId("movewriteteam@example.com")])).get(hostId("movewriteteam@example.com")) ?? []).map((c) => c.start).sort();
  is("the hold claims its host at the time bought", await hostClaims(), [M]);
  const teamMove = () =>
    moveBooking({ store: team.store, product: teamCall, session: teamSession, booked: { start: M, end: M + HOUR, email: "buyer@example.com", buyerTz: NY }, start: M + 2 * HOUR, origin: "https://marktmorgen.com" });
  swap.landed = { value: undefined };
  swap.get = { value: ["x"] };
  is("half-written: the first try is refused", await teamMove(), { ok: false, reason: "error" });
  unswap();
  await run([["DEL", lockOf(team)]]);
  sent = mails;
  const teamRetried = await teamMove();
  is("the retry finishes the move, counted once", teamRetried.ok ? [teamRetried.start, teamRetried.moves] : teamRetried, [M + 2 * HOUR, 1]);
  is("the host is claimed at the new time only", await hostClaims(), [M + 2 * HOUR]);
  is("the diary holds the booking once, at the new time, with its host", (await diaryOfSession(team, teamSession)).map((e) => [e.s, e.until]), [[M + 2 * HOUR, 0]]);
  is("the move emails go out", mails > sent, true);

  part("Reminders: ZADD read exactly");
  const S = "cs_test_movewritereminders0001";
  const start = Date.now() + 3 * DAY;
  is("control: planned on a healthy reply", await thrown(() => planReminders(w.store.callsId as string, w.store.handle, S, start)), "no error");
  is("control: two reminders are queued", (await queued(S)).length, 2);
  is("control: planned again (ZADD 0), still fine", await thrown(() => planReminders(w.store.callsId as string, w.store.handle, S, start)), "no error");
  for (const [what, value] of [["nothing (undefined)", undefined], ["null", null], ["text", "1"], ["a number past one", 2], ["a negative number", -1], ["a list", [1]]] as [string, unknown][]) {
    swap.zadd = { value };
    is(`ZADD as ${what}: planReminders throws, never "planned"`, await thrown(() => planReminders(w.store.callsId as string, w.store.handle, `${S}${what.length}`, start)), "UnknownReplyError");
    is(`ZADD as ${what}: planCheck throws, never "planned"`, await thrown(() => planCheck(w.store.callsId as string, w.store.handle, `${S}c${what.length}`, start, Date.now() + HOUR)), "UnknownReplyError");
    unswap();
  }
  is("control: planCheck on a healthy reply", await thrown(() => planCheck(w.store.callsId as string, w.store.handle, `${S}check`, start, Date.now() + HOUR)), "no error");

  part("The calendar mark: SET, INCRBY and EXPIRE read exactly");
  is("control: markBookingsChanged on healthy replies", await thrown(() => markBookingsChanged(w.store.callsId as string)), "no error");
  const marks: [string, string, unknown][] = [
    ["SET", "nothing (undefined)", undefined],
    ["SET", "a number", 1],
    ["INCRBY", "null", null],
    ["INCRBY", "zero", 0],
    ["INCRBY", "text", "3"],
    ["EXPIRE", "nothing (undefined)", undefined],
    ["EXPIRE", "a number past one", 2],
  ];
  for (const [command, what, value] of marks) {
    swap.changed = { command, value };
    is(`${command} as ${what}: markBookingsChanged throws`, await thrown(() => markBookingsChanged(w.store.callsId as string)), "UnknownReplyError");
    is(`${command} as ${what}: planReminders throws`, await thrown(() => planReminders(w.store.callsId as string, w.store.handle, S, start)), "UnknownReplyError");
    unswap();
  }

  part("A move whose reminders cannot be planned still stands (the move was written)");
  const C = days[shapes.length];
  const late = await sellSession(w, C);
  await run([["DEL", lockOf(w)]]);
  swap.zadd = { value: undefined };
  const stands = await move(late, C, C + 2 * HOUR);
  unswap();
  is("the move is reported as done", stands.ok ? stands.start : stands, C + 2 * HOUR);
  is("readMoves gives the new time", (await readMoves([late])).get(late)?.s, C + 2 * HOUR);

  done();
}

void main();
