/**
 * Settling a PayPal payout batch whose first answer was not known (decision
 * of Claude 1, C1-20261105-1830-C5-1, option A). The daily settling sends
 * the SAME request again: the same sender_batch_id and the same
 * PayPal-Request-Id. PayPal's own pages, as found on 05/11/2026: the same
 * PayPal-Request-Id gets back the latest state of the batch the first
 * request made; a sender_batch_id used in the last 30 days is refused
 * (400 USER_BUSINESS_ERROR) with a link to the original batch. So:
 *
 *   - the answer was lost after PayPal made it: the retry gets that batch
 *     back; one payment;
 *   - the first request never reached PayPal: the retry makes it, once;
 *   - PayPal says the batch already exists: it is taken as sent, its id
 *     kept when the answer gives it, never paid again; without an id it
 *     needs a manual check;
 *   - any other answer: still on its way, never sent with a new key;
 *   - at most one try a day; after 7 days it needs a manual check and is
 *     not tried again;
 *   - counted by month for the owner's report, with no store or person.
 *
 * Synthetic only: a stand-in for PayPal that keeps idempotency keys and
 * sender_batch_ids as PayPal says it does.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { connectPayPal, onTheirWay, payWithPayPal, payoutUnknownMonth, settlePayPal } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "statsrec01";
const OPEN = `nl:pp:open:${STATS}`;
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
const DAY = 86_400_000;

/** What the stand-in does with the next POST. */
type Next = "make" | "make-then-drop" | "drop-before" | "server" | "garbled" | "forget-key";
let next: Next = "make";
/** Whether a duplicate sender_batch_id's refusal carries the link to the original batch. */
let duplicateLink = true;
const byKey = new Map<string, { status: number; body: unknown }>();
const bySender = new Map<string, string>();
let batches = 0;
/** Stripe's refunds as readBook reads them (review of Codex G on #2681, second GRAVE). */
let stripeState: "normal" | "down" | "refunded" = "normal";
let posts = 0;
/** The receivers of each POST, in order (review of Codex H2 on #2681). */
let receivers: string[][] = [];
const items = new Map<string, string>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.stripe.com") {
    if (stripeState === "down") return json({ error: { message: "synthetic unavailable" } }, 500);
    if (stripeState === "refunded" && url.pathname === "/v1/refunds") return json({ object: "list", data: [{ id: "re_1", object: "refund", payment_intent: "pi_cs_1", amount: 10000, currency: "usd", status: "succeeded" }, { id: "re_2", object: "refund", payment_intent: "pi_cs_2", amount: 5000, currency: "usd", status: "succeeded" }], has_more: false });
    return json({ object: "list", data: [], has_more: false });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts", expires_in: 32400 });
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    posts += 1;
    const mode = next;
    const key = headers.get("paypal-request-id") ?? "";
    const body = JSON.parse(String(init.body)) as { sender_batch_header: { sender_batch_id: string }; items: { sender_item_id: string; receiver: string }[] };
    receivers.push(body.items.map((item) => item.receiver));
    const sender = body.sender_batch_header.sender_batch_id;
    if (mode === "drop-before") throw new TypeError("fetch failed: before PayPal");
    if (mode === "server") return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    if (mode === "garbled") return new Response("<html>", { status: 201 });
    if (mode === "forget-key") byKey.delete(key);
    const kept = byKey.get(key);
    if (kept) return json(kept.body, kept.status);
    const original = bySender.get(sender);
    if (original) {
      const detail: Record<string, unknown> = { field: "sender_batch_id", issue: "Batch with given sender_batch_id already exists" };
      if (duplicateLink) detail.link = { href: `https://api-m.paypal.com/v1/payments/payouts/${original}`, rel: "self", method: "GET" };
      return json({ name: "USER_BUSINESS_ERROR", message: "User business error.", details: [detail], links: [] }, 400);
    }
    batches += 1;
    const id = `BATCH${batches}REC`;
    bySender.set(sender, id);
    for (const item of body.items) items.set(`${id}:${item.sender_item_id}`, "SUCCESS");
    const made = { status: 201, body: { batch_header: { payout_batch_id: id, batch_status: "PENDING", sender_batch_header: body.sender_batch_header } } };
    byKey.set(key, made);
    if (mode === "make-then-drop") throw new TypeError("fetch failed: the answer was lost");
    return json(made.body, made.status);
  }
  const batch = /^\/v1\/payments\/payouts\/(BATCH\d+REC)$/.exec(url.pathname)?.[1];
  if (batch) {
    const mine = [...items.entries()].filter(([k]) => k.startsWith(`${batch}:`));
    return json({
      batch_header: { payout_batch_id: batch, batch_status: "SUCCESS" },
      total_pages: 1,
      items: mine.map(([k, status], i) => ({ payout_item_id: `ITEM${batch}${i}`, payout_batch_id: batch, transaction_status: status, payout_item: { sender_item_id: k.split(":")[1] } })),
    });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

function shop(): Store {
  return {
    sid: "sidrecon01", handle: "harbor", name: "Harbor Kitchen", previousHandles: [], releasedHandles: [],
    statsId: STATS, stripeAccountId: "acct_1TestHarbor0001", currency: "usd",
    affiliates: { enabled: true, percent: 30, days: 30, rates: {}, payday: 5, hold: 0 },
  } as unknown as Store;
}

async function seed(store: Store): Promise<void> {
  redis.clear();
  byKey.clear();
  bySender.clear();
  items.clear();
  batches = 0;
  posts = 0;
  receivers = [];
  duplicateLink = true;
  const at = Math.floor(Date.now() / 1000) - 86_400;
  const person = (id: string, email: string, code: string) => JSON.stringify({ id, email, code, status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
  const sale = (ref: string, aff: string, base: number) => JSON.stringify({ ref, pi: `pi_${ref}`, aff, at, product: "p1", title: "Guide", base, total: base, currency: "usd", rate: 30, self: false });
  await redis.pipeline([
    ["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", person("aaaaaaaaaaaa", "sara@example.com", "sara")],
    ["HSET", `nl:aff:${STATS}:people`, "bbbbbbbbbbbb", person("bbbbbbbbbbbb", "tom@example.com", "tom")],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_1", sale("cs_1", "aaaaaaaaaaaa", 10000)],
    ["HSET", `nl:aff:${STATS}:sales`, "cs_2", sale("cs_2", "bbbbbbbbbbbb", 5000)],
  ]);
  const linked = await connectPayPal(store, CLIENT, SECRET);
  if (!linked.ok) throw new Error(`not linked: ${JSON.stringify(linked)}`);
}

/** The open batch fields, the unknown ones as "?". */
async function fields(): Promise<string[]> {
  const [raw] = await redis.pipeline([["HKEYS", OPEN]]);
  return (raw as string[]).map((f) => (f.startsWith("?") ? "?" : f)).sort();
}

/** Moves every unknown entry's clock back by `ms`, as if that long had passed. */
async function age(field: "at" | "t", ms: number): Promise<void> {
  const [raw] = await redis.pipeline([["HGETALL", OPEN]]);
  const flat = raw as string[];
  for (let i = 0; i < flat.length; i += 2) {
    if (!flat[i].startsWith("?")) continue;
    const entry = JSON.parse(flat[i + 1]) as Record<string, unknown>;
    if (typeof entry[field] === "number") entry[field] = (entry[field] as number) - ms;
    await redis.pipeline([["HSET", OPEN, flat[i], JSON.stringify(entry)]]);
  }
}

const paidCents = async (store: Store) => (await readBook(store)).rows.reduce((n, r) => n + r.paid, 0);
const month = () => new Date().toISOString().slice(0, 7);
const counts = async () => {
  const [raw] = await redis.pipeline([["HGETALL", `nl:pp:unk:month:${month()}`]]);
  const flat = (raw ?? []) as string[];
  const out: Record<string, number> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
  return out;
};

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_paypal_reconcile_only";
  console.error = () => {};
  const store = shop();

  part("The answer was lost after PayPal made the batch: the retry gets it back, one payment");
  await seed(store);
  next = "make-then-drop";
  is("the press is not known", (await payWithPayPal(store)).ok ? "paid" : "unknown", "unknown");
  next = "make";
  await settlePayPal(store);
  is("one batch in all, now known by PayPal's id", [batches, await fields()], [1, ["BATCH1REC"]]);
  await settlePayPal(store);
  is("paid once, and nobody on their way any more", [await paidCents(store), (await onTheirWay(store)).size], [4500, 0]);
  is("counted for the month: one unknown, one settled", [(await counts()).unknown, (await counts()).settled], [1, 1]);

  part("The first request never reached PayPal: the retry makes it, once");
  await seed(store);
  next = "drop-before";
  await payWithPayPal(store);
  next = "make";
  await settlePayPal(store);
  await settlePayPal(store);
  is("one batch, paid once", [batches, await paidCents(store)], [1, 4500]);

  part("PayPal says the batch already exists, with its link: taken as sent, its id kept, never paid again");
  await seed(store);
  next = "make-then-drop";
  await payWithPayPal(store);
  next = "forget-key";
  await settlePayPal(store);
  is("still one batch, known by the original's id", [batches, await fields()], [1, ["BATCH1REC"]]);

  part("PayPal says it already exists, without a link: needs a manual check, never paid again");
  await seed(store);
  next = "make-then-drop";
  await payWithPayPal(store);
  next = "forget-key";
  duplicateLink = false;
  await settlePayPal(store);
  const [rawDup] = await redis.pipeline([["HGETALL", OPEN]]);
  const dupEntry = JSON.parse(String((rawDup as string[])[1])) as { m?: unknown };
  is("kept, marked for a manual check", [batches, await fields(), dupEntry.m], [1, ["?"], 1]);
  await age("t", 2 * DAY);
  const before = posts;
  await settlePayPal(store);
  is("and not tried again", posts, before);
  is("both still on their way, nobody paid", [(await onTheirWay(store)).size, await paidCents(store)], [2, 0]);

  part("Any other answer: still on its way, at most one try a day");
  await seed(store);
  next = "drop-before";
  await payWithPayPal(store);
  next = "server";
  const p0 = posts;
  await settlePayPal(store);
  is("one try", posts - p0, 1);
  next = "garbled";
  await settlePayPal(store);
  await settlePayPal(store);
  is("no second try the same day", posts - p0, 1);
  is("still on its way, nothing made", [await fields(), batches], [["?"], 0]);
  await age("t", DAY + 60_000);
  await settlePayPal(store);
  is("a day later, one more try, still unknown", [posts - p0, await fields()], [2, ["?"]]);

  part("After 7 days: a manual check, no more tries");
  await age("at", 7 * DAY);
  await age("t", 2 * DAY);
  const p1 = posts;
  next = "make";
  await settlePayPal(store);
  const [rawLate] = await redis.pipeline([["HGETALL", OPEN]]);
  const late = JSON.parse(String((rawLate as string[])[1])) as { m?: unknown };
  is("marked for a manual check and not tried", [late.m, posts - p1, batches], [1, 0, 0]);

  part("The settling gets the batch back and writing its id fails: the evidence stays, nobody is paid twice (review of Codex G on #2681)");
  {
    await seed(store);
    next = "make-then-drop";
    await payWithPayPal(store);
    next = "make";
    const real = redis.pipeline.bind(redis);
    let hit = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const first = commands[0];
      if (!hit && first?.[0] === "HSET" && first[1] === OPEN && !String(first[2]).startsWith("?")) {
        hit = true;
        // As Codex G's proof: the id's write fails, and any HDEL sent beside it still runs.
        const removed = await real(commands.filter((c) => c[0] === "HDEL"));
        return [undefined, ...removed];
      }
      return real(commands);
    }) as typeof redis.pipeline;
    try {
      await settlePayPal(store);
    } finally {
      redis.pipeline = real;
    }
    is("the write of its id failed, the '?' evidence is kept", [hit, await fields()], [true, ["?"]]);
    is("both still on their way", (await onTheirWay(store)).size, 2);
    await payWithPayPal(store);
    is("a press sends no new batch", batches, 1);
    await age("t", DAY + 60_000);
    await settlePayPal(store);
    await settlePayPal(store);
    is("the next day's try gets the same batch back and settles it, paid once", [batches, await fields(), await paidCents(store)], [1, [], 4500]);
  }

  part("An affiliate changed their PayPal address before the retry: never sent to another recipient (review of Codex H2 on #2681, GRAVE)");
  {
    await seed(store);
    next = "drop-before";
    await payWithPayPal(store);
    const changed = JSON.stringify({ id: "aaaaaaaaaaaa", email: "sara@example.com", paypal: "changed@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 2, note: "" });
    await redis.pipeline([["HSET", `nl:aff:${STATS}:people`, "aaaaaaaaaaaa", changed]]);
    next = "make";
    const before = posts;
    await settlePayPal(store);
    is("no request to PayPal, no batch", [posts - before, batches], [0, 0]);
    is("nothing ever sent to the new address", receivers.flat().includes("changed@example.com"), false);
    const [rawHeld] = await redis.pipeline([["HGETALL", OPEN]]);
    const held = JSON.parse(String((rawHeld as string[])[1])) as { m?: unknown; lines?: Record<string, unknown>[] };
    is("left for the creator's own check", held.m, 1);
    is("the address itself is never kept in the batch, only its fingerprint", JSON.stringify(held).includes("@"), false);
    // A plain SHA-256 of an address is turned back by guessing addresses; the fingerprint is keyed with the
    // server's own secret (Revisor 2's privacy note on #2681).
    const plain = createHash("sha256").update("sara@example.com").digest("hex");
    is("the fingerprint is keyed, never a plain hash of the address", JSON.stringify(held).includes(plain), false);
  }

  part("The same address: the retry sends the same recipients");
  {
    await seed(store);
    next = "drop-before";
    await payWithPayPal(store);
    next = "make";
    await settlePayPal(store);
    is("same recipients as the first request", receivers[1], receivers[0]);
  }

  for (const state of ["down", "refunded"] as const) {
    part(`Before the retry, Stripe's refunds ${state === "down" ? "cannot be read" : "took back every sale"}: nothing is sent (review of Codex G on #2681)`);
    stripeState = "normal";
    await seed(store);
    next = "drop-before";
    await payWithPayPal(store);
    stripeState = state;
    next = "make";
    const before = posts;
    await settlePayPal(store);
    is("no request to PayPal, no batch", [posts - before, batches], [0, 0]);
    is("still on its way", (await onTheirWay(store)).size, 2);
    const [rawHeld] = await redis.pipeline([["HGETALL", OPEN]]);
    const held = JSON.parse(String((rawHeld as string[])[1])) as { m?: unknown };
    is(state === "down" ? "waiting for refunds that can be read, not a manual check" : "less owed now than was sent: a manual check", held.m ?? 0, state === "down" ? 0 : 1);
    stripeState = "normal";
  }

  part("Counted by month for the owner's report, with no store or person");
  const c = await counts();
  is("unknown and manual (settled is counted in the first part)", [c.unknown >= 1, c.manual >= 1], [true, true]);
  const [names] = await redis.pipeline([["HKEYS", `nl:pp:unk:month:${month()}`]]);
  is("only those three counts", (names as string[]).every((n) => ["unknown", "settled", "manual"].includes(n)), true);

  part("The month's counts are read only in their exact envelope (review of Codex G on #2681, LEVE)");
  {
    is("one answer of three counts is read", (await payoutUnknownMonth(month())) !== null, true);
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const answer = await real(commands);
      // An extra reply beside the HMGET's: the envelope is not one answer.
      return commands[0]?.[0] === "HMGET" ? [...answer, "1"] : answer;
    }) as typeof redis.pipeline;
    try {
      is("two answers to one command: not known", await payoutUnknownMonth(month()), null);
    } finally {
      redis.pipeline = real;
    }
    // Only Redis's own data counts (Codex H2 on #2681, 1d76ab7f): an inherited or getter reply is not known, and
    // a getter is never run.
    let visits = 0;
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, { 0: ["1", "2", "3"] });
    const executable = [["1", "2", "3"]];
    Object.defineProperty(executable, "0", { get() { visits += 1; return ["1", "2", "3"]; } });
    const innerGetter: unknown[] = [["1", "2", "3"]];
    Object.defineProperty(innerGetter[0] as unknown[], "1", { get() { visits += 1; return "2"; } });
    for (const [what, answer] of [["an inherited reply", inherited], ["a getter reply", executable], ["a getter count", innerGetter]] as const) {
      redis.pipeline = (async () => answer) as unknown as typeof redis.pipeline;
      try {
        is(`${what}: not known`, await payoutUnknownMonth(month()), null);
      } finally {
        redis.pipeline = real;
      }
    }
    is("no getter was run", visits, 0);
    // A Proxy is not Redis's own data either, and none of its traps runs (Codex G on #2681, 1e3c6bfb).
    let traps = 0;
    const handler: ProxyHandler<unknown[]> = {
      getOwnPropertyDescriptor(target, key) { traps += 1; return Reflect.getOwnPropertyDescriptor(target, key); },
      // Resolving a promise looks up "then" on whatever it resolves with (the language's own step, before our code
      // has the reply): that one lookup is not our reading the reply, so it is not counted.
      get(target, key) { if (key !== "then") traps += 1; return Reflect.get(target, key); },
    };
    const outerProxy = new Proxy([["1", "2", "3"]], handler);
    const innerProxy = [new Proxy(["1", "2", "3"], handler)];
    for (const [what, answer] of [["a Proxy reply", outerProxy], ["a Proxy count list", innerProxy]] as const) {
      redis.pipeline = (async () => answer) as unknown as typeof redis.pipeline;
      try {
        is(`${what}: not known`, await payoutUnknownMonth(month()), null);
      } finally {
        redis.pipeline = real;
      }
    }
    is("no Proxy trap was run", traps, 0);
  }

  part("The studio says it, with the way to look in PayPal");
  const panel = readFileSync("components/paypal-payouts.tsx", "utf8");
  is("words for a batch being checked and one that needs a manual check, and PayPal's activity page", [/being checked with PayPal/.test(panel), /check them in your PayPal activity/.test(panel), /href="https:\/\/www\.paypal\.com\/myaccount\/activities\/"/.test(panel)], [true, true, true]);
  const page = readFileSync("app/studio/affiliates/page.tsx", "utf8");
  is("the studio page passes both counts", [/checking=\{/.test(page), /manualCheck=\{/.test(page)], [true, true]);
  done();
}

void main();
