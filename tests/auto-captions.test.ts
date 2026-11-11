/**
 * Captions written by AI for a lesson's video (lib/auto-captions.ts, added 11
 * October 2026). What is checked:
 *
 *   - the price: since 18 October 2026 six dollars a minute for each
 *     language, minutes rounded up, never under $35, which keeps 60% at its
 *     dearest under the one receiving model (lib/receiving-costs.ts, held in
 *     tests/margin-alignment.test.ts), the card's fee included;
 *   - charged first, on an invoice of its own paid at once, and only then is
 *     the service asked; a declined card leaves nothing asked and nothing owed;
 *   - the service told the language spoken and those to translate into, and
 *     nothing else it charges for;
 *   - each language listed as it arrives; what never arrives refunded;
 *   - only languages the video has no captions in yet, one request at a time,
 *     only on a store with a plan; the request held by an order written
 *     before the charge (SET NX, lib/claim-mark.ts), and an answer about the
 *     payment that is not a payment settled from Stripe's own invoice
 *     (tests/auto-captions-charge-once.test.ts has the lost answers);
 *   - a refund counts only once Stripe confirms it (232 [CA1], 30 October
 *     2026): pending, failed, refused or unreadable refunds keep the record,
 *     are looked at again from Stripe's own list, are never asked for twice
 *     for the same money, stop after REFUND_LOOKS_MAX looks and are shown to
 *     the creator.
 */
import { autoCaptionCents, CENTS_PER_MINUTE, GIVE_UP_HOURS, MIN_CENTS, readAutoAsk } from "@/lib/auto-captions-rules";
import { autoRefundsOwed, autoWriting, REFUND_LOOKS_MAX, requestAutoCaptions, syncAutoCaptions } from "@/lib/auto-captions";
import { streamCaptions } from "@/lib/stream";
import { streamPath } from "@/lib/stream-rules";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const VIDEO = "0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const PATH = streamPath("a".repeat(32), "lesson000001", VIDEO);
let stripe: { path: string; body: URLSearchParams }[] = [];
const bunny: { method: string; path: string; body: unknown }[] = [];
let declineCard = false;
let paidReceipt: unknown = undefined;
let serviceRefuses = false;
let delivered: string[] = [];
/** The fake Stripe's refunds, as its list would show them, and how it answers the next refund asked for. */
type FakeRefund = { id: string; object: "refund"; amount: number; currency: string; payment_intent: string; status: string };
let refunds: FakeRefund[] = [];
const replays = new Map<string, FakeRefund>();
let refundAnswer: "succeeded" | "pending" | "failed" | "error" = "succeeded";
let listAnswer: "ok" | "error" | "more" = "ok";
const CHARGED = 12000;
/** What the card paid on the captions invoice (less than the price when a credit balance paid part). */
let cardPaid = CHARGED;
const FOLDER = "a".repeat(32);
/** The captions invoice as Stripe keeps it, for its list (the one invoice id the fake makes). */
let invoiceState: { status: string; mark: string; customer: string } | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "video.bunnycdn.com") {
    const path = url.pathname.replace(/^\/library\/\d+/, "") + url.search;
    bunny.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.includes("/transcribe")) return serviceRefuses ? json({ success: false, message: "no", statusCode: 400 }, 400) : json({ success: true, statusCode: 200 });
    return json({ guid: VIDEO, status: 4, captions: delivered.map((srclang) => ({ srclang, label: srclang })) });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const body = new URLSearchParams(String(init?.body ?? ""));
  stripe.push({ path: `${method} ${path}`, body });
  if (path.startsWith("/subscriptions/")) return json({ id: "sub_Store000001", default_payment_method: "pm_card_on_file" });
  if (path === "/invoices" && method === "GET") {
    const data = invoiceState && invoiceState.customer === url.searchParams.get("customer")
      ? [{ object: "invoice", id: "in_Captions00001", customer: invoiceState.customer, currency: "usd", status: invoiceState.status, payment_intent: invoiceState.status === "paid" ? "pi_Captions000001" : null, metadata: { mark: invoiceState.mark } }]
      : [];
    return json({ object: "list", has_more: false, data });
  }
  if (path === "/invoices") {
    invoiceState = { status: "draft", mark: String(body.get("metadata[mark]")), customer: String(body.get("customer")) };
    return json({ id: "in_Captions00001", status: "draft" });
  }
  if (path === "/invoiceitems") return json({ id: "ii_Captions0001" });
  if (path.endsWith("/finalize")) {
    if (invoiceState) invoiceState.status = "open";
    return json({ id: "in_Captions00001", status: "open" });
  }
  if (path.endsWith("/pay")) {
    if (declineCard) return json({ error: { code: "card_declined", message: "Your card was declined." } }, 402);
    // An answer that is not a payment: the invoice stays open, as Stripe keeps it.
    if (paidReceipt !== undefined) return json(paidReceipt);
    if (invoiceState) invoiceState.status = "paid";
    return json({ id: "in_Captions00001", status: "paid", payment_intent: "pi_Captions000001" });
  }
  if (path.endsWith("/void")) {
    if (invoiceState?.status === "paid") return json({ error: { code: "invoice_not_voidable", message: "paid" } }, 400);
    if (invoiceState) invoiceState.status = "void";
    return json({ id: "in_Captions00001", status: "void" });
  }
  if (path.startsWith("/payment_intents/") && method === "GET") {
    if (listAnswer === "error") return json({ error: { type: "api_error", message: "down" } }, 500);
    return json({ object: "payment_intent", id: decodeURIComponent(path.slice("/payment_intents/".length)), currency: "usd", amount_received: cardPaid });
  }
  if (path === "/refunds" && method === "GET") {
    if (listAnswer === "error") return json({ error: { type: "api_error", message: "down" } }, 500);
    const intent = url.searchParams.get("payment_intent");
    return json({ object: "list", has_more: listAnswer === "more", data: refunds.filter((r) => r.payment_intent === intent).slice().reverse() });
  }
  if (path === "/refunds") {
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? "";
    // Stripe replays the first answer to a key it has seen.
    const seen = replays.get(key);
    if (seen) return seen.status === "error" ? json({ error: { type: "api_error", message: "down" } }, 500) : json(seen);
    if (refundAnswer === "error") {
      // Stripe saves a 500 under its key and replays it.
      replays.set(key, { id: "", object: "refund", amount: 0, currency: "usd", payment_intent: "", status: "error" });
      return json({ error: { type: "api_error", message: "down" } }, 500);
    }
    // Without an amount Stripe refunds whatever is left of the payment.
    const left = cardPaid - refunds.filter((r) => r.status === "succeeded" || r.status === "pending").reduce((sum, r) => sum + r.amount, 0);
    const asked = body.has("amount") ? Number(body.get("amount")) : left;
    if (asked <= 0 || asked > left) return json({ error: { type: "invalid_request_error", code: "amount_too_large", message: "too much" } }, 400);
    const made: FakeRefund = { id: `re_Refund${String(refunds.length + 1).padStart(6, "0")}`, object: "refund", amount: asked, currency: "usd", payment_intent: String(body.get("payment_intent")), status: refundAnswer };
    refunds.push(made);
    replays.set(key, { ...made });
    return json(made);
  }
  return json({});
}) as typeof fetch;

const store = {
  handle: "chef",
  subscriptionActive: true,
  subscriptionId: "sub_Store000001", period: paidPeriod(),
  stripeCustomerId: "cus_Store000001",
} as unknown as Store;

const stripePaths = () => stripe.map((s) => s.path);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_captions_only_a_stand_in";
  process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
  process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
  process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";

  part("The price");
  is("six dollars a minute for each language, minutes rounded up", [autoCaptionCents(600, 1), autoCaptionCents(601, 2), autoCaptionCents(90 * 60, 3)], [6000, 13200, 162000]);
  is("never under the minimum; nothing for a video with no length", [autoCaptionCents(30, 1), autoCaptionCents(0, 1)], [MIN_CENTS, 0]);
  // At its dearest: ten cents a language, a dime more if the spoken one is counted apart, and the card's 2.9% and 30 cents.
  const worst = (minutes: number, languages: number) => minutes * (languages + 1) * 10 + autoCaptionCents(minutes * 60, languages) * 0.029 + 30;
  is("it pays for itself at its dearest, at every length from one minute to four hours, one language or three", Array.from({ length: 240 }, (_, i) => i + 1).every((m) => [1, 2, 3].every((n) => autoCaptionCents(m * 60, n) > worst(m, n))), true);
  is("languages: the spoken one first, each once, three at most, none it cannot do", [
    readAutoAsk("en", ["es", "en", "xx"])?.languages,
    readAutoAsk("en", ["es", "fr", "de"]),
    readAutoAsk("klingon", []),
  ], [["en", "es"], null, null]);
  is("the rate the page and the terms say", [CENTS_PER_MINUTE, MIN_CENTS], [600, 3500]);

  // A video the service has finished, ten minutes long.
  await redis.pipeline([["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })]]);

  part("Only a confirmed single claim can authorize a charge");
  const realPipeline = redis.pipeline;
  const pending = `nl:stream:auto:${VIDEO}`;
  const orderHeld = () => typeof (JSON.parse(String(redis.run(["GET", pending]) ?? "null")) as { order?: unknown } | null)?.order === "string";
  try {
    for (const receipt of [[], ["OK", "extra"], [undefined], [false], [0], [1], [true], ["ok"], [{}], "OK", null]) {
      redis.run(["DEL", pending]);
      stripe = [];
      bunny.length = 0;
      let claims = 0;
      // The claim's answer, and the read-back of it (lib/claim-mark.ts), are both in an unknown shape.
      redis.pipeline = async (commands) => {
        if (commands.length === 1 && (commands[0][0] === "SET" || commands[0][0] === "GET") && commands[0][1] === pending) {
          if (commands[0][0] === "SET") claims += 1;
          await realPipeline(commands);
          return receipt as unknown as unknown[];
        }
        return realPipeline(commands);
      };
      const answer = await requestAutoCaptions(store, PATH, "en", ["es"]);
      is(`unconfirmed claim ${JSON.stringify(receipt)} refuses without charge, provider request, retry or cleanup`,
        [answer, stripe.length, bunny.length, claims, orderHeld()],
        // A read-back holding another string is somebody else's claim: busy, not unknown; refused either way.
        [{ ok: false, reason: JSON.stringify(receipt) === '["ok"]' ? "busy" : "unavailable" }, 0, 0, 1, true]);
    }
    // The claim's answer in an unknown shape, and its read-back showing this request's own order: the claim is ours.
    redis.run(["DEL", pending]);
    stripe = [];
    bunny.length = 0;
    redis.pipeline = async (commands) => {
      if (commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === pending) {
        await realPipeline(commands);
        return [undefined] as unknown[];
      }
      return realPipeline(commands);
    };
    const readBack = await requestAutoCaptions(store, PATH, "en", ["es"]);
    is("a claim read back as this request's own order: charged once, and asked for", [readBack.ok, stripePaths().filter((p) => p.endsWith("/pay")).length, bunny.filter((b) => b.path.includes("/transcribe")).length], [true, 1, 1]);
  } finally {
    redis.pipeline = realPipeline;
    redis.run(["DEL", pending]);
  }

  part("An unconfirmed payment never starts supplier work");
  try {
    for (const receipt of [
      null, [], {}, { payment_intent: "pi_Captions000001" },
      { status: "open", payment_intent: "pi_Captions000001" },
      { status: "paid" }, { status: "paid", payment_intent: null },
      { status: "paid", payment_intent: "" }, { status: "paid", payment_intent: false },
      { status: "paid", payment_intent: 1 }, { status: "paid", payment_intent: {} },
    ]) {
      stripe = [];
      bunny.length = 0;
      paidReceipt = receipt;
      const answer = await requestAutoCaptions(store, PATH, "en", ["es"]);
      // The one call to the service is the free read of the video's caption list before the charge (askedFree,
      // Claude 2's MEDIUM on #3427): no work is asked of it.
      is("unknown payment " + JSON.stringify(receipt) + " closes supplier admission",
        [answer.ok, bunny.map((b) => `${b.method} ${b.path}`), stripePaths().filter((p) => p.endsWith("/pay")).length,
          stripePaths().filter((p) => p.endsWith("/void")).length, redis.run(["GET", pending])],
        [false, [`GET /videos/${VIDEO}`], 1, 1, null]);
    }
  } finally {
    paidReceipt = undefined;
    stripe = [];
    bunny.length = 0;
  }

  part("Charged first, then asked for");
  declineCard = true;
  const declined = await requestAutoCaptions(store, PATH, "en", ["es"]);
  is("a declined card: nothing asked of the service, and the invoice voided", [declined.ok ? "asked" : declined.reason, bunny.some((b) => b.path.includes("/transcribe")), stripePaths().some((p) => p.endsWith("/void"))], ["declined", false, true]);
  declineCard = false;
  stripe = [];
  const asked = await requestAutoCaptions(store, PATH, "en", ["es"]);
  const item = stripe.find((s) => s.path === "POST /invoiceitems")!;
  const invoice = stripe.find((s) => s.path === "POST /invoices")!;
  is("charged the price shown, on its own invoice, paid at once, before the service is asked", [
    asked.ok && asked.cents,
    item.body.get("amount"),
    invoice.body.get("pending_invoice_items_behavior"),
    invoice.body.get("default_payment_method"),
    stripePaths().filter((p) => p.endsWith("/finalize") || p.endsWith("/pay")).length,
  ], [12000, "12000", "exclude", "pm_card_on_file", 2]);
  const transcribe = bunny.find((b) => b.path.includes("/transcribe"))!;
  is("the service told the language spoken and the one to translate into, and nothing else it charges for", transcribe.body, {
    sourceLanguage: "en",
    targetLanguages: ["en", "es"],
    generateTitle: false,
    generateDescription: false,
    generateChapters: false,
    generateMoments: false,
  });
  is("the studio shows them as being written", (await autoWriting([PATH]))[PATH], ["en", "es"]);
  is("one request at a time", (await requestAutoCaptions(store, PATH, "fr", [])).ok ? "asked" : "refused", "refused");

  part("Listed as they arrive; what never does, refunded");
  delivered = ["en"];
  is("English first: listed, Spanish still on its way", [await syncAutoCaptions(VIDEO), (await streamCaptions([PATH]))[PATH]?.map((t) => t.lang), (await autoWriting([PATH]))[PATH]], ["waiting", ["en"], ["es"]]);
  stripe = [];
  const late = Date.now() + (GIVE_UP_HOURS + 1) * 3_600_000;
  is("Spanish never came: half refunded, and nothing more is waited for", [await syncAutoCaptions(VIDEO, late), stripe.find((s) => s.path === "POST /refunds")?.body.get("amount"), stripe.find((s) => s.path === "POST /refunds")?.body.get("payment_intent"), (await autoWriting([PATH]))[PATH]], ["done", "6000", "pi_Captions000001", undefined]);

  part("Only where it should");
  is("not again in a language it has", (await requestAutoCaptions(store, PATH, "en", [])).ok ? "asked" : "refused", "refused");
  is("not on a store with no plan", (await requestAutoCaptions({ ...store, subscriptionActive: false } as Store, PATH, "fr", [])).ok ? "asked" : "refused", "refused");
  serviceRefuses = true;
  stripe = [];
  const refused = await requestAutoCaptions(store, PATH, "fr", []);
  is("the service refusing: refunded in full at once", [refused.ok ? "asked" : refused.reason, stripe.filter((s) => s.path === "POST /refunds").length, stripe.find((s) => s.path === "POST /refunds")?.body.has("amount")], ["refunded", 1, false]);
  serviceRefuses = false;
  await redis.pipeline([["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "x", type: "", bytes: 1, state: "working", at: Date.now(), seconds: 0, width: 0, height: 0, settled: false })]]);
  is("not before the video is ready", (await requestAutoCaptions(store, PATH, "fr", [])).ok ? "asked" : "refused", "refused");

  part("A refund counts only once Stripe confirms it");
  const owedKey = `nl:stream:auto:${VIDEO}`;
  const queued = () => redis.run(["ZSCORE", "nl:stream:autoq", VIDEO]);
  const posts = () => stripe.filter((s) => s.path === "POST /refunds").length;
  const succeededCents = () => refunds.filter((r) => r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0);
  const asOwed = async (got: string[]) => {
    refunds = [];
    replays.clear();
    stripe = [];
    redis.run(["SET", owedKey, JSON.stringify({ langs: ["en", "es"], got, at: 1_000, cents: CHARGED, pi: "pi_Captions000001", path: PATH }), "EX", 3600]);
  };
  const lateNow = Date.now() + (GIVE_UP_HOURS + 1) * 3_600_000;

  // 1. Pending: the record stays, nothing is asked twice, and it ends when Stripe lists it succeeded.
  delivered = ["en"];
  await asOwed(["en"]);
  refundAnswer = "pending";
  is("a pending refund: still waiting, the record kept with what is owed, looked at again", [await syncAutoCaptions(VIDEO, lateNow), JSON.parse(String(redis.run(["GET", owedKey]))).owed?.cents, queued() !== null], ["waiting", 6000, true]);
  is("not shown as being written; shown to the creator as a refund not confirmed", [(await autoWriting([PATH]))[PATH], (await autoRefundsOwed(FOLDER)).map((r) => ({ cents: r.cents, stuck: r.stuck }))[0]], [undefined, { cents: 6000, stuck: false }]);
  is("a look while Stripe lists it pending asks for nothing new", [await syncAutoCaptions(VIDEO, lateNow + 1), posts()], ["waiting", 1]);
  refunds[0].status = "succeeded";
  is("listed succeeded: done, the record gone, one refund of 6000 in all", [await syncAutoCaptions(VIDEO, lateNow + 2), redis.run(["GET", owedKey]), posts(), succeededCents()], ["done", null, 1, 6000]);

  // 2. Stripe errs and makes nothing: the next look finds none and asks again under the same key.
  await asOwed(["en"]);
  refundAnswer = "error";
  is("a refund request that errs keeps the record", [await syncAutoCaptions(VIDEO, lateNow), redis.run(["GET", owedKey]) !== null], ["waiting", true]);
  refundAnswer = "succeeded";
  is("while Stripe replays the saved 500 for the first key: still waiting, nothing refunded", [await syncAutoCaptions(VIDEO, lateNow + 1), succeededCents(), redis.run(["GET", owedKey]) !== null], ["waiting", 0, true]);
  replays.clear(); // Stripe drops the key after about a day; the list is still empty, so the same key is safe.
  const firstKeyed = stripe.filter((s) => s.path === "POST /refunds").length;
  is("once the key is dropped: asked again for exactly what is owed, and done", [await syncAutoCaptions(VIDEO, lateNow + 2), posts() - firstKeyed, succeededCents(), redis.run(["GET", owedKey])], ["done", 1, 6000, null]);

  // 3. A refund that failed: a new one for what is left, under a new key; never more than owed.
  await asOwed(["en"]);
  refundAnswer = "failed";
  is("a failed refund keeps the record", await syncAutoCaptions(VIDEO, lateNow), "waiting");
  refundAnswer = "succeeded";
  is("after a failed one: asked again, done, 6000 returned in all", [await syncAutoCaptions(VIDEO, lateNow + 1), succeededCents(), refunds.length], ["done", 6000, 2]);

  // 4. Two looks at once ask for one refund.
  await asOwed(["en"]);
  refundAnswer = "error";
  await syncAutoCaptions(VIDEO, lateNow);
  refundAnswer = "succeeded";
  replays.clear();
  await Promise.all([syncAutoCaptions(VIDEO, lateNow + 1), syncAutoCaptions(VIDEO, lateNow + 1)]);
  is("two looks at once: one refund made, 6000 returned", [refunds.length, succeededCents()], [1, 6000]);

  // 5. Stripe's list cannot be read whole: nothing new is asked for; after REFUND_LOOKS_MAX looks it stops and says so.
  await asOwed(["en"]);
  refundAnswer = "pending";
  await syncAutoCaptions(VIDEO, lateNow);
  for (const answer of ["error", "more"] as const) {
    listAnswer = answer;
    const before = posts();
    is(`an unreadable list (${answer}) asks for no refund`, [await syncAutoCaptions(VIDEO, lateNow + 1), posts() - before], ["waiting", 0]);
  }
  listAnswer = "error";
  for (let i = 0; i < REFUND_LOOKS_MAX; i += 1) await syncAutoCaptions(VIDEO, lateNow + 2 + i);
  const stuckBefore = stripe.length;
  is("after every look: kept, marked stuck, out of the queue, shown as stuck, and no more calls", [redis.run(["GET", owedKey]) !== null, queued(), (await autoRefundsOwed(FOLDER)).map((r) => ({ cents: r.cents, stuck: r.stuck }))[0], await syncAutoCaptions(VIDEO, lateNow + 999), stripe.length - stuckBefore], [true, null, { cents: 6000, stuck: true }, "waiting", 0]);
  listAnswer = "ok";

  // 6. An owed record that cannot be read is never refunded by guesswork.
  refunds = [];
  replays.clear();
  stripe = [];
  redis.run(["SET", owedKey, JSON.stringify({ langs: ["en", "es"], got: ["en"], at: 1_000, cents: CHARGED, pi: "pi_Captions000001", path: PATH, owed: { cents: "x" } }), "EX", 3600]);
  is("an unreadable owed refund stops for a person, with no call to Stripe", [await syncAutoCaptions(VIDEO, lateNow), stripe.length, (await autoRefundsOwed(FOLDER)).map((r) => ({ cents: r.cents, stuck: r.stuck }))[0]?.stuck], ["waiting", 0, true]);

  // 7. The service refusing, and the refund not confirmed: kept as owed in full, and the video waits.
  redis.run(["DEL", owedKey]);
  await redis.pipeline([["SET", `nl:stream:v:${VIDEO}`, JSON.stringify({ id: VIDEO, path: PATH, name: "Knife skills.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 600, width: 1920, height: 1080, settled: true })]]);
  delivered = [];
  serviceRefuses = true;
  refundAnswer = "pending";
  stripe = [];
  const refusedPending = await requestAutoCaptions(store, PATH, "fr", []);
  const kept = JSON.parse(String(redis.run(["GET", owedKey])));
  is("refused and the refund pending: says so, kept owed in full, queued, shown", [refusedPending.ok ? "asked" : refusedPending.reason, kept.owed?.cents, queued() !== null, (await autoRefundsOwed(FOLDER)).map((r) => ({ cents: r.cents, stuck: r.stuck }))[0]], ["refund_pending", null, true, { cents: 6000, stuck: false }]);
  serviceRefuses = false;
  const charges = stripe.filter((s) => s.path.endsWith("/pay")).length;
  const again = await requestAutoCaptions(store, PATH, "fr", []);
  is("no new request is charged for that video while its refund is owed, and it says why", [again.ok ? "asked" : again.reason, stripe.filter((s) => s.path.endsWith("/pay")).length - charges], ["owed", 0]);
  refunds[0].status = "succeeded";
  is("once Stripe lists it succeeded: done, and no longer listed for the store", [await syncAutoCaptions(VIDEO, Date.now()), redis.run(["GET", owedKey]), await autoRefundsOwed(FOLDER)], ["done", null, []]);
  refundAnswer = "succeeded";

  // 8. A credit balance paid part of the invoice: never more than the card paid is asked back.
  await asOwed([]);
  cardPaid = 4000;
  refundAnswer = "failed";
  redis.run(["SET", owedKey, JSON.stringify({ langs: ["en", "es"], got: [], at: 1_000, cents: CHARGED, pi: "pi_Captions000001", path: PATH, owed: { cents: null, key: "k-credit", since: 1, looks: 0 } }), "EX", 3600]);
  refunds.push({ id: "re_Failed000001", object: "refund", amount: 4000, currency: "usd", payment_intent: "pi_Captions000001", status: "failed" });
  refundAnswer = "succeeded";
  is("the card paid 4000 of 12000: 4000 asked back, done", [await syncAutoCaptions(VIDEO, lateNow), stripe.find((s) => s.path === "POST /refunds")?.body.get("amount"), succeededCents(), redis.run(["GET", owedKey])], ["done", "4000", 4000, null]);
  // A partial refund owed above what the card paid, nothing listed: what the card paid, under a key of its own.
  await asOwed([]);
  cardPaid = 4000;
  redis.run(["SET", owedKey, JSON.stringify({ langs: ["en", "es"], got: ["en"], at: 1_000, cents: CHARGED, pi: "pi_Captions000001", path: PATH, owed: { cents: 6000, key: "k-capped", since: 1, looks: 0 } }), "EX", 3600]);
  replays.set("k-capped", { id: "", object: "refund", amount: 0, currency: "usd", payment_intent: "", status: "error" });
  is("capped at 4000 with a new key, never the first key's saved answer", [await syncAutoCaptions(VIDEO, lateNow), stripe.find((s) => s.path === "POST /refunds")?.body.get("amount"), succeededCents()], ["done", "4000", 4000]);
  cardPaid = CHARGED;

  // 9. A refund owed for a video since deleted is still shown for the store.
  redis.run(["SADD", `nl:stream:autoowed:${FOLDER}`, "1b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"]);
  redis.run(["SET", "nl:stream:auto:1b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d", JSON.stringify({ langs: ["en"], got: [], at: 1_000, cents: 3500, pi: "pi_Captions000002", path: streamPath(FOLDER, "lesson000002", "1b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d"), owed: { cents: null, key: "k-gone", since: 1, looks: 0 } }), "EX", 3600]);
  is("a deleted video's owed refund is listed for its store, and not for another", [await autoRefundsOwed(FOLDER), await autoRefundsOwed("b".repeat(32))], [[{ id: "1b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d", cents: 3500, stuck: false }], []]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
