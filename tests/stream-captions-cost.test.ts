/**
 * What the studio's captions route costs at its worst, and the bound on the
 * looks the video service's announcements take (Claude 7 and Claude 5 on
 * #3427, MEDIUM 1: a call out and Redis commands with no measured line, and
 * the announcements' looks "not certified, never zero").
 *
 *   1. app/api/store/stream/captions/route.ts takes one "integration" unit
 *      (withinServiceWhy) and then runs `add`, `remove` or `auto`. Each is run
 *      here at its worst on the synthetic Redis, video service and Stripe of
 *      tests/auto-captions-own-captions.test.ts: every claim and the request's
 *      write answered in a shape that does not read (they landed, so they are
 *      read back), `auto` for three languages, the service listing them, a
 *      video's twelve caption languages listed. Commands are counted as Upstash
 *      bills them (a script is one, and one more for each call inside it), and
 *      so are the calls to the video service and to Stripe. The most of each,
 *      over every path, is what tests/plan-cost-registry.ts prices
 *      (STREAM_CAPTIONS_WORST), and the line integrations prices every unit of
 *      the figure at the dearer of a call out and a captions request.
 *      withOwnCaptions (the language held for a change by hand) and askedFree
 *      (the holds read, the service's own list read) are each seen in the
 *      commands and calls counted.
 *   2. app/api/stream/hook: however many announcements the service sends for a
 *      video, a request being written is looked at no more than
 *      AUTO_CAPTIONS_HOOK_LOOKS times (lib/auto-captions.ts HOOK_LOOKS_MAX),
 *      each counted in its record before the service is asked; an order or a
 *      refund owed is never looked at on an announcement (no Stripe call), and
 *      the five-minute job still looks on its own schedule.
 *
 * Synthetic data only: no real video service, Stripe or Redis.
 */
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as hook } from "@/app/api/stream/hook/route";
import { HOOK_LOOKS_MAX, requestAutoCaptions, sweepAutoCaptions } from "@/lib/auto-captions";
import { withinEssentialLimit } from "@/lib/request-guard";
import { addStoreCaption, dropStoreCaption } from "@/lib/store-caption";
import { streamPath } from "@/lib/stream-rules";
import { storeFolder, type Store } from "@/lib/store";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import {
  AUTO_CAPTIONS_HOOK_COUNT_COMMANDS,
  AUTO_CAPTIONS_HOOK_LOOKS,
  AUTO_CAPTIONS_LOOK_COMMANDS,
  COST_LINES,
  INTEGRATION_WORST_USD,
  PAYPAL_PRESS,
  PAYPAL_PRESSES_UNTAKEN,
  STREAM_CAPTIONS_REQUEST_USD,
  STREAM_CAPTIONS_WORST,
  UNIT_COST,
  streamCaptionsCost,
} from "./plan-cost-registry";
import { readFileSync } from "node:fs";

const VIDEO = "5f8d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e";
const EMAIL = "captions-cost@example.com";
const KEY = `nl:stream:auto:${VIDEO}`;
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHola.\n";
const LIBRARY = "12345";
const READ_KEY = "bunny-read-key-only-a-stand-in";
/** Nine languages the video already has captions in, so three asked for make the twelve a video holds at the most. */
const LISTED = ["pt", "it", "nl", "pl", "sv", "da", "no", "fi", "cs"];
const HOUR = 3_600_000;

/** How the video service answers. */
let transcribe: "ok" | "refused" = "ok";
let lookStatus = 200;
let serviceLists: string[] = [];
/** How Stripe answers. */
let pay: "ok" | "declined" | "error" = "ok";
let refundOk = true;
let noDefault = false;
let invoices: Record<string, unknown>[] = [];
/** Calls seen: the video service's (method and path) and Stripe's. */
const videoCalls: string[] = [];
let stripeCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    videoCalls.push(`${method} ${url.pathname.replace(/^\/library\/\d+/, "")}`);
    if (url.pathname.includes("/transcribe")) return transcribe === "ok" ? json({ success: true, statusCode: 200 }) : json({ success: false }, 400);
    if (/\/captions\/[a-z]{2}$/.test(url.pathname)) return json({ success: true, statusCode: 200 });
    if (lookStatus !== 200) return new Response("", { status: lookStatus });
    return json({ guid: VIDEO, status: 4, captions: serviceLists.map((srclang) => ({ srclang, label: srclang })) });
  }
  stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const body = new URLSearchParams(String(init?.body ?? ""));
  if (path.startsWith("/subscriptions/")) return json({ id: "sub_Store000007", default_payment_method: noDefault ? null : "pm_card_on_file" });
  if (path.startsWith("/customers/")) return json({ id: "cus_Store000007", invoice_settings: { default_payment_method: "pm_card_on_file" } });
  if (path === "/invoices" && method === "POST") {
    const made = { id: `in_Cost${String(invoices.length + 1).padStart(6, "0")}`, object: "invoice", customer: String(body.get("customer")), status: "draft", currency: "usd", amount_due: 0, payment_intent: null, created: 0, metadata: { mark: String(body.get("metadata[mark]")) } };
    invoices.push(made);
    return json(made);
  }
  if (path === "/invoices" && method === "GET") return json({ object: "list", has_more: false, data: invoices.slice().reverse() });
  if (path === "/invoiceitems") {
    const invoice = invoices.find((i) => i.id === body.get("invoice"));
    if (invoice) invoice.amount_due = Number(invoice.amount_due) + Number(body.get("amount"));
    return json({ id: "ii_Cost000001" });
  }
  const action = /^\/invoices\/([^/]+)\/(finalize|pay|void)$/.exec(path);
  if (action) {
    const invoice = invoices.find((i) => i.id === decodeURIComponent(action[1]));
    if (!invoice) return json({ error: { type: "invalid_request_error" } }, 404);
    if (action[2] === "pay" && pay === "declined") return json({ error: { type: "card_error", code: "card_declined" } }, 402);
    if (action[2] === "pay" && pay === "error") return json({ error: { type: "api_error" } }, 500);
    invoice.status = action[2] === "finalize" ? "open" : action[2] === "pay" ? "paid" : "void";
    if (action[2] === "pay") invoice.payment_intent = `pi_Cost${String(invoice.id).slice(-6)}`;
    return json({ ...invoice });
  }
  if (path.startsWith("/payment_intents/")) return json({ object: "payment_intent", id: path.split("/").pop(), currency: "usd", amount_received: Number(invoices[0]?.amount_due ?? 0) });
  if (path === "/refunds" && method === "GET") return json({ object: "list", has_more: false, data: [] });
  if (path === "/refunds" && method === "POST") {
    if (!refundOk) return json({ error: { type: "api_error" } }, 500);
    return json({ id: "re_Cost000001", object: "refund", payment_intent: body.get("payment_intent"), amount: Number(body.get("amount") || invoices[0]?.amount_due), currency: "usd", status: "succeeded" });
  }
  return json({});
}) as typeof fetch;

const store = { handle: "captions-cost", email: EMAIL, subscriptionActive: true, subscriptionId: "sub_Store000007", period: paidPeriod(), stripeCustomerId: "cus_Store000007" } as unknown as Store;
let PATH = "";

/** What one action sends to Redis, as Upstash bills it, and the bytes through the database both ways. */
type Seen = { commands: number; bytes: number; sent: string[]; video: string[]; stripe: number };
let seen: Seen = { commands: 0, bytes: 0, sent: [], video: [], stripe: 0 };
const pipeline = redis.pipeline.bind(redis);
/** Whether a claim, and the request's write, answer in a shape that does not read, though they landed. */
let readBack = true;
redis.pipeline = (async (commands: (string | number)[][]) => {
  for (const command of commands) {
    seen.commands += 1 + (command[0] === "EVAL" ? (String(command[1]).match(/redis\.call\(/g) ?? []).length : 0);
    seen.sent.push(`${command[0]} ${command[0] === "EVAL" ? String(command[3]) : String(command[1])}`);
  }
  const replies = await pipeline(commands);
  seen.bytes += Buffer.byteLength(JSON.stringify(commands)) + Buffer.byteLength(JSON.stringify(replies));
  const claim = commands.length === 1 && commands[0][0] === "SET" && commands[0].includes("NX");
  const write = commands.length === 2 && commands[0][0] === "SET" && String(commands[0][1]) === KEY && commands[1][0] === "ZADD";
  return readBack && (claim || write) ? commands.map(() => ({ unexpected: true })) : replies;
}) as typeof redis.pipeline;

function reset(listed: string[] = LISTED): void {
  redis.clear();
  transcribe = "ok";
  lookStatus = 200;
  serviceLists = [...listed];
  pay = "ok";
  refundOk = true;
  noDefault = false;
  invoices = [];
  readBack = true;
  redis.run(["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })]);
  if (listed.length) redis.run(["HSET", `nl:stream:cap:${VIDEO}`, ...listed.flatMap((lang) => [lang, lang])]);
}

/** Runs one action as the route does after its grant: the short window's count, then the action. */
async function measure(run: () => Promise<unknown>): Promise<{ out: unknown; seen: Seen }> {
  seen = { commands: 0, bytes: 0, sent: [], video: [], stripe: 0 };
  const v = videoCalls.length;
  const s = stripeCalls;
  const folder = await storeFolder(EMAIL);
  if (!(await withinEssentialLimit("stream-captions", folder, 600, 3600))) throw new Error("the short window refused");
  const out = await run();
  seen.video = videoCalls.slice(v);
  seen.stripe = stripeCalls - s;
  return { out, seen: { ...seen } };
}

type Worst = { commands: number; videoCalls: number; stripeCalls: number; bytes: number };
const worst = (all: Seen[]): Worst => ({
  commands: Math.max(...all.map((x) => x.commands)),
  videoCalls: Math.max(...all.map((x) => x.video.length)),
  stripeCalls: Math.max(...all.map((x) => x.stripe)),
  bytes: Math.max(...all.map((x) => x.bytes)),
});
const reason = (out: unknown) => ((out as { ok: boolean; reason?: string }).ok ? "ok" : (out as { reason: string }).reason);

/** The service's announcement about the video, signed the way its "Webhooks" page says. */
function announce(): Promise<Response> {
  const body = JSON.stringify({ VideoLibraryId: Number(LIBRARY), VideoGuid: VIDEO, Status: 9 });
  const signature = createHmac("sha256", READ_KEY).update(body, "utf8").digest("hex");
  return hook(new NextRequest("https://marktmorgen.com/api/stream/hook", {
    method: "POST",
    headers: { host: "marktmorgen.com", "content-length": String(Buffer.byteLength(body)), "x-bunnystream-signature-version": "v1", "x-bunnystream-signature-algorithm": "hmac-sha256", "x-bunnystream-signature": signature },
    body,
  }));
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_cost_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = LIBRARY;
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
  process.env.BUNNY_STREAM_READ_KEY = READ_KEY;
  PATH = streamPath(await storeFolder(EMAIL), "lesson000007", VIDEO);
  const asked = () => requestAutoCaptions(store, PATH, "en", ["es", "fr"]);
  const holdReads = ["en", "es", "fr"].map((lang) => `GET ${KEY}:own:${lang}`);

  part("The route's own figure in the registry is the one it runs");
  const route = readFileSync("app/api/store/stream/captions/route.ts", "utf8");
  const grant = route.indexOf('withinServiceWhy("stream-captions", folder, CHANGES_PER_HOUR, 3600, store)');
  is("one integration unit is taken, before any action", [grant > 0, route.split("withinServiceWhy(").length - 1, ["requestAutoCaptions(", "addStoreCaption(", "dropStoreCaption("].every((call) => route.indexOf(call) > grant)], [true, 1, true]);

  part("auto, three languages, at its worst on every path");
  const autos: [string, Seen][] = [];
  reset();
  const accepted = await measure(asked);
  autos.push(["accepted", accepted.seen]);
  is("accepted, charged", reason(accepted.out), "ok");
  is("askedFree: the three languages' holds read, and the service's own list read before it is asked to write", [holdReads.every((read) => accepted.seen.sent.includes(read)), accepted.seen.video], [true, [`GET /videos/${VIDEO}`, `POST /videos/${VIDEO}/transcribe`]]);
  reset();
  serviceLists = [...LISTED, "es", "fr"];
  const landed = await measure(asked);
  autos.push(["the service lists two of them", landed.seen]);
  is("refused, those it lists written down here, nothing charged", [reason(landed.out), redis.run(["HEXISTS", `nl:stream:cap:${VIDEO}`, "fr"]), landed.seen.stripe], ["language", 1, 0]);
  reset();
  transcribe = "refused";
  autos.push(["refused by the service, refunded", (await measure(asked)).seen]);
  reset();
  transcribe = "refused";
  refundOk = false;
  const owed = await measure(asked);
  autos.push(["refused by the service, the refund not confirmed", owed.seen]);
  is("the refund owed is kept", reason(owed.out), "refund_pending");
  for (const how of ["declined", "error"] as const) {
    reset();
    noDefault = true;
    pay = how;
    const charged = await measure(asked);
    autos.push([`the card ${how} after its invoice was made`, charged.seen]);
    is(`${how}: nothing kept, the video free`, [reason(charged.out) === (how === "declined" ? "declined" : "unavailable"), redis.run(["GET", KEY])], [true, null]);
  }
  reset();
  noDefault = true;
  autos.push(["accepted, the card read from the customer", (await measure(asked)).seen]);
  for (const status of ["open", "paid"]) {
    reset();
    redis.run(["SET", KEY, JSON.stringify({ order: "1.000000001", at: Date.now() - 16 * 60_000, cents: 18000, langs: ["en", "es", "fr"], path: PATH, customer: "cus_Store000007" })]);
    invoices.push({ id: "in_Cost000009", object: "invoice", customer: "cus_Store000007", status, currency: "usd", amount_due: 18000, payment_intent: status === "paid" ? "pi_Cost000009" : null, created: 0, metadata: { mark: `captions:${VIDEO}:1.000000001` } });
    autos.push([`held by an older order, its invoice ${status}`, (await measure(asked)).seen]);
  }
  for (const [name, one] of autos) console.log(`    ${name}: ${one.commands} commands, ${one.video.length} video, ${one.stripe} Stripe, ${one.bytes} bytes`);
  const auto = worst(autos.map(([, one]) => one));

  part("add and remove by hand, at their worst");
  const pendingOther = () => redis.run(["SET", KEY, JSON.stringify({ langs: ["en", "es"], got: [], at: Date.now(), cents: 12000, pi: "pi_Cost000001", path: PATH })]);
  const adds: Seen[] = [];
  const removes: Seen[] = [];
  for (const other of [false, true]) {
    reset([...LISTED, "en", "es"]);
    if (other) pendingOther();
    const added = await measure(() => addStoreCaption(store, PATH, "de", SRT));
    adds.push(added.seen);
    is(`added${other ? ", a request holding other languages" : ""}`, (added.out as { ok: boolean }).ok, true);
    reset([...LISTED, "de"]);
    if (other) pendingOther();
    const removed = await measure(() => dropStoreCaption(PATH, "de"));
    removes.push(removed.seen);
    is(`removed${other ? ", a request holding other languages" : ""}`, (removed.out as { ok: boolean }).ok, true);
  }
  is("withOwnCaptions: the language held (its claim read back), the request read, and the hold let go", [`SET ${KEY}:own:de`, `GET ${KEY}:own:de`, `GET ${KEY}`].every((step) => adds[1].sent.includes(step)) && adds[1].sent.some((step) => step.startsWith("EVAL ") && step.endsWith(`${KEY}:own:de`)), true);
  const add = worst(adds);
  const remove = worst(removes);
  console.log(`    add: ${add.commands} commands, ${add.videoCalls} video, ${add.bytes} bytes; remove: ${remove.commands} commands, ${remove.videoCalls} video, ${remove.bytes} bytes`);

  part("The registry prices exactly what was measured, over the integration unit it takes");
  const { guardCommands } = STREAM_CAPTIONS_WORST;
  const figure = (w: Worst) => ({ commands: w.commands - guardCommands, videoCalls: w.videoCalls, stripeCalls: w.stripeCalls });
  is("the short window's count", guardCommands, 2);
  is("add", figure(add), STREAM_CAPTIONS_WORST.add);
  is("remove", figure(remove), STREAM_CAPTIONS_WORST.remove);
  is("auto", figure(auto), STREAM_CAPTIONS_WORST.auto);
  is("bytes through the database, every action", Math.max(add.bytes, remove.bytes, auto.bytes) <= STREAM_CAPTIONS_WORST.dbBytes, true);
  is("none of them fits a call out's unit (ten commands and ten seconds): each is priced on its own", (["add", "remove", "auto"] as const).map((action) => streamCaptionsCost(action) > UNIT_COST.integration), [true, true, true]);
  is("a unit of the figure is priced at the dearest captions request", [INTEGRATION_WORST_USD, STREAM_CAPTIONS_REQUEST_USD >= Math.max(streamCaptionsCost("add"), streamCaptionsCost("remove"), streamCaptionsCost("auto"))], [STREAM_CAPTIONS_REQUEST_USD, true]);
  const line = COST_LINES.find((one) => one.id === "integrations")!;
  // Payday's PayPal auto-pay takes no unit and is added once at its most (tests/paypal-press-cost.test.ts).
  is("the line integrations: every unit of every plan's figure at that price, and payday's auto-pay", (["creator", "pro", "scale"] as const).map((tier) => Math.abs(line.monthlyUsd(tier) - (STORE_ALLOWANCES[tier].integration * STREAM_CAPTIONS_REQUEST_USD + PAYPAL_PRESSES_UNTAKEN * PAYPAL_PRESS)) < 1e-12), [true, true, true]);
  console.log(`    a captions request at its worst: $${STREAM_CAPTIONS_REQUEST_USD.toFixed(6)} (a call out's unit: $${UNIT_COST.integration.toFixed(6)})`);

  part("The service's announcements look at a request being written at most HOOK_LOOKS_MAX times");
  is("the bound in the code is the one priced", HOOK_LOOKS_MAX, AUTO_CAPTIONS_HOOK_LOOKS);
  reset([]);
  readBack = false;
  const T = Date.now();
  // A request charged, its answer from the service unknown (a 503): kept, and the service still answers nothing it can read.
  redis.run(["SET", KEY, JSON.stringify({ langs: ["en", "es"], got: [], at: T, cents: 12000, pi: "pi_Cost000001", path: PATH }), "EX", 7 * 86_400]);
  lookStatus = 503;
  const before = videoCalls.length;
  const answers: number[] = [];
  for (let n = 0; n < 50; n += 1) answers.push((await announce()).status);
  const looked = videoCalls.slice(before).filter((call) => call === `GET /videos/${VIDEO}`).length;
  is("fifty announcements, all answered", answers.every((status) => status === 200), true);
  is(`at most ${AUTO_CAPTIONS_HOOK_LOOKS} looks at the service, whatever it announces`, looked, AUTO_CAPTIONS_HOOK_LOOKS);
  const record = JSON.parse(String(redis.run(["GET", KEY]))) as { hooks?: number; langs: string[] };
  is("counted in the request's own record, which is kept", [record.hooks, record.langs], [AUTO_CAPTIONS_HOOK_LOOKS, ["en", "es"]]);
  is("its time to live kept, not moved by the count", (redis.run(["TTL", KEY]) as number) <= 7 * 86_400, true);
  const swept = videoCalls.length;
  await sweepAutoCaptions(Number.POSITIVE_INFINITY, T + HOUR);
  is("the five-minute job still looks on its own schedule", videoCalls.length - swept, 1);

  part("A look on an announcement: its count and its look within the priced commands");
  reset([]);
  readBack = false;
  lookStatus = 200;
  serviceLists = ["en"];
  redis.run(["SET", KEY, JSON.stringify({ langs: ["en", "es"], got: [], at: Date.now(), cents: 12000, pi: "pi_Cost000001", path: PATH }), "EX", 7 * 86_400]);
  const heard = await measure(async () => (await announce()).status);
  const syncCommands = heard.seen.sent.filter((step) => step.includes(KEY) || step.startsWith("ZADD nl:stream:autoq") || step.startsWith("HSET nl:stream:cap:"));
  console.log(`    an announcement's look, English delivered: ${syncCommands.join(", ")}`);
  const billed = syncCommands.reduce((sum, step) => sum + (step.startsWith("EVAL") ? 3 : 1), 0);
  is("English listed, Spanish still being written, the look counted", [redis.run(["HEXISTS", `nl:stream:cap:${VIDEO}`, "en"]), (JSON.parse(String(redis.run(["GET", KEY]))) as { got: string[]; hooks: number }).got, (JSON.parse(String(redis.run(["GET", KEY]))) as { hooks: number }).hooks], [1, ["en"], 1]);
  is("its commands within a look's and its count's", billed <= AUTO_CAPTIONS_LOOK_COMMANDS + AUTO_CAPTIONS_HOOK_COUNT_COMMANDS, true);

  part("An order or a refund owed is never looked at on an announcement: no call to Stripe or to the service");
  reset([]);
  readBack = false;
  redis.run(["SET", KEY, JSON.stringify({ order: "1.000000001", at: Date.now() - 16 * 60_000, cents: 12000, langs: ["en", "es"], path: PATH, customer: "cus_Store000007" })]);
  let calls = [videoCalls.length, stripeCalls];
  for (let n = 0; n < 10; n += 1) await announce();
  is("an order: nothing asked", [videoCalls.length - calls[0], stripeCalls - calls[1]], [0, 0]);
  reset([]);
  readBack = false;
  redis.run(["SET", KEY, JSON.stringify({ langs: ["en", "es"], got: [], at: Date.now() - 50 * HOUR, cents: 12000, pi: "pi_Cost000001", path: PATH, owed: { cents: null, key: "nl-captions:cost:refund", since: Date.now(), looks: 0 } })]);
  calls = [videoCalls.length, stripeCalls];
  for (let n = 0; n < 10; n += 1) await announce();
  is("a refund owed: nothing asked, its looks left to the schedule", [videoCalls.length - calls[0], stripeCalls - calls[1], (JSON.parse(String(redis.run(["GET", KEY]))) as { owed?: { looks: number } } | null)?.owed?.looks ?? "gone"], [0, 0, 0]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
