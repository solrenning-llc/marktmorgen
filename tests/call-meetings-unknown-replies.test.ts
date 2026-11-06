/**
 * The meetings job (lib/call-meetings.ts) and the Google calls it rests on
 * (lib/meet-providers.ts) read a Redis or provider reply only in its exact
 * shape (CX-123 rule 24, added 6 November 2026). A reply that is not what
 * was asked for is unknown: it never drops a meeting from the queue, moves
 * the refunds' place past refunds never read, marks a refund read that was
 * never looked up, wipes the guests a creator added or makes a busy host
 * look free. Synthetic data only; Stripe and Google are stand-ins.
 *
 *   - a store that could not be read keeps its meeting in the queue; a store
 *     confirmed gone still lets it go;
 *   - a record that could not be read keeps its place and the run goes on
 *     (lib/meet-records.ts may throw for one, PR #2619);
 *   - the refunds' place, a refund's "read" mark, Stripe's refund list and
 *     its checkout-session lookup: an unknown answer keeps the place and
 *     marks nothing, so the refund is read again next run;
 *   - Google's event (guest list), free/busy and calendar list: an answer
 *     not in its shape is refused, never read as "nobody", "free" or "none".
 */
import { syncMeetings } from "@/lib/call-meetings";
import { MEET_STORES } from "@/lib/meet-links";
import { MEET_QUEUE, recordKey } from "@/lib/meet-records";
import { googleCalendars, googleFreeBusy, googleGuests } from "@/lib/meet-providers";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_call_meetings_unknown_only";
process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";
const ACCOUNT = "acct_1TestMeetUnk001";
const NOW = Math.floor(Date.now() / 1000);
const ORIGIN = "https://marktmorgen.com";

let refundsAnswer: (gte: number) => unknown = () => ({ object: "list", data: [], has_more: false });
let sessionsAnswer: (intent: string) => unknown = () => ({ object: "list", data: [], has_more: false });
let closings: Record<string, unknown>[] = [];
const lookedUp: string[] = [];
let googleAnswer: (method: string, path: string, body: string) => Response = () => new Response("{}", { status: 404 });
const sent: { method: string; path: string; body: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "127.0.0.1") {
    const method = String(init?.method ?? "GET");
    const body = typeof init?.body === "string" ? init.body : "";
    sent.push({ method, path: url.pathname, body });
    return googleAnswer(method, url.pathname, body);
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") return json(refundsAnswer(Number(url.searchParams.get("created[gte]") ?? 0)));
  if (path === "/checkout/sessions") {
    const intent = String(url.searchParams.get("payment_intent") ?? "");
    lookedUp.push(intent);
    return json(sessionsAnswer(intent));
  }
  if (path === "/events") return json({ object: "list", data: url.searchParams.get("type") === "charge.dispute.closed" ? closings : [], has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const full = (id: string, created: number, intent: string) => ({
  id,
  object: "refund",
  status: "succeeded",
  created,
  payment_intent: intent,
  charge: { object: "charge", refunded: true, amount: 4900, amount_refunded: 4900 },
});

const shop = (callsId: string, handle: string) =>
  ({ statsId: "u".repeat(32), callsId, stripeAccountId: ACCOUNT, handle, previousHandles: [] }) as unknown as Store;

const anchorKey = (callsId: string) => `nl:meet:rf:${callsId}:since`;
const seenKey = (callsId: string) => `nl:meet:rf:${callsId}:seen`;
const get = async (key: string) => (await redis.pipeline([["GET", key]]))[0];

/** Runs `fn` with the one Redis command matched by `match` answered `shape(reply)` instead. */
async function withReply<T>(match: (command: (string | number)[]) => boolean, shape: (reply: unknown) => unknown, fn: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original.call(redis, commands);
    if (commands.length === 1 && match(commands[0])) return [shape(replies[0])] as never;
    return replies;
  }) as typeof redis.pipeline;
  try {
    return await fn();
  } finally {
    redis.pipeline = original;
  }
}

/** The odd shapes a reply can take that are none of "the value", "nothing there". */
const SHAPES: [string, (reply: unknown) => unknown][] = [
  ["a reply missing", () => undefined],
  ["a list", () => ["1"]],
  ["an object", () => ({ value: "1" })],
  ["a boolean", () => true],
];

function record(scope: string, handle: string, callsId: string): string {
  return JSON.stringify({
    provider: "google", scope, statsId: "u".repeat(32), handle, callsId, product: "p1", session: "cs_test_unknown01",
    group: false, id: "", account: "", link: "", made: false, start: Date.now() + 86_400_000, end: Date.now() + 90_000_000,
    tz: "America/New_York", title: "Call", guests: [], added: [], todo: "create", tries: 0, next: Date.now() - 1_000,
    error: "", updates: 0, gone: false, host: "", calendar: "",
  });
}

async function main(): Promise<void> {
  part("A store that could not be read keeps its meeting in the queue");
  {
    redis.clear();
    const callsId = "a".repeat(16);
    const scope = `c:${callsId}:b:cs_test_unknown01`;
    await redis.pipeline([["SET", recordKey(scope), record(scope, "unknown-shop", callsId)], ["ZADD", MEET_QUEUE, Date.now() - 1_000, scope]]);
    await syncMeetings(async () => {
      throw new Error("Redis did not answer");
    }, Date.now() + 60_000, ORIGIN);
    is("the store read failed: the meeting is still queued", (await redis.pipeline([["ZSCORE", MEET_QUEUE, scope]]))[0] !== null, true);
    is("and its record is untouched", typeof (await get(recordKey(scope))), "string");
    await syncMeetings(async () => null, Date.now() + 60_000, ORIGIN);
    is("control: a store confirmed gone lets its meeting go", (await redis.pipeline([["ZSCORE", MEET_QUEUE, scope]]))[0], null);
  }

  part("A record that could not be read keeps its place, and the run goes on");
  {
    redis.clear();
    const callsId = "b".repeat(16);
    const scope = `c:${callsId}:b:cs_test_unknown01`;
    await redis.pipeline([["SET", recordKey(scope), record(scope, "record-shop", callsId)], ["ZADD", MEET_QUEUE, Date.now() - 1_000, scope]]);
    await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|record-shop`]]);
    refundsAnswer = () => ({ object: "list", data: [full("re_RecordRun01", NOW - 60, "pi_RecordRun01")], has_more: false });
    sessionsAnswer = () => ({ object: "list", data: [], has_more: false });
    lookedUp.length = 0;
    const original = redis.pipeline;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === recordKey(scope)) throw new Error("The meeting records could not be confirmed.");
      return original.call(redis, commands);
    }) as typeof redis.pipeline;
    let thrown = "";
    try {
      await syncMeetings(async (handle) => (handle === "record-shop" ? shop(callsId, "record-shop") : null), Date.now() + 60_000, ORIGIN);
    } catch (error) {
      thrown = String(error);
    } finally {
      redis.pipeline = original;
    }
    is("the job does not stop at the record", thrown, "");
    is("the record keeps its place in the queue", (await redis.pipeline([["ZSCORE", MEET_QUEUE, scope]]))[0] !== null, true);
    is("and the refunds are still read in the same run", lookedUp.includes("pi_RecordRun01"), true);
  }

  part("An unknown place for the refunds keeps the place, and reads nothing past it");
  for (const [name, shape] of SHAPES) {
    redis.clear();
    const callsId = "c".repeat(16);
    const old = NOW - 3 * 86_400;
    await redis.pipeline([["SET", anchorKey(callsId), String(old)], ["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|anchor-shop`]]);
    const refunds = [full("re_AnchorOld001", NOW - 2 * 86_400, "pi_AnchorOld001")];
    refundsAnswer = (gte) => ({ object: "list", data: refunds.filter((r) => r.created >= gte), has_more: false });
    sessionsAnswer = () => ({ object: "list", data: [], has_more: false });
    lookedUp.length = 0;
    await withReply((c) => c[0] === "GET" && c[1] === anchorKey(callsId), shape, () =>
      syncMeetings(async (handle) => (handle === "anchor-shop" ? shop(callsId, "anchor-shop") : null), Date.now() + 60_000, ORIGIN),
    );
    is(`${name}: the place is kept where it was`, await get(anchorKey(callsId)), String(old));
    is(`${name}: and nothing is marked read`, (await redis.pipeline([["SCARD", seenKey(callsId)]]))[0], 0);
    lookedUp.length = 0;
    await syncMeetings(async (handle) => (handle === "anchor-shop" ? shop(callsId, "anchor-shop") : null), Date.now() + 60_000, ORIGIN);
    is(`${name}: the next run reads the refund from the kept place`, lookedUp, ["pi_AnchorOld001"]);
  }
  {
    redis.clear();
    const callsId = "d".repeat(16);
    await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|first-shop`]]);
    refundsAnswer = () => ({ object: "list", data: [], has_more: false });
    await syncMeetings(async (handle) => (handle === "first-shop" ? shop(callsId, "first-shop") : null), Date.now() + 60_000, ORIGIN);
    const first = Number(await get(anchorKey(callsId)));
    is("control: a place confirmed absent starts a day back", first >= NOW - 86_400 - 5 && first <= NOW - 86_400 + 60, true);
  }

  part("An unknown \"already read\" answer handles nothing twice");
  for (const [name, shape] of SHAPES.filter(([n]) => n !== "a boolean")) {
    redis.clear();
    const callsId = "e".repeat(16);
    const at = NOW - 3_600;
    await redis.pipeline([
      ["SET", anchorKey(callsId), String(at - 600)],
      ["SADD", seenKey(callsId), "re_SeenAlready1"],
      ["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|seen-shop`],
    ]);
    refundsAnswer = () => ({ object: "list", data: [full("re_SeenAlready1", at, "pi_SeenAlready1")], has_more: false });
    lookedUp.length = 0;
    await withReply((c) => c[0] === "SISMEMBER" && c[1] === seenKey(callsId), shape, () =>
      syncMeetings(async (handle) => (handle === "seen-shop" ? shop(callsId, "seen-shop") : null), Date.now() + 60_000, ORIGIN),
    );
    is(`${name}: the refund is not looked up again`, lookedUp, []);
    is(`${name}: and the place is kept`, await get(anchorKey(callsId)), String(at - 600));
  }

  part("Stripe's refund list, read only in its shape");
  const listShapes: [string, (data: unknown[]) => unknown][] = [
    ["no data", () => ({ object: "list", has_more: false })],
    ["data not a list", () => ({ object: "list", data: {}, has_more: false })],
    ["no has_more", (data) => ({ object: "list", data })],
  ];
  for (const [name, answer] of listShapes) {
    redis.clear();
    const callsId = "f".repeat(16);
    const old = NOW - 7_200;
    await redis.pipeline([["SET", anchorKey(callsId), String(old)], ["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|list-shop`]]);
    // Newest first, as Stripe lists them: one page shows the newer refund; the older is on the next.
    const newer = full("re_ListNewer001", NOW - 60, "pi_ListNewer001");
    const older = full("re_ListOlder001", NOW - 3_600, "pi_ListOlder001");
    closings = [
      {
        id: "evt_ListLost0001",
        object: "event",
        type: "charge.dispute.closed",
        created: NOW - 30,
        data: { object: { id: "du_ListLost01", object: "dispute", status: "lost", amount: 4900, charge: "ch_ListLost0001", payment_intent: "pi_ListLost0001" } },
      },
    ];
    refundsAnswer = () => answer([newer]);
    sessionsAnswer = () => ({ object: "list", data: [], has_more: false });
    lookedUp.length = 0;
    await syncMeetings(async (handle) => (handle === "list-shop" ? shop(callsId, "list-shop") : null), Date.now() + 60_000, ORIGIN);
    is(`${name}: the place is kept where it was`, await get(anchorKey(callsId)), String(old));
    closings = [];
    refundsAnswer = (gte) => ({ object: "list", data: [newer, older].filter((r) => r.created >= gte), has_more: false });
    lookedUp.length = 0;
    await syncMeetings(async (handle) => (handle === "list-shop" ? shop(callsId, "list-shop") : null), Date.now() + 60_000, ORIGIN);
    is(`${name}: the next run still reads the older refund`, lookedUp.includes("pi_ListOlder001"), true);
  }

  part("Stripe's checkout-session lookup, read only in its shape");
  const sessionShapes: [string, unknown][] = [
    ["no data", { object: "list", has_more: false }],
    ["data not a list", { object: "list", data: "cs_x", has_more: false }],
  ];
  for (const [name, answer] of sessionShapes) {
    redis.clear();
    const callsId = "g".repeat(16);
    await redis.pipeline([["SET", anchorKey(callsId), String(NOW - 600)], ["ZADD", MEET_STORES, Date.now() + 86_400_000, `${callsId}|look-shop`]]);
    refundsAnswer = () => ({ object: "list", data: [full("re_LookUp00001", NOW - 60, "pi_LookUp00001")], has_more: false });
    sessionsAnswer = () => answer;
    lookedUp.length = 0;
    await syncMeetings(async (handle) => (handle === "look-shop" ? shop(callsId, "look-shop") : null), Date.now() + 60_000, ORIGIN);
    is(`${name}: the refund is not marked read`, (await redis.pipeline([["SISMEMBER", seenKey(callsId), "re_LookUp00001"]]))[0], 0);
    is(`${name}: and the place is kept`, await get(anchorKey(callsId)), String(NOW - 600));
    sessionsAnswer = () => ({ object: "list", data: [], has_more: false });
    lookedUp.length = 0;
    await syncMeetings(async (handle) => (handle === "look-shop" ? shop(callsId, "look-shop") : null), Date.now() + 60_000, ORIGIN);
    is(`${name}: the next run looks it up again`, lookedUp, ["pi_LookUp00001"]);
    is(`${name}: control: confirmed no session, it is marked read`, (await redis.pipeline([["SISMEMBER", seenKey(callsId), "re_LookUp00001"]]))[0], 1);
  }

  part("Google's event, read only in its shape before the guest list is written");
  const EVENT = "nimbusunknownreplies000001";
  const eventPath = `/google/calendar/v3/calendars/primary/events/${EVENT}`;
  const guestsWith = (read: () => Response) => {
    googleAnswer = (method, path) => {
      if (method === "GET" && path === eventPath) return read();
      if (method === "PATCH" && path === eventPath) return new Response(JSON.stringify({ id: EVENT }), { status: 200 });
      return new Response("{}", { status: 404 });
    };
  };
  const eventShapes: [string, () => Response][] = [
    ["a body that is not JSON", () => new Response("<html>busy</html>", { status: 200 })],
    ["an empty body", () => new Response("", { status: 200 })],
    ["a list", () => new Response(JSON.stringify([{ email: "creator-guest@example.com" }]), { status: 200 })],
    ["another event", () => new Response(JSON.stringify({ id: "nimbusother", attendees: [] }), { status: 200 })],
    ["no id", () => new Response(JSON.stringify({ attendees: [{ email: "creator-guest@example.com" }] }), { status: 200 })],
    ["attendees not a list", () => new Response(JSON.stringify({ id: EVENT, attendees: { email: "creator-guest@example.com" } }), { status: 200 })],
    ["an attendee not an object", () => new Response(JSON.stringify({ id: EVENT, attendees: ["creator-guest@example.com"] }), { status: 200 })],
  ];
  for (const [name, read] of eventShapes) {
    guestsWith(read);
    sent.length = 0;
    const outcome = await googleGuests("ya29.test-only", EVENT, ["new@example.com"], ["old@example.com"]).then(
      () => "written",
      (error: unknown) => (error instanceof Error ? error.name : "thrown"),
    );
    is(`${name}: refused`, outcome !== "written", true);
    is(`${name}: and the guest list is not written`, sent.filter((s) => s.method === "PATCH").length, 0);
  }
  guestsWith(() =>
    new Response(JSON.stringify({ id: EVENT, attendees: [{ email: "creator-guest@example.com" }, { email: "old@example.com" }] }), { status: 200 }),
  );
  sent.length = 0;
  await googleGuests("ya29.test-only", EVENT, ["new@example.com"], ["old@example.com"]);
  const patched = JSON.parse(sent.find((s) => s.method === "PATCH")?.body ?? "{}") as { attendees?: { email: string }[] };
  is("control: the creator's own guest is kept, ours put right", (patched.attendees ?? []).map((a) => a.email), ["creator-guest@example.com", "new@example.com"]);
  guestsWith(() => new Response(JSON.stringify({ id: EVENT, status: "confirmed" }), { status: 200 }));
  sent.length = 0;
  await googleGuests("ya29.test-only", EVENT, ["new@example.com"], []);
  const empty = JSON.parse(sent.find((s) => s.method === "PATCH")?.body ?? "{}") as { attendees?: { email: string }[] };
  is("control: an event with no guests (Google leaves the field out) gets ours", (empty.attendees ?? []).map((a) => a.email), ["new@example.com"]);

  part("Google's free/busy, read only in its shape");
  const FROM = Date.parse("2026-12-01T00:00:00Z");
  const TO = FROM + 86_400_000;
  const busyShapes: [string, unknown][] = [
    ["busy left out", { kind: "calendar#freeBusy", calendars: { primary: {} } }],
    ["busy not a list", { kind: "calendar#freeBusy", calendars: { primary: { busy: "all day" } } }],
    ["a busy time with no start", { kind: "calendar#freeBusy", calendars: { primary: { busy: [{ end: "2026-12-01T10:00:00Z" }] } } }],
    ["a busy time not a date", { kind: "calendar#freeBusy", calendars: { primary: { busy: [{ start: "soon", end: "later" }] } } }],
  ];
  for (const [name, answer] of busyShapes) {
    googleAnswer = () => new Response(JSON.stringify(answer), { status: 200 });
    const outcome = await googleFreeBusy("ya29.test-only", [], FROM, TO).then(
      (busy) => `free (${busy.length})`,
      () => "refused",
    );
    is(`${name}: refused, never read as free`, outcome, "refused");
  }
  googleAnswer = () =>
    new Response(JSON.stringify({ kind: "calendar#freeBusy", calendars: { primary: { busy: [{ start: "2026-12-01T09:00:00Z", end: "2026-12-01T10:00:00Z" }] } } }), { status: 200 });
  is("control: a busy hour is read", await googleFreeBusy("ya29.test-only", [], FROM, TO), [[Date.parse("2026-12-01T09:00:00Z"), Date.parse("2026-12-01T10:00:00Z")]]);
  googleAnswer = () => new Response(JSON.stringify({ kind: "calendar#freeBusy", calendars: { primary: { busy: [] } } }), { status: 200 });
  is("control: a free day is free", await googleFreeBusy("ya29.test-only", [], FROM, TO), []);

  part("Google's calendar list, read only in its shape");
  for (const [name, answer] of [
    ["items left out", { kind: "calendar#calendarList" }],
    ["items not a list", { kind: "calendar#calendarList", items: { id: "primary" } }],
  ] as [string, unknown][]) {
    googleAnswer = () => new Response(JSON.stringify(answer), { status: 200 });
    is(`${name}: refused, never read as no calendars`, await googleCalendars("ya29.test-only").then(() => "listed", () => "refused"), "refused");
  }
  googleAnswer = () =>
    new Response(JSON.stringify({ kind: "calendar#calendarList", items: [{ id: "me@example.com", summary: "Me", primary: true, accessRole: "owner" }] }), { status: 200 });
  is("control: the list is read", (await googleCalendars("ya29.test-only")).map((c) => c.id), ["me@example.com"]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
