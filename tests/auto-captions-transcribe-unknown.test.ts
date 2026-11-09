/**
 * An answer from the video service to the request to write captions is read
 * exactly (lib/auto-captions.ts, requestAutoCaptions; rule 24, finding R32,
 * from Claude 5's second money reviews of #3286, #3345 and #3346):
 *
 *   - only a stated refusal (a 4xx, or `success: false`) gives the charge
 *     back at once, once, and lets the video go;
 *   - any other answer (no answer at all, a request that was cut off, a 5xx,
 *     a 2xx other than 200) is unknown: the service may be writing them. The
 *     request is kept with its charge and queued, nothing is given back on
 *     it, and a retry charges nothing more and asks for nothing more. The
 *     sweep settles it on a known answer: captions delivered are used; none
 *     after GIVE_UP_HOURS are given back once, to the card or the credit
 *     balance that paid.
 *
 * The fake Stripe keeps its invoices and replays an idempotency key's first
 * answer, as Stripe does; the fake video service counts every request to
 * write captions it receives. Synthetic data only.
 */
import { autoCaptionStates, requestAutoCaptions, sweepAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
import { streamPath } from "@/lib/stream-rules";
import type { Store } from "@/lib/store";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const VIDEO = "4e7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const FOLDER = "e".repeat(32);
const PATH = streamPath(FOLDER, "lesson000004", VIDEO);
const KEY = `nl:stream:auto:${VIDEO}`;
const QUEUE = "nl:stream:autoq";
/** Ten minutes, English and Spanish. */
const PRICE = 12000;
const HOUR = 3_600_000;

type Invoice = { id: string; object: "invoice"; customer: string; status: string; currency: "usd"; amount_due: number; payment_intent: string | null; created: number; metadata: { mark: string }; total?: number; amount_paid?: number };
type BalanceTxn = { id: string; object: "customer_balance_transaction"; customer: string; amount: number; currency: "usd"; type: string; metadata: Record<string, string> | null };
type Refund = { id: string; object: "refund"; amount: number; currency: "usd"; payment_intent: string; status: string };

/** How the video service answers a request to write captions; it receives (and may bill) every one of them. */
type Reply = "ok" | "thrown" | "aborted" | "500" | "502" | "503" | "504" | "202" | "400" | "429" | "200-false";
let reply: Reply = "ok";
let invoices: Invoice[] = [];
let refunds: Refund[] = [];
let balanceTxns: BalanceTxn[] = [];
let customerBalance = 0;
let clock = 0;
const replays = new Map<string, { status: number; body: unknown }>();
const transcribes: unknown[] = [];
/** The languages the service lists captions in for the video. */
let delivered: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    if (url.pathname.includes("/transcribe")) {
      transcribes.push(JSON.parse(String(init?.body)));
      if (reply === "thrown") throw new TypeError("fetch failed");
      if (reply === "aborted") throw new DOMException("The operation was aborted.", "AbortError");
      if (reply === "500") return json({ success: false, message: "Internal Server Error", statusCode: 500 }, 500);
      if (reply === "502") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      if (reply === "503") return new Response("", { status: 503 });
      if (reply === "504") return new Response("<html>504 Gateway Time-out</html>", { status: 504 });
      if (reply === "202") return new Response("", { status: 202 });
      if (reply === "400") return json({ success: false, message: "Invalid language", statusCode: 400 }, 400);
      if (reply === "429") return json({ message: "Too many requests" }, 429);
      if (reply === "200-false") return json({ success: false, message: "Transcription unavailable", statusCode: 200 });
      return json({ success: true, statusCode: 200 });
    }
    return json({ guid: VIDEO, status: 4, captions: delivered.map((srclang) => ({ srclang, label: srclang })) });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const body = new URLSearchParams(String(init?.body ?? ""));
  const key = new Headers(init?.headers).get("Idempotency-Key");
  if (method === "POST" && key && replays.has(key)) {
    const saved = replays.get(key)!;
    return json(saved.body, saved.status);
  }
  const answer = (out: unknown, status = 200) => {
    if (method === "POST" && key) replays.set(key, { status, body: out });
    return json(out, status);
  };
  const invoiceOf = (id: string) => invoices.find((i) => i.id === decodeURIComponent(id));
  const history = /^\/customers\/([^/]+)\/balance_transactions$/.exec(path);
  if (history && method === "GET") return json({ object: "list", has_more: false, data: balanceTxns.filter((t) => t.customer === decodeURIComponent(history[1])).slice().reverse() });
  if (history && method === "POST") {
    const made: BalanceTxn = { id: `cbtxn_Unknown${String(balanceTxns.length + 1).padStart(6, "0")}`, object: "customer_balance_transaction", customer: decodeURIComponent(history[1]), amount: Number(body.get("amount")), currency: "usd", type: "adjustment", metadata: body.has("metadata[nl_captions_credit]") ? { nl_captions_credit: String(body.get("metadata[nl_captions_credit]")) } : null };
    balanceTxns.push(made);
    customerBalance += made.amount;
    return answer({ ...made });
  }
  if (path.startsWith("/subscriptions/")) return json({ id: "sub_Store000004", default_payment_method: "pm_card_on_file" });
  if (path === "/invoices" && method === "POST") {
    const made: Invoice = { id: `in_Unknown${String(invoices.length + 1).padStart(6, "0")}`, object: "invoice", customer: String(body.get("customer")), status: "draft", currency: "usd", amount_due: 0, payment_intent: null, created: clock, metadata: { mark: String(body.get("metadata[mark]")) } };
    invoices.push(made);
    return answer({ ...made });
  }
  if (path === "/invoices" && method === "GET") {
    const customer = url.searchParams.get("customer");
    const from = Number(url.searchParams.get("created[gte]") ?? 0);
    const to = Number(url.searchParams.get("created[lte]") ?? Infinity);
    return json({ object: "list", has_more: false, data: invoices.filter((i) => i.customer === customer && i.created >= from && i.created <= to).slice().reverse() });
  }
  if (path === "/invoiceitems") {
    const invoice = invoiceOf(String(body.get("invoice")));
    if (invoice) invoice.amount_due += Number(body.get("amount"));
    return answer({ id: `ii_${invoice?.id}` });
  }
  const action = /^\/invoices\/([^/]+)\/(finalize|pay|void)$/.exec(path);
  if (action) {
    const invoice = invoiceOf(action[1]);
    if (!invoice) return json({ error: { type: "invalid_request_error", message: "no such invoice" } }, 404);
    if (action[2] === "finalize") {
      invoice.status = "open";
      // A credit balance that covers the whole invoice pays it when it is finalized, with no payment.
      if (invoice.amount_due > 0 && -customerBalance >= invoice.amount_due) {
        customerBalance += invoice.amount_due;
        balanceTxns.push({ id: `cbtxn_Unknown${String(balanceTxns.length + 1).padStart(6, "0")}`, object: "customer_balance_transaction", customer: invoice.customer, amount: invoice.amount_due, currency: "usd", type: "applied_to_invoice", metadata: null });
        invoice.total = invoice.amount_due;
        invoice.amount_due = 0;
        invoice.amount_paid = 0;
        invoice.status = "paid";
      }
      return answer({ ...invoice });
    }
    if (action[2] === "pay") {
      if (invoice.status !== "open") return answer({ error: { type: "invalid_request_error", code: "invoice_not_open", message: "not open" } }, 400);
      invoice.status = "paid";
      invoice.payment_intent = `pi_Unknown${invoice.id.slice(-6)}`;
      return answer({ ...invoice });
    }
    if (invoice.status === "paid") return answer({ error: { type: "invalid_request_error", code: "invoice_not_voidable", message: "paid" } }, 400);
    invoice.status = "void";
    return answer({ ...invoice });
  }
  if (path.startsWith("/payment_intents/")) {
    const id = decodeURIComponent(path.slice("/payment_intents/".length));
    const invoice = invoices.find((i) => i.payment_intent === id);
    return json({ object: "payment_intent", id, currency: "usd", amount_received: invoice?.amount_due ?? 0 });
  }
  if (path === "/refunds" && method === "GET") {
    const intent = url.searchParams.get("payment_intent");
    return json({ object: "list", has_more: false, data: refunds.filter((r) => r.payment_intent === intent).slice().reverse() });
  }
  if (path === "/refunds" && method === "POST") {
    const intent = String(body.get("payment_intent"));
    const paid = invoices.find((i) => i.payment_intent === intent)?.amount_due ?? 0;
    const left = paid - refunds.filter((r) => r.payment_intent === intent && r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0);
    const asked = body.has("amount") ? Number(body.get("amount")) : left;
    if (asked <= 0 || asked > left) return answer({ error: { type: "invalid_request_error", code: "amount_too_large", message: "too much" } }, 400);
    const made: Refund = { id: `re_Unknown${String(refunds.length + 1).padStart(6, "0")}`, object: "refund", amount: asked, currency: "usd", payment_intent: intent, status: "succeeded" };
    refunds.push(made);
    return answer({ ...made });
  }
  return json({});
}) as typeof fetch;

const store = {
  handle: "chef",
  subscriptionActive: true,
  subscriptionId: "sub_Store000004",
  period: paidPeriod(),
  stripeCustomerId: "cus_Store000004",
} as unknown as Store;

/** Card charges kept: paid by card, less what was refunded. */
const keptOnCard = () => invoices.filter((i) => i.status === "paid" && i.payment_intent).reduce((sum, i) => sum + i.amount_due, 0) - refunds.filter((r) => r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0);
const paidCount = () => invoices.filter((i) => i.status === "paid").length;
const credits = () => balanceTxns.filter((t) => t.amount < 0).length;
const record = () => {
  const raw = redis.run(["GET", KEY]);
  return typeof raw === "string" ? (JSON.parse(raw) as { pi?: string; owed?: unknown; credit?: unknown; got?: string[] }) : null;
};
const queued = () => redis.run(["ZSCORE", QUEUE, VIDEO]) !== null;

function reset(): void {
  redis.clear();
  reply = "ok";
  invoices = [];
  refunds = [];
  balanceTxns = [];
  customerBalance = 0;
  replays.clear();
  transcribes.length = 0;
  delivered = [];
  redis.run(["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })]);
}

async function ask(at: number): Promise<string> {
  clock = Math.floor(at / 1000);
  const answer = await requestAutoCaptions(store, PATH, "en", ["es"], at);
  return answer.ok ? "asked" : answer.reason;
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_unknown_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
  const T = Date.now();

  const unknowns: { reply: Reply; what: string }[] = [
    { reply: "thrown", what: "no answer (the request failed on its way back: status 0)" },
    { reply: "aborted", what: "the request was cut off (a timeout: status 0)" },
    { reply: "500", what: "a 500 with a body saying success false" },
    { reply: "502", what: "a 502 from the edge" },
    { reply: "503", what: "a 503 with no body" },
    { reply: "504", what: "a 504 from the edge" },
    { reply: "202", what: "a 202 with no body" },
  ];

  for (const { reply: unknown, what } of unknowns) {
    part(`Card: the video service answers ${what}`);
    reset();
    reply = unknown;
    const first = await ask(T);
    reply = "ok";
    is("nothing is given back on an unknown answer", [refunds.length, keptOnCard()], [0, PRICE]);
    is("the request is kept with its charge, no refund owed, and queued", [record()?.pi, record()?.owed, queued()], [invoices[0]?.payment_intent, undefined, true]);
    is("the creator is told what the page shows: the captions are being written", [first, (await autoCaptionStates([PATH])).writing[PATH]], ["asked", ["en", "es"]]);
    is("a retry charges nothing more and asks for nothing more", [await ask(T + 1_000), paidCount(), invoices.length, transcribes.length], ["busy", 1, 1, 1]);
    delivered = ["en", "es"];
    advance(5 * 60_000);
    is("the captions arrive: used, the charge kept, one request to the service", [await syncAutoCaptions(VIDEO, T + 5 * 60_000), keptOnCard(), refunds.length, transcribes.length, record()], ["done", PRICE, 0, 1, null]);
  }

  part("Card: an unknown answer, and the service never wrote anything");
  reset();
  reply = "503";
  is("asked, nothing given back", [await ask(T), refunds.length], ["asked", 0]);
  reply = "ok";
  let last = 0;
  for (const hours of [1, 24, 47]) {
    advance((hours - last) * HOUR);
    last = hours;
    await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + hours * HOUR);
  }
  is("before GIVE_UP_HOURS nothing is given back and the request is still kept", [refunds.length, record() !== null, queued()], [0, true, true]);
  advance(2 * HOUR);
  await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + 49 * HOUR);
  is("past GIVE_UP_HOURS, on the service's answer that nothing is there: refunded in full, once", [refunds.length, keptOnCard(), record(), queued()], [1, 0, null, false]);
  advance(HOUR);
  await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + 50 * HOUR);
  is("a later sweep gives nothing back twice", [refunds.length, keptOnCard()], [1, 0]);
  is("asked again: one new charge, one new request to the service", [await ask(T + 51 * HOUR), paidCount(), keptOnCard(), transcribes.length], ["asked", 2, PRICE, 2]);

  part("Card: an unknown answer, then the service's answers stay unknown past GIVE_UP_HOURS");
  reset();
  reply = "thrown";
  is("asked, nothing given back", [await ask(T), refunds.length], ["asked", 0]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).hostname === "video.bunnycdn.com" ? new Response("", { status: 503 }) : realFetch(input, init))) as typeof fetch;
  advance(49 * HOUR);
  await syncAutoCaptions(VIDEO, T + 49 * HOUR);
  globalThis.fetch = realFetch;
  is("nothing is given back on an unknown look either; the request is kept and queued", [refunds.length, record()?.pi, queued()], [0, invoices[0]?.payment_intent, true]);

  part("Credit balance: the video service's answer is unknown");
  reset();
  customerBalance = -50_000;
  reply = "504";
  const fromCredit = await ask(T);
  reply = "ok";
  is("paid from the credit, nothing given back on an unknown answer", [fromCredit, customerBalance, credits(), record()?.credit !== undefined, queued()], ["asked", -38_000, 0, true, true]);
  is("a retry charges nothing more", [await ask(T + 1_000), invoices.length, customerBalance, transcribes.length], ["busy", 1, -38_000, 1]);
  advance(49 * HOUR);
  await syncAutoCaptions(VIDEO, T + 49 * HOUR);
  is("nothing written after GIVE_UP_HOURS: the whole price goes back to the credit balance, once", [customerBalance, credits(), record()], [-50_000, 1, null]);
  advance(HOUR);
  await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + 50 * HOUR);
  is("and never twice", [customerBalance, credits()], [-50_000, 1]);

  reset();
  customerBalance = -50_000;
  reply = "thrown";
  await ask(T);
  reply = "ok";
  delivered = ["en", "es"];
  advance(5 * 60_000);
  is("credit, answer lost, captions delivered: used, nothing given back", [await syncAutoCaptions(VIDEO, T + 5 * 60_000), customerBalance, credits(), transcribes.length], ["done", -38_000, 0, 1]);

  const refusals: { reply: Reply; what: string }[] = [
    { reply: "400", what: "a 400" },
    { reply: "429", what: "a 429" },
    { reply: "200-false", what: "a 200 saying success false" },
  ];
  for (const { reply: refused, what } of refusals) {
    part(`Control: the video service refuses with ${what}`);
    reset();
    reply = refused;
    is("refunded in full at once, and the video is free", [await ask(T), refunds.length, keptOnCard(), record()], ["refunded", 1, 0, null]);
    reply = "ok";
    advance(49 * HOUR);
    await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + 49 * HOUR);
    is("never refunded twice", [refunds.length, keptOnCard()], [1, 0]);
    is("asked again: one new charge, used", [await ask(T + 50 * HOUR), paidCount(), keptOnCard(), transcribes.length], ["asked", 2, PRICE, 2]);
  }

  part("Control: a refusal on the credit balance goes back to it, once");
  reset();
  customerBalance = -50_000;
  reply = "400";
  is("credited at once", [await ask(T), customerBalance, credits(), record()], ["credited", -50_000, 1, null]);

  part("Control: an answer that accepts is used as before");
  reset();
  is("asked once, kept, queued", [await ask(T), transcribes.length, keptOnCard(), queued()], ["asked", 1, PRICE, true]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
