/**
 * AI captions are charged once, whatever happens to the charge on its way
 * (lib/auto-captions.ts, requestAutoCaptions; inventory of money calls,
 * 8 November 2026, findings 1 and 2):
 *
 *   - a payment Stripe made but whose answer never came back (a timeout or a
 *     5xx on /pay) is never taken for "nothing was charged": the request is
 *     kept, a retry charges nothing more, and the charge is either used (the
 *     captions are asked for) or refunded in full, once;
 *   - the key of a charge comes from an order written before it, never from
 *     the clock of the attempt;
 *   - a process that dies right after the charge leaves a record the sweep
 *     finds: the charge is refunded, and a retry charges nothing more while
 *     it is not.
 *
 * The fake Stripe keeps its invoices and replays an idempotency key's first
 * answer, as Stripe does; synthetic data only.
 */
import { requestAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
import { streamPath } from "@/lib/stream-rules";
import type { Store } from "@/lib/store";
import { readFileSync } from "node:fs";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const VIDEO = "2c7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const FOLDER = "c".repeat(32);
const PATH = streamPath(FOLDER, "lesson000003", VIDEO);
const KEY = `nl:stream:auto:${VIDEO}`;
const PRICE = 12000;

type Invoice = { id: string; object: "invoice"; customer: string; status: string; currency: "usd"; amount_due: number; payment_intent: string | null; created: number; metadata: { mark: string } };
type Refund = { id: string; object: "refund"; amount: number; currency: "usd"; payment_intent: string; status: string };
let invoices: Invoice[] = [];
let refunds: Refund[] = [];
const replays = new Map<string, { status: number; body: unknown }>();
/** Stripe's clock, in seconds. */
let clock = 0;
/** /pay: Stripe pays the invoice, and its answer is lost (a 500 here, as a timeout or an outage would leave it). */
let payAnswerLost = false;
/** Stripe's invoice list cannot be read. */
let listDown = false;
/** The process dies the moment /pay answers: nothing after it runs. */
let dieAfterPay = false;
/** The process dies when this Stripe call is reached, before Stripe does it. */
let dieAt = "";
let dead = false;
const transcribes: unknown[] = [];

class Died extends Error {}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (dead) throw new Died("the process is gone");
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    if (url.pathname.includes("/transcribe")) {
      transcribes.push(JSON.parse(String(init?.body)));
      return json({ success: true, statusCode: 200 });
    }
    return json({ guid: VIDEO, status: 4, captions: [] });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (dieAt && `${method} ${path}`.endsWith(dieAt)) {
    dead = true;
    throw new Died("the process is gone");
  }
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
  if (path.startsWith("/subscriptions/")) return json({ id: "sub_Store000003", default_payment_method: "pm_card_on_file" });
  if (path === "/invoices" && method === "POST") {
    const made: Invoice = { id: `in_Captions${String(invoices.length + 1).padStart(6, "0")}`, object: "invoice", customer: String(body.get("customer")), status: "draft", currency: "usd", amount_due: 0, payment_intent: null, created: clock, metadata: { mark: String(body.get("metadata[mark]")) } };
    invoices.push(made);
    return answer({ ...made });
  }
  if (path === "/invoices" && method === "GET") {
    if (listDown) return json({ error: { type: "api_error", message: "down" } }, 500);
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
      return answer({ ...invoice });
    }
    if (action[2] === "pay") {
      if (invoice.status !== "open") return answer({ error: { type: "invalid_request_error", code: "invoice_not_open", message: "not open" } }, 400);
      invoice.status = "paid";
      invoice.payment_intent = `pi_Captions${invoice.id.slice(-6)}`;
      if (dieAfterPay) dead = true;
      if (payAnswerLost) return json({ error: { type: "api_error", message: "the answer was lost" } }, 500);
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
    const made: Refund = { id: `re_Captions${String(refunds.length + 1).padStart(6, "0")}`, object: "refund", amount: asked, currency: "usd", payment_intent: intent, status: "succeeded" };
    refunds.push(made);
    return answer({ ...made });
  }
  return json({});
}) as typeof fetch;

const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = async (commands) => {
  if (dead) throw new Died("the process is gone");
  return realPipeline(commands);
};

const store = {
  handle: "chef",
  subscriptionActive: true,
  subscriptionId: "sub_Store000003", period: paidPeriod(),
  stripeCustomerId: "cus_Store000003",
} as unknown as Store;

/** Charges kept: paid invoices less what was refunded on them. */
const kept = () => invoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.amount_due, 0) - refunds.filter((r) => r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0);
const paidCount = () => invoices.filter((i) => i.status === "paid").length;

function reset(): void {
  redis.clear();
  invoices = [];
  refunds = [];
  replays.clear();
  transcribes.length = 0;
  payAnswerLost = false;
  listDown = false;
  dieAfterPay = false;
  dieAt = "";
  dead = false;
  redis.run(["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })]);
}

/** A request at `at` ms; Stripe's clock follows. */
async function ask(at: number): Promise<string> {
  clock = Math.floor(at / 1000);
  try {
    const answer = await requestAutoCaptions(store, PATH, "en", ["es"], at);
    return answer.ok ? "asked" : answer.reason;
  } catch (error) {
    if (error instanceof Died) return "died";
    throw error;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
  const T = Date.now();

  part("Stripe paid, and its answer was lost on the way back");
  reset();
  payAnswerLost = true;
  const first = await ask(T);
  payAnswerLost = false;
  is("one invoice paid", paidCount(), 1);
  is("the charge Stripe made is not taken for nothing: it is used, the captions asked for once", [first, transcribes.length], ["asked", 1]);
  const pending = (JSON.parse(String(redis.run(["GET", KEY]) ?? "{}")) ?? {}) as { pi?: string };
  is("and recorded with the payment Stripe made, for a refund", pending.pi, invoices[0].payment_intent);
  const retried = await ask(T + 1_000);
  is("a retry charges nothing more", [retried, paidCount(), invoices.length, kept()], ["busy", 1, 1, PRICE]);

  part("Stripe paid, its answer was lost, and the invoice cannot be read either");
  reset();
  payAnswerLost = true;
  listDown = true;
  const unknown = await ask(T);
  payAnswerLost = false;
  is("not said to be uncharged, nothing asked of the service", [unknown, transcribes.length, paidCount()], ["checking", 0, 1]);
  is("the request is kept and looked at again", [redis.run(["GET", KEY]) !== null, redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]) !== null], [true, true]);
  const order = (JSON.parse(String(redis.run(["GET", KEY]))) as { order: string }).order;
  is("the charge's key comes from the order written before it", [...replays.keys()].filter((k) => k.endsWith(":invoice")), [`nl-captions:${VIDEO}:${order}:invoice`]);
  is("a retry at once charges nothing more", [await ask(T + 1_000), paidCount(), invoices.length], ["checking", 1, 1]);
  advance(10 * 60_000);
  is("ten minutes on, still nothing more", [await ask(T + 10 * 60_000), paidCount(), invoices.length], ["checking", 1, 1]);
  listDown = false;
  advance(10 * 60_000);
  await syncAutoCaptions(VIDEO, T + 20 * 60_000);
  await syncAutoCaptions(VIDEO, T + 40 * 60_000);
  is("once Stripe can be read: the charge it made is refunded in full, once", [paidCount(), refunds.length, kept()], [1, 1, 0]);
  is("and the record is gone, so the video can be asked for again", redis.run(["GET", KEY]), null);
  is("asked again: one new charge, used", [await ask(T + 41 * 60_000), paidCount(), kept(), transcribes.length], ["asked", 2, PRICE, 1]);

  part("The process dies right after the charge");
  reset();
  dieAfterPay = true;
  const died = await ask(T);
  dead = false;
  dieAfterPay = false;
  is("charged, and nothing after it ran", [died, paidCount(), transcribes.length], ["died", 1, 0]);
  advance(6 * 60_000);
  is("six minutes on, a retry charges nothing more", [await ask(T + 6 * 60_000), paidCount(), invoices.length], ["checking", 1, 1]);
  const sweepPipeline = redis.pipeline;
  redis.pipeline = async (commands) => (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY ? ([] as unknown[]) : sweepPipeline(commands));
  is("a look whose read of the record comes back in an unknown shape keeps the video queued", [await syncAutoCaptions(VIDEO, T + 7 * 60_000), redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]) !== null, redis.run(["GET", KEY]) !== null], ["waiting", true, true]);
  redis.pipeline = sweepPipeline;
  advance(10 * 60_000);
  await syncAutoCaptions(VIDEO, T + 16 * 60_000);
  await syncAutoCaptions(VIDEO, T + 30 * 60_000);
  is("the sweep finds the charge and refunds it in full, once", [paidCount(), refunds.length, kept()], [1, 1, 0]);
  is("a retry after it: one new charge, used", [await ask(T + 31 * 60_000), paidCount(), kept(), transcribes.length], ["asked", 2, PRICE, 1]);

  part("The process dies before Stripe made anything, or before it paid");
  reset();
  dieAt = "GET /subscriptions/sub_Store000003";
  // Nothing after the cut answers, so the order is kept as not known.
  is("cut off before any invoice: kept, nothing charged", [await ask(T), invoices.length, redis.run(["GET", KEY]) !== null], ["checking", 0, true]);
  dieAt = "";
  dead = false;
  advance(5 * 60_000);
  is("five minutes on: held, nothing charged", [await ask(T + 5 * 60_000), invoices.length], ["checking", 0]);
  advance(11 * 60_000);
  is("once it is old enough: no invoice was made, so the order goes, and nothing is charged by it", [await ask(T + 16 * 60_000), invoices.length, redis.run(["GET", KEY])], ["unavailable", 0, null]);
  is("asked again: charged once, used", [await ask(T + 17 * 60_000), paidCount(), transcribes.length], ["asked", 1, 1]);
  reset();
  dieAt = "/pay";
  is("cut off with the invoice open, before it was paid: kept", [await ask(T), invoices.map((i) => i.status), redis.run(["GET", KEY]) !== null], ["checking", ["open"], true]);
  dieAt = "";
  dead = false;
  advance(16 * 60_000);
  is("the sweep voids the open invoice and lets the video go; nothing charged", [await syncAutoCaptions(VIDEO, T + 16 * 60_000), invoices.map((i) => i.status), paidCount(), redis.run(["GET", KEY])], ["done", ["void"], 0, null]);

  part("The invoices are read at the version chargeNow writes them with");
  is("the same API version as lib/billing.ts charges with", [readFileSync("lib/billing.ts", "utf8").includes('const CHARGE_VERSION = "2024-06-20";'), readFileSync("lib/auto-captions.ts", "utf8").includes('const CHARGE_READ_VERSION = "2024-06-20";')], [true, true]);

  part("A declined card is still said to be declined, and frees the video");
  reset();
  const declinedPay = invoices.length;
  // Stripe declines: /pay answers 402 and the invoice stays open, then is voided.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/pay")) return new Response(JSON.stringify({ error: { code: "card_declined", message: "Your card was declined." } }), { status: 402 });
    return realFetch(input, init);
  }) as typeof fetch;
  const declined = await ask(T);
  globalThis.fetch = realFetch;
  is("declined, nothing charged, nothing asked, the video free again", [declined, paidCount(), transcribes.length, redis.run(["GET", KEY]), invoices.length - declinedPay], ["declined", 0, 0, null, 1]);
  is("the next request charges once, under a key of its own", [await ask(T + 1_000), paidCount(), invoices.length], ["asked", 1, 2]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
