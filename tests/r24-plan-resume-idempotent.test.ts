/**
 * "Resume now" inside a pause carries one idempotency key per try of the same
 * resume (lib/membership-pause.ts, resumeMembership; Codex G on #3090, and
 * Codex T's lease boundary on #3090). Resuming inside a pause starts a new
 * period with a payment (`billing_cycle_anchor=now`), so a second request
 * Stripe carries out charges the member again. The lock keeps two presses
 * apart only while it is held (a 120-second lease, let go when the first
 * press returns), so it cannot stop a request whose outcome we never learned
 * from being sent again: only the key can. Stripe answers a repeat of a key
 * with the first result, or 409 while the first is still being worked on.
 *
 * The key moves on only after Stripe said for certain that nothing was done
 * (a declined card, 402, or another refusal): Stripe keeps a declined result
 * under its key for a day, so a member who fixes their card must get a new
 * try. After no answer, a 409 or Stripe's own failure, the next try reuses
 * the key (CX-123 rule 24: unknown is never read as declined), and a try
 * whose counter cannot be read exactly sends nothing. The key a press sends
 * is written down first (the resume's record), and every later press of the
 * same pause sends it again, whatever `paused_at` then reads; a record that
 * cannot be read or written exactly sends nothing (Codex G on #3090).
 *
 * The Stripe stand-in below keeps keys as Stripe does (a saved result per key,
 * a key in flight answered 409, a key reused with other parameters answered
 * 400). Synthetic Stripe and Redis only.
 */
import { addMonths } from "@/lib/membership-pause-rules";
import { resumeMembership } from "@/lib/membership-pause";
import { createHash } from "node:crypto";
import { claimHandle, ensureStatsId, setPauseMonths, setStripeAccount, storeForEmail } from "@/lib/store";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const NOW = Math.floor(Date.UTC(2026, 9, 11, 12) / 1000);
const PERIOD_END = Math.floor(Date.UTC(2026, 9, 31, 9) / 1000);
const SUB = "sub_Member0000001";

const pausedSub = (): Record<string, unknown> => ({
  id: SUB,
  status: "active",
  customer: "cus_Member000001",
  pause_collection: { behavior: "void", resumes_at: addMonths(PERIOD_END, 2) },
  metadata: { store: "club", product: "prod000001", pause_from: String(PERIOD_END), paused_at: String(NOW) },
  items: { data: [{ current_period_end: PERIOD_END, price: { unit_amount: 900, currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
});

/** What the stand-in does with the next resume request it receives. */
type Mode = "normal" | "lost" | "hold" | "conflict" | "server";

let sub = pausedSub();
let cardOk = true;
let plan: Mode[] = [];
let saved = new Map<string, { status: number; body: unknown; params: string }>();
let inFlight = new Set<string>();
/** Every resume request sent, with its key ("" when none). */
let requests: { key: string; charge: boolean }[] = [];
/** Every new period Stripe carried out with a payment taken. */
let charged = 0;
let late: Promise<unknown> = Promise.resolve();
let arrived: () => void = () => {};
let release: () => void = () => {};

function reset(): void {
  sub = pausedSub();
  cardOk = true;
  plan = [];
  saved = new Map();
  inFlight = new Set();
  requests = [];
  charged = 0;
  late = Promise.resolve();
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/customers" && method === "GET") return json({ data: [{ id: "cus_Member000001" }], has_more: false });
  if (path === "/customers/cus_Member000001") return json({ id: "cus_Member000001", email: "member@example.com" });
  if (path === "/subscriptions" && method === "GET") return json({ data: [sub], has_more: false });
  if (path === `/subscriptions/${SUB}` && method === "POST") {
    const params = String(init?.body);
    const body = new URLSearchParams(params);
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    const charge = body.get("billing_cycle_anchor") === "now";
    requests.push({ key, charge });
    if (key) {
      if (inFlight.has(key)) return json({ error: { type: "idempotency_error", message: "A request with this key is in progress." } }, 409);
      const before = saved.get(key);
      if (before) {
        if (before.params !== params) return json({ error: { type: "idempotency_error", message: "Keys can only be reused with the same parameters." } }, 400);
        return json(before.body, before.status);
      }
    }
    const mode = plan.shift() ?? "normal";
    // Answered before Stripe started on it: nothing is saved under the key.
    if (mode === "conflict") return json({ error: { type: "idempotency_error", message: "A request with this key is in progress." } }, 409);
    if (mode === "server") return json({ error: { type: "api_error", message: "Something went wrong on Stripe's end." } }, 500);
    if (key) inFlight.add(key);
    const carryOut = (): { status: number; out: unknown } => {
      let status = 200;
      let out: unknown;
      if (charge && !cardOk) {
        // payment_behavior=error_if_incomplete: the update is refused when its payment fails, nothing changes.
        status = 402;
        out = { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } };
      } else {
        if (charge) charged += 1;
        const metadata = { ...(sub.metadata as Record<string, string>) };
        if (body.has("metadata[pause_from]")) metadata.pause_from = body.get("metadata[pause_from]") ?? "";
        sub = { ...sub, metadata, pause_collection: body.has("pause_collection") ? null : sub.pause_collection };
        out = sub;
      }
      if (key) {
        inFlight.delete(key);
        saved.set(key, { status, body: out, params });
      }
      return { status, out };
    };
    if (mode === "lost") {
      // Stripe has it and carries it out a moment later; the answer never reaches us.
      const held = new Promise<void>((resolve) => (release = resolve));
      late = held.then(carryOut);
      throw new TypeError("fetch failed");
    }
    if (mode === "hold") {
      const held = new Promise<void>((resolve) => (release = resolve));
      arrived();
      await held;
    }
    const { status, out } = carryOut();
    return json(out, status);
  }
  return json({ data: [], has_more: false });
}) as typeof fetch;

/** The resume counter's reads and writes, as Redis answers them, for a case to replace. */
type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
let hook: ((commands: Commands) => Promise<unknown[]> | null) | null = null;
redis.pipeline = (async (commands: Commands) => {
  const own = commands.some((command) => String(command[1] ?? "").startsWith("nl:tier:resume:"));
  const replaced = own && hook ? hook(commands) : null;
  return replaced ?? realPipeline(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_resume_only_a_stand_in";
  const OWNER = "club@example.com";
  await claimHandle(OWNER, "club", "Supper Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestClub000001", true);
  await setPauseMonths(OWNER, 2);
  const store = (await storeForEmail(OWNER))!;
  const token = "ab".repeat(32);
  const linkKey = `nl:manage:link:${createHash("sha256").update(`nimbus-manage:${token}`).digest("hex").slice(0, 40)}`;
  await redis.pipeline([["SET", linkKey, JSON.stringify({ a: store.stripeAccountId, c: "cus_Member000001", h: store.handle }), "EX", 3600]]);
  const when = PERIOD_END + DAY;
  const resume = () => resumeMembership(store, token, SUB, when);
  const keys = () => requests.map((r) => r.key);
  const sameKey = () => keys().length > 0 && keys().every((k) => k !== "" && k === keys()[0]);

  part("No answer to the first press, then the member presses again while Stripe is still on it");
  reset();
  plan = ["lost"];
  const lost = await resume();
  const retry = await resume();
  release();
  await late;
  is("the first press is unknown, never declined or resumed", lost, { ok: false, reason: "error" });
  is("the retry carries the same key, so Stripe never carries it out twice", [keys().length, sameKey()], [2, true]);
  is("Stripe answers the retry 409 (still working on the first): 'try again', never resumed", retry, { ok: false, reason: "error" });
  is("the member is charged once", charged, 1);
  const after = await resume();
  is("a press once the first landed finds nothing to resume and sends nothing", [after.ok, requests.length, charged], [false, 2, 1]);

  part("A first press held past its lock's lease (Codex T's boundary), and a second press meanwhile");
  reset();
  plan = ["hold"];
  const reached = new Promise<void>((resolve) => (arrived = resolve));
  const firstPending = resume();
  await reached;
  advance(121_000);
  const second = await resume();
  release();
  const first = await firstPending;
  is("the second press sends the same key as the first", [keys().length, sameKey()], [2, true]);
  is("the member is charged once, never twice", charged, 1);
  is("the first press resumes it; the second is 'try again'", [first, second], [{ ok: true }, { ok: false, reason: "error" }]);

  part("A declined card, then the member fixes it and presses again");
  reset();
  cardOk = false;
  const declined = await resume();
  is("the press is declined", declined, { ok: false, reason: "declined" });
  cardOk = true;
  const fixed = await resume();
  is("the next press is a new try with a new key, never Stripe's saved decline", [keys().length, keys().every(Boolean), keys()[0] !== keys()[1]], [2, true, true]);
  is("and it resumes the membership, charged once", [fixed, charged, sub.pause_collection], [{ ok: true }, 1, null]);

  part("A declined card whose new try could not be written down");
  reset();
  cardOk = false;
  hook = (commands) => (commands.some((c) => c[0] === "INCR") ? Promise.reject(new Error("Redis is away")) : null);
  const declinedUnwritten = await resume();
  hook = null;
  cardOk = true;
  const replayed = await resume();
  const nowNew = await resume();
  is("the decline is still a decline", declinedUnwritten, { ok: false, reason: "declined" });
  is("the next press reuses the key and gets Stripe's saved decline: never a second charge", [replayed, keys()[0] === keys()[1]], [{ ok: false, reason: "declined" }, true]);
  is("the press after it is a new try and resumes, charged once", [nowNew, keys()[2] !== keys()[1], charged], [{ ok: true }, true, 1]);

  part("A counter that cannot be read exactly");
  for (const [label, reply] of [
    ["a reply of another shape", (commands: Commands) => realPipeline(commands).then((r) => r.map((v, i) => (commands[i][0] === "GET" ? "twelve" : v)))],
    ["Redis away", () => Promise.reject(new Error("Redis is away"))],
  ] as const) {
    reset();
    hook = reply;
    const unread = await resume();
    hook = null;
    is(`${label}: nothing is sent to Stripe and the answer is "try again"`, [requests.length, unread], [0, { ok: false, reason: "error" }]);
  }

  part("Stripe answers 409 or fails on its own end");
  reset();
  plan = ["conflict", "server"];
  const conflict = await resume();
  const server = await resume();
  const then = await resume();
  is("a 409 is 'try again', never resumed or declined", conflict, { ok: false, reason: "error" });
  is("Stripe's own failure is 'try again'", server, { ok: false, reason: "error" });
  is("neither moves the key on: all three tries carry the same one", [keys().length, sameKey()], [3, true]);
  is("and the try after them resumes, charged once", [then, charged], [{ ok: true }, 1]);

  part("A pause taken off before it started, asked for again, and taken off again");
  reset();
  const early = PERIOD_END - DAY;
  const offFirst = await resumeMembership(store, token, SUB, early);
  is("the first is taken off", [offFirst, sub.pause_collection], [{ ok: true }, null]);
  const again = pausedSub();
  sub = { ...again, metadata: { ...(again.metadata as Record<string, string>), paused_at: String(NOW + 3600) } };
  const offAgain = await resumeMembership(store, token, SUB, early);
  is("the new pause is a resume of its own: a new key, carried out, never the first one's saved answer", [offAgain, keys()[0] !== keys()[1], sub.pause_collection], [{ ok: true }, true, null]);

  part("The resume's record: the key a press sent, written before it is sent (Codex G on #3090)");
  const record = `nl:tier:resume:${SUB}:${PERIOD_END}:${addMonths(PERIOD_END, 2)}:sent`;
  const fresh = async (metadata?: Record<string, unknown>) => {
    reset();
    await realPipeline([["DEL", record]]);
    if (metadata) sub = { ...sub, metadata: { ...(sub.metadata as Record<string, unknown>), ...metadata } };
  };
  await fresh({ paused_at: 7 });
  const unreadableFirst = await resume();
  is("a paused_at that cannot be read, with no resume sent before: nothing is sent, 'try again'", [requests.length, unreadableFirst], [0, { ok: false, reason: "error" }]);
  await fresh();
  sub = { ...sub, metadata: { store: "club", product: "prod000001", pause_from: String(PERIOD_END) } };
  const older = await resume();
  is("a pause older than paused_at, with no resume sent before, resumes once under the '0' key", [older, charged, keys()[0]?.endsWith(":0:0")], [{ ok: true }, 1, true]);
  await fresh();
  plan = ["lost"];
  await resume();
  const [written] = (await realPipeline([["GET", record]])) as [string];
  is("the record holds the exact key sent, before any answer", JSON.parse(written).k, keys()[0]);
  release();
  await late;
  for (const [label, reply] of [
    ["a record with a field of its own", JSON.stringify({ ...JSON.parse(written), extra: 1 })],
    ["a record whose key is of another pause", JSON.stringify({ ...JSON.parse(written), k: "nimbus-resume:sub_Other0000001:1:2:0:0" })],
    ["a record with no time", JSON.stringify({ k: JSON.parse(written).k, p: JSON.parse(written).p })],
    // Codex G on #3090 (review 5815152306): a send time later than now is unknown, with no room for clocks.
    ["a record whose send time is a minute in the future", JSON.stringify({ ...JSON.parse(written), s: Date.now() + 60_000 })],
    ["a record whose send time is two days in the future", JSON.stringify({ ...JSON.parse(written), s: Date.now() + 2 * DAY * 1000 })],
  ] as const) {
    await fresh();
    await realPipeline([["SET", record, reply]]);
    const unread = await resume();
    is(`${label}: nothing is sent and the answer is "try again"`, [requests.length, unread], [0, { ok: false, reason: "error" }]);
  }
  await fresh();
  await realPipeline([["SET", record, JSON.stringify({ ...JSON.parse(written), s: Date.now() + 60_000 })]]);
  const aheadFirst = await resume();
  const realNow = Date.now;
  const later = realNow() + 120_000;
  Date.now = () => later;
  let aheadLater: unknown;
  try {
    aheadLater = await resume();
  } finally {
    Date.now = realNow;
  }
  is("a stored send time once seen in the future stays unknown after the clock passes it: nothing is ever sent", [aheadFirst, aheadLater, requests.length], [{ ok: false, reason: "error" }, { ok: false, reason: "error" }, 0]);
  await fresh();
  await realPipeline([["SET", record, JSON.stringify({ ...JSON.parse(written), s: Date.now() })]]);
  const justSent = await resume();
  is("a record sent just now (not in the future, inside the window) repeats its own key once", [justSent, keys(), charged], [{ ok: true }, [JSON.parse(written).k], 1]);
  await fresh();
  hook = (commands) => (commands.some((c) => c[0] === "SET") ? Promise.resolve([null]) : null);
  const unwritten = await resume();
  hook = null;
  is("a record Redis did not write: nothing is sent", [requests.length, unwritten], [0, { ok: false, reason: "error" }]);
  await fresh();
  hook = (commands) => (commands.some((c) => c[0] === "SET") ? realPipeline([["SET", record, written]]).then(() => realPipeline(commands)) : null);
  const raced = await resume();
  hook = null;
  is("a record another press wrote meanwhile (NX): nothing is sent", [requests.length, raced], [0, { ok: false, reason: "error" }]);
  await fresh();
  hook = (commands) => (commands.some((c) => c[0] === "EXPIRE") ? realPipeline(commands).then((r) => r.map((v, i) => (commands[i][0] === "GET" ? "twelve" : v))) : null);
  const counterUnread = await resume();
  hook = null;
  const [left] = await realPipeline([["GET", record]]);
  is("no record and a try that cannot be read exactly: nothing is written or sent", [requests.length, counterUnread, left], [0, { ok: false, reason: "error" }, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
