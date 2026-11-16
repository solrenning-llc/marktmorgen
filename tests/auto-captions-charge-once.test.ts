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
import { requestAutoCaptions, sweepAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
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

type Invoice = { id: string; object: "invoice"; customer: string; status: string; currency: "usd"; amount_due: number; payment_intent: string | null; created: number; metadata: { mark: string }; total?: number; amount_paid?: number; from_balance?: number };
type BalanceTxn = { id: string; object: "customer_balance_transaction"; customer: string; amount: number; currency: "usd"; type: string; metadata: Record<string, string> | null };
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
/** The customer's credit balance, in cents (negative is credit, as Stripe keeps it), and its history. */
let customerBalance = 0;
let balanceTxns: BalanceTxn[] = [];
/** A credit to the balance is made and its answer lost. */
let creditAnswerLost = false;
/** The video service refuses to write captions. */
let transcribeRefused = false;
/** The languages the video service lists captions in for the video. */
let serviceCaptions: string[] = [];

class Died extends Error {}

/** Every `metadata[...]` field of a request, as Stripe keeps it; null when there is none. */
function metadataOf(body: URLSearchParams): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [name, value] of body) {
    const field = /^metadata\[(.+)\]$/.exec(name);
    if (field) out[field[1]] = value;
  }
  return Object.keys(out).length ? out : null;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (dead) throw new Died("the process is gone");
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    if (url.pathname.includes("/transcribe")) {
      transcribes.push(JSON.parse(String(init?.body)));
      if (transcribeRefused) return json({ success: false, statusCode: 400 }, 400);
      return json({ success: true, statusCode: 200 });
    }
    return json({ guid: VIDEO, status: 4, captions: serviceCaptions.map((lang) => ({ srclang: lang, label: lang })) });
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
  const history = /^\/customers\/([^/]+)\/balance_transactions$/.exec(path);
  if (history && method === "GET") return json({ object: "list", has_more: false, data: balanceTxns.filter((t) => t.customer === decodeURIComponent(history[1])).slice().reverse() });
  if (history && method === "POST") {
    const made: BalanceTxn = { id: `cbtxn_Captions${String(balanceTxns.length + 1).padStart(6, "0")}`, object: "customer_balance_transaction", customer: decodeURIComponent(history[1]), amount: Number(body.get("amount")), currency: "usd", type: "adjustment", metadata: metadataOf(body) };
    balanceTxns.push(made);
    customerBalance += made.amount;
    if (creditAnswerLost) {
      if (key) replays.set(key, { status: 200, body: { ...made } });
      return json({ error: { type: "api_error", message: "the answer was lost" } }, 500);
    }
    return answer({ ...made });
  }
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
      // A credit balance that covers the whole invoice pays it when it is finalized, with no payment (Stripe's invoices).
      if (invoice.amount_due > 0 && -customerBalance >= invoice.amount_due) {
        customerBalance += invoice.amount_due;
        balanceTxns.push({ id: `cbtxn_Captions${String(balanceTxns.length + 1).padStart(6, "0")}`, object: "customer_balance_transaction", customer: invoice.customer, amount: invoice.amount_due, currency: "usd", type: "applied_to_invoice", metadata: null });
        invoice.total = invoice.amount_due;
        invoice.from_balance = invoice.amount_due;
        invoice.amount_due = 0;
        invoice.amount_paid = 0;
        invoice.status = "paid";
      }
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

/** The video is held by an order whose charge is not settled yet. */
const parseOrderKept = () => {
  const raw = redis.run(["GET", KEY]);
  return typeof raw === "string" && raw.includes('"order"');
};
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
  customerBalance = 0;
  balanceTxns = [];
  creditAnswerLost = false;
  transcribeRefused = false;
  serviceCaptions = [];
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

  part("The record's write after the charge lands, and its answer is lost (Claude 2 on #3286, finding 1)");
  reset();
  const realRun = redis.pipeline;
  /** The post-charge write: SET of the record with its payment, then its queue entry. */
  const isRecordWrite = (commands: unknown[][]) => commands.length === 2 && commands[0][0] === "SET" && commands[0][1] === KEY && String(commands[0][2]).includes('"pi"');
  redis.pipeline = async (commands) => {
    if (isRecordWrite(commands as unknown[][])) {
      await realRun(commands);
      return [] as unknown[];
    }
    return realRun(commands);
  };
  const landed = await ask(T);
  redis.pipeline = realRun;
  is("read back, the record holds this charge: the captions are asked for, once", [landed, paidCount(), transcribes.length], ["asked", 1, 1]);
  is("a retry is told they are being written, and charges nothing more", [await ask(T + 1_000), paidCount(), invoices.length], ["busy", 1, 1]);
  reset();
  redis.pipeline = async (commands) => (isRecordWrite(commands as unknown[][]) ? ([] as unknown[]) : realRun(commands));
  const lost = await ask(T);
  redis.pipeline = realRun;
  is("the write did not land: nothing asked of the service, the order still held", [lost, transcribes.length, parseOrderKept()], ["checking", 0, true]);
  advance(16 * 60_000);
  await syncAutoCaptions(VIDEO, T + 16 * 60_000);
  await syncAutoCaptions(VIDEO, T + 30 * 60_000);
  is("the order is settled from Stripe's invoice: refunded in full, once", [paidCount(), refunds.length, kept(), redis.run(["GET", KEY])], [1, 1, 0, null]);
  reset();
  redis.pipeline = async (commands) => {
    if (isRecordWrite(commands as unknown[][])) {
      await realRun(commands);
      return [] as unknown[];
    }
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === KEY) return [] as unknown[];
    return realRun(commands);
  };
  const unread = await ask(T);
  redis.pipeline = realRun;
  is("landed but the read-back is unknown too: nothing asked, kept for the sweep", [unread, transcribes.length, redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]) !== null], ["checking", 0, true]);

  part("An invoice paid wholly from the creator's credit balance (Claude 2 finding 2, Claude 6's MEDIUM on #3286)");
  reset();
  customerBalance = -50_000;
  const fromCredit = await ask(T);
  is("the credit paid it: the captions are asked for, once, and nothing is charged to the card", [fromCredit, transcribes.length, customerBalance, invoices.map((i) => [i.status, i.payment_intent])], ["asked", 1, -38_000, [["paid", null]]]);
  is("a retry charges nothing more", [await ask(T + 1_000), invoices.length, customerBalance], ["busy", 1, -38_000]);
  advance(49 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 49 * 3_600_000);
  is("nothing written after GIVE_UP_HOURS: the whole price goes back to the credit balance, once", [customerBalance, balanceTxns.filter((t) => t.amount < 0).length, redis.run(["GET", KEY])], [-50_000, 1, null]);
  is("and is marked with its own key", balanceTxns.filter((t) => t.amount < 0).map((t) => [t.amount, t.metadata?.nl_captions_credit?.startsWith(`nl-captions:${VIDEO}:`)]), [[-12_000, true]]);

  reset();
  customerBalance = -50_000;
  transcribeRefused = true;
  is("the video service refuses: given back to the credit, said as such", [await ask(T), customerBalance, redis.run(["GET", KEY])], ["credited", -50_000, null]);
  is("the creator is told where the money went", readFileSync("components/course-editor.tsx", "utf8").includes('auto_credited: "The video service would not write these captions, so the charge was returned to your account credit.'), true);

  reset();
  customerBalance = -50_000;
  transcribeRefused = true;
  creditAnswerLost = true;
  is("the credit back is made and its answer lost: kept as owed", [await ask(T), customerBalance], ["refund_pending", -50_000]);
  creditAnswerLost = false;
  advance(24 * 3_600_000 + 60_000);
  replays.clear();
  await syncAutoCaptions(VIDEO, T + 24 * 3_600_000 + 60_000);
  await syncAutoCaptions(VIDEO, T + 25 * 3_600_000);
  is("a look a day later reads the balance history and credits nothing twice", [customerBalance, balanceTxns.filter((t) => t.amount < 0).length, redis.run(["GET", KEY])], [-50_000, 1, null]);

  reset();
  customerBalance = -50_000;
  dieAt = "/pay";
  is("the process dies once the credit paid the invoice: kept, nothing asked", [await ask(T), redis.run(["GET", KEY]) !== null, customerBalance, transcribes.length], ["checking", true, -38_000, 0]);
  dieAt = "";
  dead = false;
  advance(16 * 60_000);
  await syncAutoCaptions(VIDEO, T + 16 * 60_000);
  await syncAutoCaptions(VIDEO, T + 30 * 60_000);
  await syncAutoCaptions(VIDEO, T + 60 * 60_000);
  is("the sweep finds the invoice paid from the credit and gives it back, once", [customerBalance, balanceTxns.filter((t) => t.amount < 0).length, redis.run(["GET", KEY])], [-50_000, 1, null]);
  is("asked again: used once more", [await ask(T + 61 * 60_000), customerBalance, transcribes.length], ["asked", -38_000, 1]);

  part("A claim whose write landed but cannot be read back is still queued (Claude 2 finding 4)");
  reset();
  redis.pipeline = async (commands) => {
    const c = commands as unknown[][];
    if (c.length === 1 && c[0][0] === "SET" && c[0][1] === KEY && c[0].includes("NX")) {
      await realRun(commands);
      return [] as unknown[];
    }
    if (c.length === 1 && c[0][0] === "GET" && c[0][1] === KEY) return [] as unknown[];
    return realRun(commands);
  };
  const claimLost = await ask(T);
  redis.pipeline = realRun;
  is("unknown claim: nothing charged, and the video queued so the order is settled", [claimLost, invoices.length, redis.run(["GET", KEY]) !== null, redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]) !== null], ["unavailable", 0, true, true]);
  advance(16 * 60_000);
  await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + 16 * 60_000);
  is("the sweep finds it and lets the unpaid order go", redis.run(["GET", KEY]), null);

  part("A slow settler of an old order never takes a newer order's queue entry (Claude 2 finding 3)");
  reset();
  dieAt = "GET /subscriptions/sub_Store000003";
  is("an old order, cut off before any invoice", await ask(T), "checking");
  dieAt = "";
  dead = false;
  advance(16 * 60_000);
  const at = T + 16 * 60_000;
  let raced = false;
  const listFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!raced && url.includes("/v1/invoices?")) {
      raced = true;
      // While the slow settler reads Stripe: a creator's retry settles the old order, then a new order is charged and its process dies.
      globalThis.fetch = listFetch;
      await ask(at);
      dieAfterPay = true;
      await ask(at + 1_000);
      dieAfterPay = false;
      dead = false;
    }
    return listFetch(input, init);
  }) as typeof fetch;
  await syncAutoCaptions(VIDEO, at);
  globalThis.fetch = listFetch;
  is("the new, paid order is still queued once the slow settler is done", [raced, paidCount(), redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]) !== null], [true, 1, true]);
  for (let minutes = 20; minutes <= 60; minutes += 5) await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + minutes * 60_000);
  is("and the sweep, which reads only the queue, refunds it in full, once", [paidCount(), refunds.length, kept()], [1, 1, 0]);

  part("A charge given back to the credit balance is given back once, whichever path gives it (Claude 6's HIGH on #3286)");
  reset();
  customerBalance = -50_000;
  transcribeRefused = true;
  const credits = () => balanceTxns.filter((t) => t.amount < 0);
  /** The record's DEL after a confirmed credit back does not land. */
  redis.pipeline = async (commands) => {
    const c = commands as unknown[][];
    if (c.length === 1 && c[0][0] === "DEL" && c[0][1] === KEY) return [] as unknown[];
    return realRun(commands);
  };
  const refusedOnce = await ask(T);
  redis.pipeline = realRun;
  is("the service refuses: credited once, the record left behind", [refusedOnce, customerBalance, credits().length, redis.run(["GET", KEY]) !== null], ["credited", -50_000, 1, true]);
  transcribeRefused = false;
  advance(50 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 50 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 51 * 3_600_000);
  is("past GIVE_UP_HOURS the record left behind is settled with nothing credited twice", [customerBalance, credits().length, redis.run(["GET", KEY])], [-50_000, 1, null]);

  reset();
  customerBalance = -50_000;
  transcribeRefused = true;
  creditAnswerLost = true;
  /** The write of what is owed does not land either. */
  redis.pipeline = async (commands) => {
    const c = commands as unknown[][];
    if (c[0]?.[0] === "SET" && c[0][1] === KEY && String(c[0][2]).includes('"owed"')) return [] as unknown[];
    return realRun(commands);
  };
  const twoFaults = await ask(T);
  redis.pipeline = realRun;
  creditAnswerLost = false;
  transcribeRefused = false;
  is("a credit whose answer was lost, and a write of what is owed that did not land", [twoFaults, customerBalance, credits().length], ["refund_pending", -50_000, 1]);
  advance(50 * 3_600_000);
  replays.clear();
  await syncAutoCaptions(VIDEO, T + 50 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 51 * 3_600_000);
  is("the sweep reads the credit already made for this invoice and credits nothing twice", [customerBalance, credits().length, redis.run(["GET", KEY])], [-50_000, 1, null]);

  reset();
  customerBalance = -50_000;
  is("paid from the credit, the captions asked for", await ask(T), "asked");
  const paidInvoice = invoices[0].id;
  // Half of it already went back to the credit balance, under another key (a path that has since been retried).
  balanceTxns.push({ id: "cbtxn_Earlier000001", object: "customer_balance_transaction", customer: "cus_Store000003", amount: -6_000, currency: "usd", type: "adjustment", metadata: { nl_captions_credit: `nl-captions:${VIDEO}:earlier:refund`, invoice: paidInvoice } });
  customerBalance -= 6_000;
  advance(50 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 50 * 3_600_000);
  is("what is owed is capped by what this invoice already got back: nothing more than the price", [customerBalance, credits().reduce((sum, t) => sum + t.amount, 0)], [-50_000, -12_000]);

  reset();
  customerBalance = -50_000;
  transcribeRefused = true;
  // A row carrying the captions mark whose invoice cannot be read: what was given back is unknown.
  balanceTxns.push({ id: "cbtxn_Unread000001", object: "customer_balance_transaction", customer: "cus_Store000003", amount: -12_000, currency: "usd", type: "adjustment", metadata: { nl_captions_credit: `nl-captions:${VIDEO}:other:refund` } });
  is("a history row that does not read exactly: nothing credited, kept as owed", [await ask(T), credits().length], ["refund_pending", 1]);

  part("A sweep that finds the video free never unqueues a newer order taken meanwhile (Claude 2 N1 on #3286)");
  reset();
  redis.run(["ZADD", "nl:stream:autoq", T, VIDEO]);
  let between = false;
  redis.pipeline = async (commands) => {
    const c = commands as unknown[][];
    const reply = await realRun(commands);
    if (!between && c.length === 1 && c[0][0] === "GET" && c[0][1] === KEY && reply[0] === null) {
      between = true;
      // Between the sweep's read (nothing there) and its unqueue: a new order is charged, and its process dies.
      dieAfterPay = true;
      await ask(T);
      dieAfterPay = false;
      dead = false;
    }
    return reply;
  };
  await syncAutoCaptions(VIDEO, T);
  redis.pipeline = realRun;
  is("the new, paid order stays queued", [between, paidCount(), redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]) !== null], [true, 1, true]);
  for (let minutes = 20; minutes <= 60; minutes += 5) await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + minutes * 60_000);
  is("and the sweep refunds it in full, once", [paidCount(), refunds.length, kept()], [1, 1, 0]);
  reset();
  redis.run(["ZADD", "nl:stream:autoq", T, VIDEO]);
  is("a video with nothing there is still taken out of the queue", [await syncAutoCaptions(VIDEO, T), redis.run(["ZSCORE", "nl:stream:autoq", VIDEO])], ["none", null]);

  part("A language delivered stays delivered, even once its captions are taken off (R47)");
  reset();
  is("charged by card and asked for", await ask(T), "asked");
  serviceCaptions = ["en"];
  await syncAutoCaptions(VIDEO, T + 5 * 60_000);
  is("English arrives and is listed", (JSON.parse(String(redis.run(["GET", KEY]))) as { got: string[] }).got, ["en"]);
  // The creator takes the English captions off; Spanish never comes.
  serviceCaptions = [];
  advance(50 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 50 * 3_600_000);
  is("past GIVE_UP_HOURS only the language never delivered is refunded", [refunds.map((r) => r.amount), kept(), redis.run(["GET", KEY])], [[PRICE / 2], PRICE / 2, null]);
  reset();
  customerBalance = -50_000;
  is("paid from the credit and asked for", await ask(T), "asked");
  serviceCaptions = ["en"];
  await syncAutoCaptions(VIDEO, T + 5 * 60_000);
  serviceCaptions = [];
  advance(50 * 3_600_000);
  await syncAutoCaptions(VIDEO, T + 50 * 3_600_000);
  is("the same on the credit: only the language never delivered goes back", [customerBalance, credits().map((t) => t.amount)], [-44_000, [-6_000]]);
  reset();
  is("asked for", await ask(T), "asked");
  serviceCaptions = ["en"];
  await syncAutoCaptions(VIDEO, T + 5 * 60_000);
  serviceCaptions = ["es"];
  await syncAutoCaptions(VIDEO, T + 15 * 60_000);
  is("each language delivered once, at a different look: all of it delivered, nothing refunded", [refunds.length, kept(), redis.run(["GET", KEY])], [0, PRICE, null]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
