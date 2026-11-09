/**
 * The rest of lib/webhooks.ts reads Redis only in each reply's exact shape (CX-123 rules 24 and 30).
 *
 * - The Stripe watch's stores (SMEMBERS, a list of text) and its place (GET, text or null): another shape is unknown,
 *   the run throws before anything is read from Stripe and the place does not move.
 * - A store's anchor and wait (GET, text or null each): another shape is unknown; the store is not read this run and
 *   neither moves.
 * - The marks of events already passed over, read when a store is read again from far back (GET, text or null): one
 *   in another shape is never taken as passed over; the anchor does not move past the event.
 * - A passed-over event's own mark and its parts' marks (GET, text or null): another shape is unknown, never "already
 *   told" nor "already sent"; nothing is marked, the event stays where it is, and a later visit tells the creator.
 * - Every delivery line written (SET NX: "OK" written, null already there; SET: "OK"): another reply, or a call that
 *   fails, is read back once (GET, text or null). A line that is there goes in the log, once, and the event goes on
 *   as written (a caller that emits only once still has its delivery in the creator's log); a line that is not there
 *   is never counted as stored: the event's mark is let go or never set, and a message not kept gives its day's count
 *   back, so the line is written, and counted once, when it comes again. A read back in another shape stays unknown.
 * - The store's log, read before a line is put in it (LRANGE, a list of text): another shape is unknown, never an
 *   empty log, so no line is put in it twice.
 *
 * The exact replies are the controls, and behave as before.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts) and synthetic Stripe answers; no request leaves.
 */
import { createHash } from "node:crypto";
import { MESSAGE_TEXT_MAX } from "@/lib/webhook-limits";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { GIVEN_UP_LINES_PER_DAY, QUEUE_KEY, SKIPPED_LINES_PER_DAY, STRIPE_WAIT_RUNS, TOO_LARGE_WORDS, addEndpoint, emitEvent, eventIdFor, recentMessages, setSendHooksForTests, watchStripe, webhooksView } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_webhooks_rest_exact_only";
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
const ACCOUNT = "acct_RestExact0001";
const HANDLE = "rest-exact-shop";
const OWNER = "owner-rest-exact@example.com";

/** The account's events, oldest first; the list honors ending_before as Stripe does. */
let timeline: Record<string, unknown>[] = [];
/** How many times the events were listed. */
let listed = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com") return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  if (init?.method !== "GET" || new Headers(init?.headers).get("Stripe-Account") !== ACCOUNT || url.pathname !== "/v1/events") throw new Error(`unexpected synthetic operation ${url}`);
  listed += 1;
  const before = url.searchParams.get("ending_before");
  const at = before ? timeline.findIndex((e) => e.id === before) : -1;
  return Response.json({ data: (at >= 0 ? timeline.slice(at + 1) : timeline).slice().reverse(), has_more: false });
}) as typeof fetch;
// The endpoint's name resolves to a private address: no try opens a socket.
setSendHooksForTests({ fetch: { resolve: async () => [{ address: "127.0.0.1", family: 4 }] } });
const said: string[] = [];
console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** While set, a command it answers for is not run: this is its reply. Every other command runs. */
let swap: ((command: Command) => { reply: unknown } | undefined) | null = null;
/** A reply standing for a pipeline that fails after its commands ran (the connection closed). */
const FAILS = Symbol("the call fails");
/** While set, a command it answers for is run, and then this is its reply (FAILS: the pipeline fails after it ran). */
let landed: ((command: Command) => { reply: unknown } | undefined) | null = null;
/** While set, a pipeline writing this key fails, as a store that is down (a failure of our own handling of an event). */
let breakKey = "";
redis.pipeline = (async (commands: Command[]) => {
  // The queue's lease is not taken here, so no delivery is tried (no network either way).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) return [0];
  if (breakKey && commands.some((c) => c[0] === "SET" && c[1] === breakKey)) throw new Error("synthetic store failure");
  if (!swap && !landed) return real(commands);
  const replies: unknown[] = [];
  let fails = false;
  for (const command of commands) {
    const swapped = swap?.(command);
    if (swapped) {
      replies.push(swapped.reply);
      continue;
    }
    const reply = (await real([command]))[0];
    const after = landed?.(command);
    if (after?.reply === FAILS) fails = true;
    replies.push(after ? after.reply : reply);
  }
  if (fails) throw new Error("the connection closed after the write");
  return replies;
}) as typeof redis.pipeline;

/** How a promise ended: "unknown" for UnknownReplyError, "done" when it ended, or the other error's message. */
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "done";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw: ${(error as Error).message}`;
  }
}

const get = async (key: string) => (await real([["GET", key]]))[0];
const isDelivery = (c: Command) => String(c[1]).startsWith("nl:hooks:d:");
const nx = (c: Command) => c.includes("NX");
const evt = (id: string, session: string) => ({
  id, type: "checkout.session.completed", created: 1_790_000_000, data: { object: {
    id: session, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4900, currency: "usd",
    metadata: { store: HANDLE, product: "p_course" }, customer_details: { email: null, name: null },
  } },
});

let statsId = "";
let endpointId = "";
async function setup() {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Rest Exact Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT);
  await setSubscription(OWNER, { customerId: "cus_RestExact0001", subscriptionId: "sub_RestExact0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  statsId = store.statsId as string;
  if (!(await addEndpoint(store, "https://hooks.example.net/rest", ["sale.completed"])).ok) throw new Error("setup: endpoint not added");
  endpointId = (await webhooksView(store)).endpoints[0].id;
  timeline = [];
  listed = 0;
  breakKey = "";
  said.length = 0;
  return store;
}
const anchorKey = () => `nl:hooks:anchor:${statsId}`;
const waitKey = () => `nl:hooks:wait:${statsId}`;
const givenUpMarkKey = (evtId: string) => `nl:hooks:evt:${eventIdFor(statsId, "stripe.given_up", evtId)}`;
const saleMarkKey = (session: string) => `nl:hooks:evt:${eventIdFor(statsId, "sale.completed", session)}`;
const sessionsSent = async (store: Awaited<ReturnType<typeof setup>>) => (await recentMessages(store, "sale.completed", 10)).map((m) => (m.data as { checkout_session: string }).checkout_session);
const givenUpLines = async (store: Awaited<ReturnType<typeof setup>>, about: string) => (await webhooksView(store)).log.filter((d) => d.givenUp && d.lastError.includes(about)).length;
const logIds = async () => (await real([["LRANGE", `nl:hooks:log:${statsId}`, 0, -1]]))[0] as string[];

const OFF_SHAPES: [string, unknown][] = [["42", 42], ["true", true], ['["x"]', ["x"]], ["an object", { x: 1 }], ["undefined", undefined]];
const OFF_WRITES: [string, unknown][] = [['"QUEUED"', "QUEUED"], ["1", 1], ["true", true], ['["OK"]', ["OK"]], ["undefined", undefined]];
/** The same, and a call that fails after the write ran. */
const LANDED: [string, unknown][] = [...OFF_WRITES, ["a call that fails", FAILS]];
const skipCount = async () => Number(await get(`nl:hooks:wait:${statsId}:skip:large:${Math.floor(Date.now() / 86_400_000)}`));

async function main(): Promise<void> {
  part("The Stripe watch's stores and place: another shape is unknown; nothing is read and the place does not move");
  // A list of text is a list of stores, and text a place: those are the exact shapes, not off ones.
  const offList: [string, unknown][] = [...OFF_SHAPES.filter(([n]) => n !== '["x"]'), ["[1]", [1]], ['"x"', "x"]];
  for (const [at, [name, value]] of [...offList.map((s) => ["stores", s] as const), ...OFF_SHAPES.filter(([n]) => n !== '["x"]').map((s) => ["place", s] as const)]) {
    await setup();
    timeline = [evt("evt_Watch01", "cs_Watch01")];
    await real([["SET", anchorKey(), "evt_Watch01", "EX", 3600], ["SET", "nl:hooks:pos", "a-place"]]);
    swap = (c) => (at === "stores" && c[0] === "SMEMBERS" && c[1] === "nl:hooks:stores") || (at === "place" && c[0] === "GET" && c[1] === "nl:hooks:pos") ? { reply: value } : undefined;
    const run = await outcome(watchStripe(Date.now() + 10_000));
    swap = null;
    is(`${at} as ${name}: unknown, no store read, the place where it was`, [run, listed, await get("nl:hooks:pos")], ["unknown", 0, "a-place"]);
  }
  await setup();
  timeline = [evt("evt_Watch01", "cs_Watch01")];
  await real([["SET", anchorKey(), "evt_Watch01", "EX", 3600]]);
  is("control: the exact replies read the store once and keep its place", [await outcome(watchStripe(Date.now() + 10_000)), listed, await get("nl:hooks:pos")], ["done", 1, statsId]);

  part("A store's anchor and wait: another shape is unknown; the store is not read this run, and neither moves");
  for (const key of ["anchor", "wait"] as const) {
    for (const [name, value] of OFF_SHAPES) {
      await setup();
      timeline = [evt("evt_Anchor01", "cs_Anchor01"), evt("evt_Anchor02", "cs_Anchor02")];
      await real([["SET", anchorKey(), "evt_Anchor01", "EX", 3600], ["SET", waitKey(), `evt_Anchor02|2|${Math.floor(Date.now() / 1000)}`, "EX", 3600]]);
      const wait = await get(waitKey());
      swap = (c) => (c[0] === "GET" && c[1] === (key === "anchor" ? anchorKey() : waitKey()) ? { reply: value } : undefined);
      await watchStripe(Date.now() + 10_000);
      swap = null;
      is(`${key} as ${name}: Stripe not asked, the anchor and the wait as they were`, [listed, await get(anchorKey()), (await get(waitKey())) === wait], [0, "evt_Anchor01", true]);
      is(`${key} as ${name}: said in the server's log`, said.some((l) => l.startsWith("reading a store's Stripe events failed")), true);
    }
  }
  let store = await setup();
  timeline = [evt("evt_Anchor01", "cs_Anchor01"), evt("evt_Anchor02", "cs_Anchor02")];
  await real([["SET", anchorKey(), "evt_Anchor01", "EX", 3600]]);
  await watchStripe(Date.now() + 10_000);
  is("control: the exact anchor reads on from it and sends the next sale", [listed, await get(anchorKey()), await sessionsSent(store)], [1, "evt_Anchor02", ["cs_Anchor02"]]);

  part("Read again from far back: a passed-over mark in another shape is never taken as passed over");
  for (const [name, value] of OFF_SHAPES) {
    store = await setup();
    timeline = [evt("evt_Reread01", "cs_Reread01")];
    swap = (c) => (c[0] === "GET" && c[1] === givenUpMarkKey("evt_Reread01") ? { reply: value } : undefined);
    await watchStripe(Date.now() + 10_000);
    swap = null;
    is(`${name}: the anchor does not move past the sale, nothing sent`, [await get(anchorKey()), await sessionsSent(store)], [null, []]);
    await watchStripe(Date.now() + 10_000);
    is(`${name}: the next exact run sends it`, [await get(anchorKey()), await sessionsSent(store)], ["evt_Reread01", ["cs_Reread01"]]);
  }
  store = await setup();
  timeline = [evt("evt_Reread01", "cs_Reread01")];
  await real([["SET", givenUpMarkKey("evt_Reread01"), "1", "EX", 3600]]);
  await watchStripe(Date.now() + 10_000);
  is("control: an exact mark (text) passes it over, as before", [await get(anchorKey()), await sessionsSent(store)], ["evt_Reread01", []]);

  /** A sale our handling keeps failing on, at the last visit before it is passed over, after an anchored one. */
  const stuck = async (n: number) => {
    const s = await setup();
    const id = `evt_Stuck${n}`;
    timeline = [evt("evt_Base01", "cs_Base01"), evt(id, `cs_Stuck${n}`)];
    await real([["SET", anchorKey(), "evt_Base01", "EX", 3600], ["SET", waitKey(), `${id}|${STRIPE_WAIT_RUNS - 1}|${Math.floor(Date.now() / 1000)}`, "EX", 3600]]);
    breakKey = saleMarkKey(`cs_Stuck${n}`);
    return { store: s, id, about: `cs_Stuck${n}` };
  };
  const OFF_MARKS: [string, string, (c: Command, id: string, about: string) => boolean][] = [
    ["its own mark", "own", (c, id) => c[0] === "GET" && c[1] === givenUpMarkKey(id)],
    ["its part's mark", "part", (c, _id, about) => c[0] === "GET" && c[1] === saleMarkKey(about)],
  ];

  part("A passed-over event's marks: another shape is unknown, never told or sent; the event stays and is told later");
  let n = 0;
  for (const [what, , matches] of OFF_MARKS) {
    for (const [name, value] of OFF_SHAPES) {
      const s = await stuck((n += 1));
      swap = (c) => (matches(c, s.id, s.about) ? { reply: value } : undefined);
      await watchStripe(Date.now() + 10_000);
      swap = null;
      is(`${what} as ${name}: nothing marked, no line, the anchor and the wait where they were`,
        [await get(givenUpMarkKey(s.id)), await givenUpLines(s.store, s.about), await get(anchorKey()), String(await get(waitKey())).startsWith(`${s.id}|`)], [null, 0, "evt_Base01", true]);
      await watchStripe(Date.now() + 10_000);
      is(`${what} as ${name}: the next exact visit passes it over with its line`, [await givenUpLines(s.store, s.about), await get(anchorKey())], [1, s.id]);
    }
  }
  const control = await stuck((n += 1));
  await watchStripe(Date.now() + 10_000);
  is("control: exact marks (null) tell it at once, marked", [await givenUpLines(control.store, control.about), typeof (await get(givenUpMarkKey(control.id))), await get(anchorKey())], [1, "string", control.id]);

  part("A passed-over event's line: a write answered in another shape is never counted as stored");
  for (const [name, value] of OFF_WRITES) {
    const s = await stuck((n += 1));
    // The write is not made, and its answer is this.
    swap = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) ? { reply: value } : undefined);
    await watchStripe(Date.now() + 10_000);
    swap = null;
    is(`${name}: nothing marked, the anchor where it was`, [await get(givenUpMarkKey(s.id)), await get(anchorKey())], [null, "evt_Base01"]);
    await watchStripe(Date.now() + 10_000);
    is(`${name}: the next exact visit writes the line`, [await givenUpLines(s.store, s.about), await get(anchorKey())], [1, s.id]);
  }

  part("A passed-over event's line that landed with a reply in another shape is read back: in the log once, the event marked");
  for (const [name, value] of LANDED) {
    const s = await stuck((n += 1));
    landed = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) ? { reply: value } : undefined);
    await watchStripe(Date.now() + 10_000);
    landed = null;
    is(`${name}: its line in the log once, the event marked, the anchor moved on`,
      [await givenUpLines(s.store, s.about), typeof (await get(givenUpMarkKey(s.id))), await get(anchorKey())], [1, "string", s.id]);
  }

  part("The day's summary line: its read and its write in another shape are unknown");
  const day = Math.floor(Date.now() / 86_400_000);
  const summed = async () => {
    const s = await stuck((n += 1));
    const key = `nl:hooks:wait:${statsId}:day:${day}:${endpointId}`;
    await real(Array.from({ length: GIVEN_UP_LINES_PER_DAY }, (_, i) => ["ZADD", key, i + 1, `nl-earlier-${i}`]));
    const summaryId = `dlv_${createHash("sha256").update(`${statsId}|${day}|${endpointId}|given-up-day`).digest("hex").slice(0, 24)}`;
    return { ...s, summary: `nl:hooks:d:${summaryId}` };
  };
  for (const [name, value] of OFF_SHAPES) {
    const s = await summed();
    swap = (c) => (c[0] === "GET" && c[1] === s.summary ? { reply: value } : undefined);
    await watchStripe(Date.now() + 10_000);
    swap = null;
    is(`read as ${name}: nothing written or marked, the anchor where it was`, [await get(s.summary), await get(givenUpMarkKey(s.id)), await get(anchorKey())], [null, null, "evt_Base01"]);
  }
  for (const [name, value] of OFF_WRITES) {
    const s = await summed();
    swap = (c) => (c[0] === "SET" && c[1] === s.summary ? { reply: value } : undefined);
    await watchStripe(Date.now() + 10_000);
    swap = null;
    is(`written as ${name}: nothing marked, the anchor where it was`, [await get(givenUpMarkKey(s.id)), await get(anchorKey())], [null, "evt_Base01"]);
    await watchStripe(Date.now() + 10_000);
    is(`written as ${name}: the next exact visit writes it`, [typeof (await get(s.summary)), await get(anchorKey())], ["string", s.id]);
  }
  for (const [name, value] of LANDED) {
    const s = await summed();
    landed = (c) => (c[0] === "SET" && c[1] === s.summary ? { reply: value } : undefined);
    await watchStripe(Date.now() + 10_000);
    landed = null;
    is(`written as ${name}, and it landed: read back, in the log, the event marked`,
      [typeof (await get(s.summary)), (await logIds()).includes(s.summary.slice("nl:hooks:d:".length)), typeof (await get(givenUpMarkKey(s.id))), await get(anchorKey())], ["string", true, "string", s.id]);
  }
  const summary = await summed();
  await watchStripe(Date.now() + 10_000);
  is("control: exact replies write the summary line and mark the event", [typeof (await get(summary.summary)), typeof (await get(givenUpMarkKey(summary.id))), await get(anchorKey())], ["string", "string", summary.id]);

  part("An event's deliveries: a write answered in another shape is never counted as stored");
  for (const [name, value] of OFF_WRITES) {
    store = await setup();
    swap = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) ? { reply: value } : undefined);
    const first = await outcome(emitEvent(store, "sale.completed", "cs_Emit01", { amount_cents: 4900 }));
    swap = null;
    is(`${name}: unknown, and the event's mark let go`, [first, await get(saleMarkKey("cs_Emit01"))], ["unknown", null]);
    const again = await emitEvent(store, "sale.completed", "cs_Emit01", { amount_cents: 4900 });
    const ids = await logIds();
    is(`${name}: noticed again, it is written and kept`, [again, ids.length, typeof (await get(`nl:hooks:d:${ids[0]}`))], [1, 1, "string"]);
  }
  store = await setup();
  is("control: exact replies write it once", [await emitEvent(store, "sale.completed", "cs_Emit01", { amount_cents: 4900 }), (await logIds()).length], [1, 1]);

  part("An event's deliveries that landed with a reply in another shape are read back: queued, in the log once, emitted once");
  for (const [name, value] of LANDED) {
    store = await setup();
    landed = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) ? { reply: value } : undefined);
    const first = await outcome(emitEvent(store, "sale.completed", "cs_Landed01", { amount_cents: 4900 }));
    landed = null;
    const ids = await logIds();
    const member = `${statsId}|${ids[0] ?? ""}`;
    is(`${name}: done, the line kept, queued and in the log once, the event's mark kept`,
      [first, ids.length, typeof (await get(`nl:hooks:d:${ids[0] ?? ""}`)), (await real([["ZSCORE", QUEUE_KEY, member]]))[0] !== null, typeof (await get(saleMarkKey("cs_Landed01")))],
      ["done", 1, "string", true, "string"]);
    is(`${name}: emitted again, nothing more`, [await emitEvent(store, "sale.completed", "cs_Landed01", { amount_cents: 4900 }), (await logIds()).length], [0, 1]);
  }
  for (const [name, value] of [["42", 42], ['["x"]', ["x"]]] as [string, unknown][]) {
    store = await setup();
    landed = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) ? { reply: "QUEUED" } : undefined);
    swap = (c) => (c[0] === "GET" && isDelivery(c) ? { reply: value } : undefined);
    const first = await outcome(emitEvent(store, "sale.completed", "cs_Unsure01", { amount_cents: 4900 }));
    landed = null;
    swap = null;
    is(`read back as ${name} too: unknown, and the event's mark let go`, [first, await get(saleMarkKey("cs_Unsure01"))], ["unknown", null]);
    await emitEvent(store, "sale.completed", "cs_Unsure01", { amount_cents: 4900 });
    is(`read back as ${name} too: noticed again, its line in the log once`, (await logIds()).length, 1);
  }

  part("A message not kept: its line written in another shape is never counted as stored");
  const tooLarge = { notes: Array.from({ length: 300 }, () => "x".repeat(MESSAGE_TEXT_MAX)) };
  const lineWords = async () => {
    const ids = await logIds();
    // A line in the log whose record is missing is not a line the studio can show.
    const raws = await Promise.all(ids.map((id) => get(`nl:hooks:d:${id}`)));
    return raws.filter((raw): raw is string => typeof raw === "string").map((raw) => (JSON.parse(raw) as { lastError: string }).lastError);
  };
  for (const overflow of [false, true]) {
    for (const [name, value] of OFF_WRITES) {
      store = await setup();
      if (overflow) await real([["SET", `nl:hooks:wait:${statsId}:skip:large:${day}`, SKIPPED_LINES_PER_DAY]]);
      swap = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) !== overflow ? { reply: value } : undefined);
      const first = await outcome(emitEvent(store, "sale.completed", "cs_Large01", tooLarge));
      swap = null;
      const label = overflow ? "the day's count line" : "its own line";
      is(`${label} as ${name}: unknown, and the event's mark let go`, [first, await get(saleMarkKey("cs_Large01"))], ["unknown", null]);
      await emitEvent(store, "sale.completed", "cs_Large01", tooLarge);
      const words = await lineWords();
      is(`${label} as ${name}: noticed again, its line is written`, [words.length, overflow ? words[0]?.includes("too large") : words[0] === TOO_LARGE_WORDS], [1, true]);
      is(`${label} as ${name}: the message counted once for the day`, await skipCount(), overflow ? SKIPPED_LINES_PER_DAY + 1 : 1);
    }
  }

  part("A message not kept: its line that landed with a reply in another shape is read back, in the log once, counted once");
  for (const overflow of [false, true]) {
    for (const [name, value] of LANDED) {
      store = await setup();
      await real([["SET", `nl:hooks:wait:${statsId}:skip:large:${day}`, overflow ? SKIPPED_LINES_PER_DAY : SKIPPED_LINES_PER_DAY - 1]]);
      landed = (c) => (c[0] === "SET" && isDelivery(c) && nx(c) !== overflow ? { reply: value } : undefined);
      const first = await outcome(emitEvent(store, "sale.completed", "cs_LandedLarge01", tooLarge));
      landed = null;
      const label = overflow ? "the day's count line" : "its own line";
      const words = await lineWords();
      is(`${label} as ${name}: done, the event's mark kept, its line in the log once`,
        [first, typeof (await get(saleMarkKey("cs_LandedLarge01"))), words.length, overflow ? words[0]?.includes("too large") : words[0] === TOO_LARGE_WORDS], ["done", "string", 1, true]);
      is(`${label} as ${name}: emitted again, nothing more`, [await emitEvent(store, "sale.completed", "cs_LandedLarge01", tooLarge), (await lineWords()).length], [0, 1]);
      is(`${label} as ${name}: counted once`, await skipCount(), overflow ? SKIPPED_LINES_PER_DAY + 1 : SKIPPED_LINES_PER_DAY);
    }
  }

  part("The store's log: another shape is unknown, never an empty log; no line is put in it twice");
  for (const [name, value] of [['"x"', "x"], ["[1]", [1]], ["an object", { x: 1 }], ["undefined", undefined], ["null", null]] as [string, unknown][]) {
    store = await setup();
    await emitEvent(store, "sale.completed", "cs_Log01", { amount_cents: 4900 });
    const [id] = await logIds();
    await real([["DEL", saleMarkKey("cs_Log01")]]);
    swap = (c) => (c[0] === "LRANGE" && c[1] === `nl:hooks:log:${statsId}` ? { reply: value } : undefined);
    const again = await outcome(emitEvent(store, "sale.completed", "cs_Log01", { amount_cents: 4900 }));
    swap = null;
    is(`${name}: unknown, the line in the log once`, [again, (await logIds()).filter((x) => x === id).length], ["unknown", 1]);
  }
  store = await setup();
  await emitEvent(store, "sale.completed", "cs_Log01", { amount_cents: 4900 });
  await real([["DEL", saleMarkKey("cs_Log01")]]);
  is("control: an exact log already holding the line is not given it again", [await outcome(emitEvent(store, "sale.completed", "cs_Log01", { amount_cents: 4900 })), (await logIds()).length], ["done", 1]);

  done();
}
void main();
