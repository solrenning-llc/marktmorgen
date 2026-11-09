/**
 * A caption the creator adds by hand is never counted as delivered by the AI
 * (lib/auto-captions.ts, lib/store-caption.ts; Claude 5's second money review
 * of #3427, MEDIUM 1; rule 24):
 *
 *   - while an AI captions request holds a language (ordered, being written,
 *     or kept for a person), a caption in that language is not added by hand,
 *     so the sweep reads only what the service wrote, and what it never wrote
 *     is given back after GIVE_UP_HOURS, once;
 *   - a language the request does not hold, and any language once the
 *     request is settled, is added as before;
 *   - a change by hand in flight holds its language, so no request for it
 *     starts meanwhile, and a language the AI delivered stays delivered;
 *   - a read that does not say what holds the video refuses (rule 24).
 *
 * The fake video service lists every caption it holds, whoever sent it, as
 * the real one does; the fake Stripe keeps its invoices and replays an
 * idempotency key's first answer. Synthetic data only.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CourseEditor } from "@/components/course-editor";
import type { Course } from "@/lib/course";
import { requestAutoCaptions, sweepAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
import { addStoreCaption, dropStoreCaption } from "@/lib/store-caption";
import { streamPath } from "@/lib/stream-rules";
import { storeFolder, type Store } from "@/lib/store";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const VIDEO = "5f8d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e";
const EMAIL = "own-captions@example.com";
const KEY = `nl:stream:auto:${VIDEO}`;
const QUEUE = "nl:stream:autoq";
/** Ten minutes, English and Spanish. */
const PRICE = 12000;
const HOUR = 3_600_000;
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHola.\n";

type Invoice = { id: string; object: "invoice"; customer: string; status: string; currency: "usd"; amount_due: number; payment_intent: string | null; created: number; metadata: { mark: string } };
type Refund = { id: string; object: "refund"; amount: number; currency: "usd"; payment_intent: string; status: string };

/** How the video service answers a request to write captions. */
let reply: "ok" | "503" | "thrown" = "ok";
let invoices: Invoice[] = [];
let refunds: Refund[] = [];
let clock = 0;
const replays = new Map<string, { status: number; body: unknown }>();
/** The languages the service lists captions in for the video, whoever sent them. */
let delivered: string[] = [];
/** Captions sent by hand to the service, in order: "add es", "remove es". */
let byHand: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    if (url.pathname.includes("/transcribe")) {
      if (reply === "thrown") throw new TypeError("fetch failed");
      if (reply === "503") return new Response("", { status: 503 });
      return json({ success: true, statusCode: 200 });
    }
    const caption = /\/captions\/([a-z]{2})$/.exec(url.pathname);
    if (caption && method === "POST") {
      byHand.push(`add ${caption[1]}`);
      if (!delivered.includes(caption[1])) delivered.push(caption[1]);
      return json({ success: true, statusCode: 200 });
    }
    if (caption && method === "DELETE") {
      byHand.push(`remove ${caption[1]}`);
      delivered = delivered.filter((lang) => lang !== caption[1]);
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
  if (path.startsWith("/subscriptions/")) return json({ id: "sub_Store000005", default_payment_method: "pm_card_on_file" });
  if (path === "/invoices" && method === "POST") {
    const made: Invoice = { id: `in_OwnCap${String(invoices.length + 1).padStart(6, "0")}`, object: "invoice", customer: String(body.get("customer")), status: "draft", currency: "usd", amount_due: 0, payment_intent: null, created: clock, metadata: { mark: String(body.get("metadata[mark]")) } };
    invoices.push(made);
    return answer({ ...made });
  }
  if (path === "/invoices" && method === "GET") {
    const customer = url.searchParams.get("customer");
    return json({ object: "list", has_more: false, data: invoices.filter((i) => i.customer === customer).slice().reverse() });
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
      invoice.status = "paid";
      invoice.payment_intent = `pi_OwnCap${invoice.id.slice(-6)}`;
      return answer({ ...invoice });
    }
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
    const made: Refund = { id: `re_OwnCap${String(refunds.length + 1).padStart(6, "0")}`, object: "refund", amount: asked, currency: "usd", payment_intent: intent, status: "succeeded" };
    refunds.push(made);
    return answer({ ...made });
  }
  return json({});
}) as typeof fetch;

const store = {
  handle: "own-captions",
  email: EMAIL,
  subscriptionActive: true,
  subscriptionId: "sub_Store000005",
  period: paidPeriod(),
  stripeCustomerId: "cus_Store000005",
} as unknown as Store;

/** Card charges kept: paid by card, less what was refunded. */
const keptOnCard = () => invoices.filter((i) => i.status === "paid" && i.payment_intent).reduce((sum, i) => sum + i.amount_due, 0) - refunds.filter((r) => r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0);
const record = () => redis.run(["GET", KEY]);

let PATH = "";

function reset(): void {
  redis.clear();
  reply = "ok";
  invoices = [];
  refunds = [];
  replays.clear();
  delivered = [];
  byHand = [];
  hour = 0;
  redis.run(["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })]);
}

async function ask(at: number): Promise<string> {
  clock = Math.floor(at / 1000);
  const answer = await requestAutoCaptions(store, PATH, "en", ["es"], at);
  return answer.ok ? "asked" : answer.reason;
}

/** The hour after T the clock is at. */
let hour = 0;

/** Sweeps at each of these hours after T, the clock moved with them. */
async function sweepAt(T: number, hours: number[]): Promise<void> {
  for (const h of hours) {
    advance((h - hour) * HOUR);
    hour = h;
    await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + h * HOUR);
  }
}

const added = async (lang: string) => {
  const answer = await addStoreCaption(store, PATH, lang, SRT);
  return answer.ok ? "added" : answer.reason;
};
const removed = async (lang: string) => {
  const answer = await dropStoreCaption(PATH, lang);
  return answer.ok ? "removed" : answer.reason;
};
/** The languages held by a change by hand. */
const holds = () => ["en", "es", "fr"].filter((lang) => redis.run(["GET", `nl:stream:auto:${VIDEO}:own:${lang}`]) !== null);

function draw(writing: Record<string, string[]>): string {
  const lesson = { id: "lesson000005", title: "Knife skills", preview: false, video: { pathname: PATH, name: "Knife skills.mp4", bytes: 1, contentType: "video/mp4", addedAt: new Date(0).toISOString() }, files: [], link: null, hasBody: false, quiz: null };
  const course = { id: "course000005", title: "Knife course", modules: [{ id: "module000005", title: "Module 1", dripDays: 0, lessons: [lesson] }] } as unknown as Course;
  const props = { productId: "p1", initial: course, folder: "f", openFirst: lesson.id, streams: { [PATH]: "ready" }, captions: {}, writing, auto: { can: true, spoken: "en" }, held: [] };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, createElement(CourseEditor as never, props as never)));
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_own_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
  PATH = streamPath(await storeFolder(EMAIL), "lesson000005", VIDEO);
  const T = Date.now();

  for (const unknown of ["503", "thrown"] as const) {
    part(`The service's answer to the request is unknown (${unknown}); the creator then uploads their own Spanish`);
    reset();
    reply = unknown;
    is("asked, nothing given back", [await ask(T), refunds.length, keptOnCard()], ["asked", 0, PRICE]);
    reply = "ok";
    await sweepAt(T, [1, 3]);
    is("a caption by hand in a language the request holds is not sent to the service", [await added("es"), byHand, delivered], ["auto_writing", [], []]);
    await sweepAt(T, [24, 47, 49]);
    is("past GIVE_UP_HOURS, nothing written by the AI: refunded in full, once", [refunds.length, keptOnCard(), record()], [1, 0, null]);
    await sweepAt(T, [50]);
    is("never twice", [refunds.length, keptOnCard()], [1, 0]);
    is("settled: the creator's own Spanish is added", [await added("es"), delivered], ["added", ["es"]]);
  }

  part("The service accepts, and writes only English; the creator tries their own Spanish meanwhile");
  reset();
  is("asked", await ask(T), "asked");
  delivered = ["en"];
  await sweepAt(T, [1]);
  is("Spanish by hand is refused while the request holds it", [await added("es"), delivered], ["auto_writing", ["en"]]);
  await sweepAt(T, [49]);
  is("past GIVE_UP_HOURS: Spanish, never written by the AI, is given back, once", [refunds.length, keptOnCard(), record()], [1, PRICE / 2, null]);

  part("Control: a language the request does not hold is added at once, and changes nothing of the money");
  reset();
  is("asked", await ask(T), "asked");
  is("French by hand is added while English and Spanish are written", [await added("fr"), byHand], ["added", ["add fr"]]);
  delivered.push("en", "es");
  await sweepAt(T, [1]);
  is("both written by the AI: used, the whole price kept", [refunds.length, keptOnCard(), record()], [0, PRICE, null]);
  is("settled: the creator replaces the Spanish by hand", [await added("es"), refunds.length, keptOnCard()], ["added", 0, PRICE]);

  part("Removing by hand: refused in a language being written, allowed once it is delivered, and delivered stays delivered");
  reset();
  is("asked", await ask(T), "asked");
  is("Spanish, not written yet, is not removed by hand", [await removed("es"), byHand], ["auto_writing", []]);
  delivered = ["es"];
  await sweepAt(T, [1]);
  is("Spanish written by the AI is removed by hand", [await removed("es"), byHand, delivered], ["removed", ["remove es"], []]);
  delivered = ["en"];
  await sweepAt(T, [2]);
  is("both were written by the AI: used, the whole price kept, nothing given back for the Spanish removed", [refunds.length, keptOnCard(), record()], [0, PRICE, null]);

  part("A request kept for a person holds its languages, said apart");
  reset();
  is("asked", await ask(T), "asked");
  const kept = JSON.parse(String(record())) as Record<string, unknown>;
  redis.run(["SET", KEY, JSON.stringify({ ...kept, kept: T + 60 * 24 * HOUR })]);
  is("Spanish by hand: refused as held", [await added("es"), await removed("es"), byHand], ["auto_held", "auto_held", []]);
  is("French by hand: added", await added("fr"), "added");

  part("An order whose charge is not settled yet holds its languages");
  reset();
  redis.run(["SET", KEY, JSON.stringify({ order: "1.000000001", at: T, cents: PRICE, langs: ["en", "es"], path: PATH, customer: "cus_Store000005" })]);
  is("Spanish by hand: refused, nothing sent", [await added("es"), byHand], ["auto_writing", []]);
  is("French by hand: added", await added("fr"), "added");

  part("A change by hand in flight holds its language: no request for it starts, nothing charged");
  reset();
  redis.run(["SET", `nl:stream:auto:${VIDEO}:own:es`, "held", "EX", 120]);
  is("asked for English and Spanish: refused, nothing charged, the video free", [await ask(T), invoices.length, record()], ["unavailable", 0, null]);
  redis.run(["DEL", `nl:stream:auto:${VIDEO}:own:es`]);
  is("the hold gone: asked, charged once", [await ask(T + 1_000), invoices.length], ["asked", 1]);

  part("Spanish landed by hand between the request's first read and its order: never charged");
  reset();
  const pipeline = redis.pipeline.bind(redis);
  let landed = false;
  redis.pipeline = ((commands: (string | number)[][]) => {
    // Lands once the request has read the video's captions, before its order is written.
    if (!landed && commands[0]?.[0] === "SET" && String(commands[0]?.[1]) === KEY) {
      landed = true;
      redis.run(["HSET", `nl:stream:cap:${VIDEO}`, "es", "Español"]);
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const raced = await ask(T);
  redis.pipeline = pipeline;
  is("refused as a language it already has, nothing charged, the video free", [landed, raced, invoices.length, record()], [true, "language", 0, null]);

  part("A change by hand whose answer from the service is unknown keeps its hold until it runs out");
  reset();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (/\/captions\/es$/.test(new URL(String(input)).pathname) ? new Response("", { status: 503 }) : realFetch(input, init))) as typeof fetch;
  is("unavailable, and Spanish is still held", [await added("es"), holds().length], ["unavailable", 1]);
  globalThis.fetch = realFetch;
  is("a request for Spanish meanwhile: refused, nothing charged", [await ask(T), invoices.length], ["unavailable", 0]);
  advance(121_000);
  is("the hold run out: asked", [holds().length, await ask(T + 121_000)], [0, "asked"]);
  is("a change by hand with a known answer lets go of its hold", [await added("fr"), holds().length], ["added", 0]);

  part("A read that does not say what holds the video refuses, and sends nothing");
  reset();
  redis.run(["SET", KEY, "charging"]);
  is("a record in no known shape", [await added("es"), byHand, holds().length], ["unavailable", [], 0]);
  redis.run(["DEL", KEY]);
  redis.pipeline = ((commands: (string | number)[][]) => (commands[0]?.[0] === "GET" && String(commands[0]?.[1]) === KEY ? Promise.resolve([{ unexpected: true }]) : pipeline(commands))) as typeof redis.pipeline;
  const unread = await added("es");
  redis.pipeline = pipeline;
  is("a reply in another shape", [unread, byHand, holds().length], ["unavailable", [], 0]);
  redis.run(["SET", `nl:stream:auto:${VIDEO}:own:es`, "another", "EX", 120]);
  is("Spanish already held by another change by hand", [await added("es"), byHand], ["unavailable", []]);

  part("A look whose answer from the service is unknown changes nothing of what was delivered");
  reset();
  is("asked", await ask(T), "asked");
  delivered = ["es"];
  await sweepAt(T, [1]);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).hostname === "video.bunnycdn.com" ? new Response("", { status: 503 }) : realFetch(input, init))) as typeof fetch;
  advance(HOUR);
  is("an unknown look", await syncAutoCaptions(VIDEO, T + 2 * HOUR), "waiting");
  globalThis.fetch = realFetch;
  is("Spanish still delivered, English still being written", (JSON.parse(String(record())) as { got: string[] }).got, ["es"]);

  part("The studio does not offer a language being written for a caption by hand, and says so");
  const html = draw({ [PATH]: ["en", "es"] });
  is("English and Spanish not offered, French offered", [html.includes('<option value="en"'), html.includes('<option value="es"'), html.includes('<option value="fr"')], [false, false, true]);
  is("said in the status region", html.includes("Until then, captions in these languages can&#x27;t be uploaded here."), true);
  is("one language: said in the singular", draw({ [PATH]: ["es"] }).includes("captions in this language can&#x27;t be uploaded here."), true);
  is("control: nothing being written, every language offered", [draw({}).includes('<option value="en"'), draw({}).includes('<option value="es"')], [true, true]);

  part("Control: with no request for the video, a caption by hand is added as before");
  reset();
  is("added, sent once, its hold let go", [await added("es"), byHand, redis.run(["ZSCORE", QUEUE, VIDEO]), holds()], ["added", ["add es"], null, []]);
  is("removed, sent once", [await removed("es"), byHand, holds()], ["removed", ["add es", "remove es"], []]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
