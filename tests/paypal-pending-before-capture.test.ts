/**
 * A PayPal order is watched before PayPal is asked to take the payment, so a buyer charged always ends up handed what
 * they paid for (Claude 6's second money review of #3385, MEDIUM, probe A; rules 24 and 30).
 *
 * openOrder wrote only the order's record, and captureOrder put the order in pending only on its uncertain branches,
 * never on the COMPLETED one. When the step that writes the payment down did not reach Redis after PayPal had taken the
 * payment, nothing was written: the order was in no list, the sweep had nothing to resume, and only the buyer opening
 * the return page again recovered it. Now the order goes into pending first, the write read exactly; a write that is
 * not confirmed means PayPal is not asked to take anything. In the same step the order's record is renewed to thirty
 * days (Claude 3's first money review of #3404, LOW 1), so a capture asked for late in its first three days still
 * leaves the sweep a record to resume from; that renewal is read exactly too, and a record found gone asks PayPal
 * nothing. Its thirty days are counted from the order's opening, never from a later try (Claude 5's one rule for the
 * record's ceiling): renewed ten days after opening, it keeps twenty; past thirty from opening, PayPal is asked nothing.
 * PayPal is asked only with a day's room before that ceiling (Claude 5's second money review of #3411, MEDIUM): with
 * less, a ceiling passing before the renewal reaches Redis would end the record while Redis still answers 1, and a
 * payment taken and not written down would be left with no record for the sweep. An answer that comes back after the
 * ceiling, a payment PayPal may have taken, keeps the record a few hours for the sweep rather than letting it end.
 *
 * Synthetic only: a stand-in for PayPal's API and Resend, the in-memory Redis, the real return route and the real
 * sweep.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { handOverKey, openOrder, readPaid } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";
import { COMMAND, ORDER_COMPUTE, PAYPAL_CAPTURE_WATCH } from "./plan-cost-registry";
import * as paypalSales from "@/lib/paypal-sales";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
const captures = new Map<string, number>();
const receipts = new Map<string, number>();
let made = 0;
const orderId = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9088${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

/**
 * How PayPal answers the next capture: it takes the payment, it declines it, or the answer never comes back (nothing
 * taken); "lost-late": the answer never comes back and a minute passes meanwhile; "pending-late": PayPal holds the
 * payment as pending (an eCheck) and its answer comes back two days later; "pending": PayPal holds it as pending and
 * answers at once.
 */
let captureWith: "take" | "decline" | "lost" | "lost-late" | "pending-late" | "pending" = "take";
let buyerFor = "a@example.com";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    const body = String(init?.body ?? "");
    for (const [buyer, count] of receipts) if (body.includes(buyer)) receipts.set(buyer, count + 1);
    return json({ id: "e" });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    captures.set(capture, (captures.get(capture) ?? 0) + 1);
    if (captureWith === "decline") return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }, 422);
    if (captureWith === "lost") throw new Error("Synthetic: the capture's answer never came back");
    if (captureWith === "lost-late") {
      ahead += 60_000;
      throw new Error("Synthetic: the capture's answer never came back, a minute later");
    }
    const body = completed(capture, "49.00", buyerFor);
    if (captureWith === "pending-late" || captureWith === "pending") {
      if (captureWith === "pending-late") ahead += 2 * 86_400_000;
      const held = body.purchase_units as { payments: { captures: { status: string }[] } }[];
      held[0].payments.captures[0].status = "PENDING";
      body.status = "COMPLETED";
    }
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
type Commands = (string | number)[][];
type Pipeline = (commands: Commands) => Promise<unknown[]>;
const timeout = () => new Error("Synthetic: Redis timed out");

/**
 * How Redis fails while the return runs ("none": it does not):
 *  - "settle": the step that writes the payment down never reaches Redis (probe A);
 *  - "watch-unsent": putting the order in pending never reaches Redis;
 *  - "watch-lost": it is applied, but its answer is lost on the way back;
 *  - "watch-text" / "watch-wrapped": it is applied and answers in a shape not known (rule 24);
 *  - "record-gone": the order's record ends just before the step that puts it in pending (its life renewed there);
 *  - "life-text" / "life-two" / "life-null": that renewal is applied and answers in a shape not known (rule 24);
 *  - "slow-settle": the step that puts the order in pending reaches Redis two seconds after it was sent, and the step
 *    that writes the payment down never reaches it (Claude 5's probe on #3411).
 */
type Fault = "none" | "settle" | "watch-unsent" | "watch-lost" | "watch-text" | "watch-wrapped" | "record-gone" | "life-text" | "life-two" | "life-null" | "slow-settle";
const pendingWrite = (commands: Commands) => commands.some((command) => command[0] === "ZADD" && String(command[1]).startsWith("nl:ppsell:pending:"));
/** Where the step that puts an order in pending renews the order's record, if it does. */
const lifeAt = (commands: Commands) => commands.findIndex((command) => /^EXPIRE(AT)?$/.test(String(command[0])) && String(command[1]).startsWith("nl:ppsell:o:"));
/** Every command the last return sent that writes or renews an order's record. */
let recordSent: Commands = [];
const settleWrite = (commands: Commands) => commands.some((command) => command[0] === "EVAL" && String(command[1]).includes("marktmorgen:paypal-settle"));

/** The pipelines that put an order in pending before its capture, as the last return sent them. */
let watchSent: Commands[] = [];

async function returnFor(store: Store, order: string, fault: Fault): Promise<{ status: number; location: string }> {
  const pipeline: Pipeline = redis.pipeline.bind(redis);
  let struck = false;
  watchSent = [];
  recordSent = [];
  redis.pipeline = (async (commands: Commands) => {
    if (pendingWrite(commands) && lifeAt(commands) >= 0) watchSent.push(commands);
    for (const command of commands) if (/^(SET|EXPIRE|EXPIREAT)$/.test(String(command[0])) && String(command[1]).startsWith("nl:ppsell:o:")) recordSent.push(command);
    if (fault === "slow-settle" && pendingWrite(commands) && lifeAt(commands) >= 0) ahead += 2_000;
    if (struck || fault === "none") return pipeline(commands);
    if ((fault === "settle" || fault === "slow-settle") && settleWrite(commands)) {
      struck = true;
      throw timeout();
    }
    if (fault === "record-gone" && pendingWrite(commands) && lifeAt(commands) >= 0) {
      struck = true;
      await pipeline([["DEL", String(commands[lifeAt(commands)][1])]]);
      return pipeline(commands);
    }
    if (fault.startsWith("life-") && pendingWrite(commands) && lifeAt(commands) >= 0) {
      struck = true;
      const replies = await pipeline(commands);
      const at = lifeAt(commands);
      replies[at] = fault === "life-text" ? String(replies[at]) : fault === "life-two" ? 2 : null;
      return replies;
    }
    if (fault.startsWith("watch-") && pendingWrite(commands)) {
      struck = true;
      if (fault === "watch-unsent") throw timeout();
      const replies = await pipeline(commands);
      if (fault === "watch-lost") throw timeout();
      return fault === "watch-text" ? replies.map((reply) => String(reply)) : [{ result: replies[0] }];
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    const response = await paypalReturn(
      new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }),
    );
    return { status: response.status, location: response.headers.get("location") ?? "" };
  } catch {
    // The return fails outright while Redis does: nothing is shown as paid; what matters is what is left written.
    return { status: 500, location: "" };
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const id = added.product.id;
  const statsId = store.statsId!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const members = async (key: string) => (await redis.pipeline([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[];
  const pending = async (order: string) => (await members(`nl:ppsell:pending:${statsId}`)).includes(order);
  const sales = async (order: string) => (await members(`nl:ppsell:sales:${statsId}`)).filter((member) => member === order).length;
  const sweep = async () => {
    ahead += 3_600_000;
    return (await sweepPayPal(await fresh(), Date.now() + 10_000)).cleared;
  };
  const open = async (buyer: string): Promise<string> => {
    const product = (await readListing(store, id))!;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    buyerFor = buyer;
    receipts.set(buyer, 0);
    return opened.order;
  };
  /** Where an order stands: paid, handed over, its receipts, counted in the store's sales, in pending, owed a hand-over, captured. */
  const state = async (order: string, buyer: string) => ({
    paid: Boolean(await readPaid(order)),
    owned: await owned(buyer),
    receipts: receipts.get(buyer) ?? 0,
    sales: await sales(order),
    pending: await pending(order),
    owed: (await members(handOverKey(statsId))).includes(order),
    captured: captures.get(order) ?? 0,
  });

  part("Healthy control: taken once, written down, handed over once, off pending");
  captureWith = "take";
  const healthy = await open("healthy@example.com");
  const back = await returnFor(store, healthy, "none");
  is("the buyer is sent to the thanks page", [back.status, back.location.includes("/thanks?paypal=")], [303, true]);
  is("paid, handed over, one receipt, counted once, off pending, not owed, captured once", await state(healthy, "healthy@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  is("one step put it in pending and renewed its record, after the step that counted the try, the commands tests/plan-cost-registry.ts prices", [watchSent.length, watchSent[0]?.length, PAYPAL_CAPTURE_WATCH.countCommandsPerTry + PAYPAL_CAPTURE_WATCH.watchCommandsPerCaptureAsked], [1, PAYPAL_CAPTURE_WATCH.watchCommandsPerCaptureAsked, PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked]);
  is("the tries an order may ask, the bound lib/paypal-sales.ts holds, as tests/plan-cost-registry.ts prices them", (paypalSales as Record<string, unknown>).CAPTURE_TRIES_PER_ORDER, PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost);
  is("all of them together inside a tenth of the order's own work (ORDER_COMPUTE)", PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked * COMMAND < ORDER_COMPUTE / 10, true);
  is("a sweep after it hands nothing over again", await sweep(), 0);
  is("and nothing moved", await state(healthy, "healthy@example.com"), { paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1 });

  part("Probe A: PayPal takes the payment, then writing it down never reaches Redis");
  captureWith = "take";
  const lost = await open("probe-a@example.com");
  await returnFor(store, lost, "settle");
  is("PayPal took it once, nothing is written down yet", [captures.get(lost), Boolean(await readPaid(lost))], [1, false]);
  is("but the order stands in pending, for the sweep to resume", await pending(lost), true);
  let cleared = 0;
  for (let i = 0; i < 3; i += 1) cleared += await sweep();
  is("three sweeps later: paid, handed over, one receipt, counted once, off pending, not owed, never captured again", await state(lost, "probe-a@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  is("handed over by the sweep, once", cleared, 1);
  const reload = await returnFor(store, lost, "none");
  is("the buyer opening the return again is sent to the thanks page", [reload.status, reload.location.includes("/thanks?paypal=")], [303, true]);
  is("and nothing is taken, handed over, receipted or counted twice", await state(lost, "probe-a@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });

  for (const [fault, label] of [
    ["watch-unsent", "putting the order in pending never reaches Redis"],
    ["watch-lost", "putting the order in pending is applied, but its answer is lost"],
    ["watch-text", "putting the order in pending answers in text, not a count"],
    ["watch-wrapped", "putting the order in pending answers in a wrapped shape"],
  ] as [Fault, string][]) {
    part(`Rule 24: ${label}`);
    captureWith = "take";
    const buyer = `${fault}@example.com`;
    const order = await open(buyer);
    const shown = await returnFor(store, order, fault);
    is("PayPal is not asked to take anything", captures.get(order) ?? 0, 0);
    is("and the buyer is never shown the thanks page as paid", shown.location.includes("/thanks?paypal="), false);
    is("nothing written down, handed over or receipted", await state(order, buyer), {
      paid: false, owned: 0, receipts: 0, sales: 0, pending: fault !== "watch-unsent", owed: false, captured: 0,
    });
    is("a sweep never takes the payment itself", [await sweep(), captures.get(order) ?? 0], [0, 0]);
    const again = await returnFor(store, order, "none");
    is("the buyer opening the return again with Redis well: taken once and sent to the thanks page", [captures.get(order), again.location.includes("/thanks?paypal=")], [1, true]);
    is("paid, handed over, one receipt, counted once, off pending, not owed", await state(order, buyer), {
      paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
    });
  }

  part("Control: PayPal declines the capture (nothing charged)");
  captureWith = "decline";
  const declined = await open("declined@example.com");
  const no = await returnFor(store, declined, "none");
  is("the buyer is told PayPal did not take it", no.location.includes("status=paypal-declined"), true);
  is("nothing paid, and the order is not left in pending", await state(declined, "declined@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 1,
  });

  part("Control: the capture's answer never comes back and PayPal's order shows no capture");
  captureWith = "lost";
  const unsure = await open("unsure@example.com");
  orders.set(unsure, { id: unsure, status: "APPROVED" });
  await returnFor(store, unsure, "none");
  is("kept in pending, nothing paid", await state(unsure, "unsure@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: true, owed: false, captured: 1,
  });
  is("a sweep keeps asking and takes nothing itself", [await sweep(), await pending(unsure), captures.get(unsure)], [0, true, 1]);
  orders.set(unsure, { id: unsure, status: "VOIDED" });
  await sweep();
  is("once PayPal says it was voided, let go, nothing paid", await state(unsure, "unsure@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 1,
  });

  part("Control: watched by an earlier try whose answer was lost, then declined: still left to the sweep");
  captureWith = "lost";
  const earlier = await open("earlier@example.com");
  orders.set(earlier, { id: earlier, status: "APPROVED" });
  await returnFor(store, earlier, "none");
  captureWith = "decline";
  const later = await returnFor(store, earlier, "none");
  is("the buyer is told PayPal did not take it", later.location.includes("status=paypal-declined"), true);
  is("and the order stays in pending, nothing paid", await state(earlier, "earlier@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: true, owed: false, captured: 2,
  });

  part("Late in the record's life: PayPal takes the payment 71.5 hours after the order opened, then writing it down fails");
  captureWith = "take";
  const late = await open("late@example.com");
  ahead += 71.5 * 3_600_000;
  await returnFor(store, late, "settle");
  is("PayPal took it once, nothing is written down yet, the order stands in pending", [captures.get(late), Boolean(await readPaid(late)), await pending(late)], [1, false, true]);
  const life = (await redis.pipeline([["TTL", `nl:ppsell:o:${late}`]]))[0] as number;
  is("the order's record now lives thirty days from its opening, not what was left of its three", life > 30 * 86_400 - 72 * 3_600 && life <= 30 * 86_400 - 71.5 * 3_600, true);
  let lateCleared = 0;
  for (let i = 0; i < 3; i += 1) lateCleared += await sweep();
  is("three sweeps later, past the record's first three days: paid, handed over, one receipt, counted once, off pending, never captured again", await state(late, "late@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  is("handed over by the sweep, once", lateCleared, 1);

  /** The order's record as written, and its life left, in seconds. */
  const record = async (order: string) => {
    const [raw, ttl] = await redis.pipeline([["GET", `nl:ppsell:o:${order}`], ["TTL", `nl:ppsell:o:${order}`]]);
    return { opened: raw === null ? null : (JSON.parse(String(raw)) as { at: number }), ttl: ttl as number };
  };
  /** Moves an order's opening back in time, its record kept alive a day (as an earlier rule could have kept it). */
  const openedAgo = async (order: string, seconds: number) => {
    const { opened } = await record(order);
    await redis.pipeline([["SET", `nl:ppsell:o:${order}`, JSON.stringify({ ...opened, at: Math.floor(Date.now() / 1000) - seconds }), "EX", 86_400]]);
  };

  part("Thirty days from the opening: a capture asked ten days after the order opened keeps its record twenty more");
  captureWith = "lost";
  const tenth = await open("tenth@example.com");
  orders.set(tenth, { id: tenth, status: "APPROVED" });
  await returnFor(store, tenth, "none");
  const first = await record(tenth);
  is("kept for the sweep at its first try, until thirty days from its opening", [first.ttl > 30 * 86_400 - 60 && first.ttl <= 30 * 86_400, await pending(tenth)], [true, true]);
  is("the record's thirty days are sent as the opening's time plus thirty days (EXPIREAT and SET EXAT)", recordSent.map((command) => [command[0], command.includes("EXAT") ? command[command.indexOf("EXAT") + 1] : command[0] === "EXPIREAT" ? command[2] : "relative"]), [
    ["EXPIREAT", String(first.opened!.at + 30 * 86_400)],
    ["SET", String(first.opened!.at + 30 * 86_400)],
  ]);
  ahead += 10 * 86_400_000;
  captureWith = "take";
  await returnFor(store, tenth, "settle");
  const tenthLife = (await record(tenth)).ttl;
  is("taken once ten days after opening, nothing written down yet, in pending", [captures.get(tenth), Boolean(await readPaid(tenth)), await pending(tenth)], [2, false, true]);
  is("its record keeps the twenty days left of the thirty from opening, not thirty from this try", tenthLife > 20 * 86_400 - 120 && tenthLife <= 20 * 86_400, true);
  let tenthCleared = 0;
  for (let i = 0; i < 3; i += 1) tenthCleared += await sweep();
  is("three sweeps later: paid, handed over, one receipt, counted once, off pending", await state(tenth, "tenth@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 2,
  });
  is("handed over by the sweep, once", tenthCleared, 1);

  part("Past thirty days from the opening: PayPal is asked nothing, as for a record that ended");
  captureWith = "take";
  const old = await open("old@example.com");
  await openedAgo(old, 30 * 86_400 + 60);
  const oldBack = await returnFor(store, old, "none");
  is("PayPal is not asked to take anything", captures.get(old) ?? 0, 0);
  is("the buyer sees the same notice as for a record that ended", [oldBack.status, oldBack.location.includes("status=paypal-error")], [303, true]);
  is("nothing written down, put in pending, handed over or receipted", await state(old, "old@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 0,
  });
  is("and its record is not renewed", recordSent, []);

  part("Less than a day before thirty days from the opening: PayPal is asked nothing, as for a record that ended");
  captureWith = "lost-late";
  const edge = await open("edge@example.com");
  orders.set(edge, { id: edge, status: "APPROVED" });
  await openedAgo(edge, 30 * 86_400 - 30);
  const edgeBack = await returnFor(store, edge, "none");
  is("PayPal is not asked to take anything", captures.get(edge) ?? 0, 0);
  is("the buyer sees the same notice as for a record that ended", [edgeBack.status, edgeBack.location.includes("status=paypal-error")], [303, true]);
  is("its record is not renewed, and it is not put in pending", [recordSent, await pending(edge)], [[], false]);
  is("a sweep takes nothing", [await sweep(), captures.get(edge) ?? 0], [0, 0]);

  part("Claude 5's probe: opened thirty days less a second ago, put in pending two seconds late, taken, writing it down fails");
  captureWith = "take";
  const probe = await open("probe-30@example.com");
  await openedAgo(probe, 30 * 86_400 - 1);
  const probeBack = await returnFor(store, probe, "slow-settle");
  is("PayPal is not asked to take anything", captures.get(probe) ?? 0, 0);
  is("the buyer sees the same notice as for a record that ended", [probeBack.status, probeBack.location.includes("status=paypal-error")], [303, true]);
  let probeCleared = 0;
  for (let i = 0; i < 3; i += 1) probeCleared += await sweep();
  is("so no buyer is charged with nothing written down: nothing taken, paid, put in pending, handed over or receipted", [probeCleared, await state(probe, "probe-30@example.com")], [0, {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 0,
  }]);

  part("A day less a minute before thirty days from the opening: PayPal is asked nothing");
  captureWith = "take";
  const short = await open("short@example.com");
  await openedAgo(short, 29 * 86_400 + 60);
  const shortBack = await returnFor(store, short, "settle");
  is("PayPal is not asked, the buyer sees the notice for a record that ended, nothing is put in pending", [captures.get(short) ?? 0, shortBack.location.includes("status=paypal-error"), await pending(short)], [0, true, false]);

  part("A day and a minute before thirty days from the opening: taken, writing it down fails, the sweep still writes it down");
  captureWith = "take";
  const room = await open("room@example.com");
  await openedAgo(room, 29 * 86_400 - 60);
  await returnFor(store, room, "settle");
  is("PayPal took it once, nothing is written down yet, the order stands in pending", [captures.get(room), Boolean(await readPaid(room)), await pending(room)], [1, false, true]);
  let roomCleared = 0;
  for (let i = 0; i < 3; i += 1) roomCleared += await sweep();
  is("three sweeps later: paid, handed over, one receipt, counted once, off pending, never captured again", await state(room, "room@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  is("handed over by the sweep, once", roomCleared, 1);

  part("PayPal's answer comes back after thirty days from the opening, the payment held as pending: the record is kept for the sweep");
  captureWith = "pending-late";
  const held = await open("held@example.com");
  await openedAgo(held, 29 * 86_400 - 60);
  const heldOpened = (await record(held)).opened!;
  const heldBack = await returnFor(store, held, "none");
  is("PayPal was asked once, with a day's room", captures.get(held), 1);
  is("the buyer is sent to the thanks page, which says PayPal is still taking the payment", [heldBack.status, heldBack.location.includes("/thanks?paypal=")], [303, true]);
  const kept = await record(held);
  is("the record is kept a few hours past its ceiling, never dropped, and the order stands in pending", [kept.opened?.at, kept.ttl > 6 * 3_600 - 60 && kept.ttl <= 6 * 3_600, await pending(held)], [heldOpened.at, true, true]);
  is("written again only once the answer came back, past thirty days from the opening", recordSent.map((command) => [command[0], command[0] === "SET" ? Number(command[command.indexOf("EXAT") + 1]) > heldOpened.at + 30 * 86_400 : "renewal"]), [
    ["EXPIREAT", "renewal"],
    ["SET", true],
  ]);
  orders.set(held, completed(held, "49.00", "held@example.com"));
  is("PayPal completes it: the next sweep writes it down and hands it over, once", [await sweep(), await state(held, "held@example.com")], [1, {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  }]);

  part("The order's record ends just before it is put in pending");
  captureWith = "take";
  const gone = await open("gone@example.com");
  const goneBack = await returnFor(store, gone, "record-gone");
  is("PayPal is not asked to take anything", captures.get(gone) ?? 0, 0);
  is("and the buyer is never shown the thanks page as paid", goneBack.location.includes("/thanks?paypal="), false);
  is("nothing written down, handed over or receipted", [Boolean(await readPaid(gone)), await owned("gone@example.com"), receipts.get("gone@example.com") ?? 0, await sales(gone)], [false, 0, 0, 0]);
  is("a sweep lets go of the entry and takes nothing", [await sweep(), await pending(gone), captures.get(gone) ?? 0], [0, false, 0]);

  for (const [fault, label] of [
    ["life-text", "renewing the order's record answers in text, not a count"],
    ["life-two", "renewing the order's record answers a count that is neither 0 nor 1"],
    ["life-null", "renewing the order's record answers nothing"],
  ] as [Fault, string][]) {
    part(`Rule 24: ${label}`);
    captureWith = "take";
    const buyer = `${fault}@example.com`;
    const order = await open(buyer);
    const shown = await returnFor(store, order, fault);
    is("PayPal is not asked to take anything", captures.get(order) ?? 0, 0);
    is("and the buyer is never shown the thanks page as paid", shown.location.includes("/thanks?paypal="), false);
    is("nothing written down, handed over or receipted", [Boolean(await readPaid(order)), await owned(buyer), receipts.get(buyer) ?? 0, await sales(order)], [false, 0, 0, 0]);
    const again = await returnFor(store, order, "none");
    is("the buyer opening the return again with Redis well: taken once and sent to the thanks page", [captures.get(order), again.location.includes("/thanks?paypal=")], [1, true]);
    is("paid, handed over, one receipt, counted once, off pending, not owed", await state(order, buyer), {
      paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
    });
  }

  part("Claude 7's cost MEDIUM on #3411: the return replayed for an order PayPal holds as pending asks PayPal a bounded number of times");
  // The return route is held per connection and store, not per order; a buyer reloading it, or a script replaying it
  // from many addresses, used to send the watch and a capture each time, for as long as the record lives (thirty days).
  captureWith = "pending";
  const replayed = await open("replayed@example.com");
  const tries = PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost;
  const replays = 10;
  let watches = 0;
  let watchCommands = 0;
  const pastBound: { status: number; location: string; records: number }[] = [];
  for (let i = 0; i < replays; i += 1) {
    const shown = await returnFor(store, replayed, "none");
    watches += watchSent.length;
    watchCommands += watchSent.reduce((sum, sent) => sum + sent.length, 0);
    if (i >= tries) pastBound.push({ ...shown, records: recordSent.filter((command) => command[0] === "SET").length });
  }
  is("PayPal is asked to take the payment fewer times than the return was opened", (captures.get(replayed) ?? 0) < replays, true);
  is("exactly the bound's number of times, however often the return is opened", captures.get(replayed), tries);
  is("the watch's commands, every return together, stay inside what the registry prices for the order", watchCommands <= PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked, true);
  is("only the returns inside the bound sent the watch; those past it wrote nothing and asked PayPal nothing", watches, tries);
  is("a return past the bound still lands on the thanks page and writes the record nothing more", pastBound.every((shown) => shown.status === 303 && shown.location.includes("/thanks?paypal=") && shown.records === 0), true);
  is("the order still stands in pending, never written down as paid", [await pending(replayed), Boolean(await readPaid(replayed))], [true, false]);
  orders.set(replayed, completed(replayed, "49.00", "replayed@example.com"));
  is("PayPal completes it: the next sweep writes it down and hands it over, once, never captured again", [await sweep(), await state(replayed, "replayed@example.com")], [1, {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: tries,
  }]);

  part("Rule 24: an order's count of capture tries that does not read as a number");
  captureWith = "take";
  const miscounted = await open("miscounted@example.com");
  await redis.pipeline([["SET", `nl:ppsell:try:${miscounted}`, "three"]]);
  const miscountedBack = await returnFor(store, miscounted, "none");
  is("PayPal is not asked to take anything, as for a record that does not read", captures.get(miscounted) ?? 0, 0);
  is("and the buyer is never shown the thanks page as paid", miscountedBack.location.includes("/thanks?paypal="), false);
  is("nothing written: not watched, not in pending", [watchSent.length, await pending(miscounted), Boolean(await readPaid(miscounted))], [0, false, false]);

  /**
   * Sends `count` returns of one order at once, each read of the order's record and count held until all of them have
   * read it (Claude 5's probe on #3411, Codex X2's MEDIUM 2): every one reads the count before any try is counted.
   * Returns what each return was shown and every pipeline sent meanwhile with its replies.
   */
  const together = async (order: string, count: number, losePendingWrite = false) => {
    const pipeline: Pipeline = redis.pipeline.bind(redis);
    const sent: { commands: Commands; replies: unknown[] }[] = [];
    const waiting: (() => void)[] = [];
    let read = 0;
    const isRead = (commands: Commands) =>
      commands.length === 2 && commands[0][0] === "GET" && commands[0][1] === `nl:ppsell:o:${order}` && commands[1][0] === "GET" && commands[1][1] === `nl:ppsell:try:${order}`;
    redis.pipeline = (async (commands: Commands) => {
      // The admitted return's write of the order to pending fails before Redis has it (Codex X5 on #3411).
      if (losePendingWrite && commands.some((c) => c[0] === "ZADD" && String(c[1]).startsWith("nl:ppsell:pending:")) && !commands.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:ppsell:o:"))) {
        throw new Error("synthetic failure before recording pending");
      }
      const replies = await pipeline(commands);
      sent.push({ commands, replies });
      if (isRead(commands)) {
        read += 1;
        if (read < count) await new Promise<void>((resolve) => waiting.push(resolve));
        else for (const resolve of waiting.splice(0)) resolve();
      }
      return replies;
    }) as typeof redis.pipeline;
    try {
      const shown = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `203.0.113.${i + 1}` } }))
            .then((response) => ({ status: response.status, location: response.headers.get("location") ?? "" }))
            .catch(() => ({ status: 500, location: "" })),
        ),
      );
      return { shown, sent, read };
    } finally {
      redis.pipeline = pipeline;
    }
  };
  const tryCommand = (command: (string | number)[]) => /^(INCR|EXPIREAT)$/.test(String(command[0])) && String(command[1]).startsWith("nl:ppsell:try:");
  /** A command that puts the order in pending, or renews its record, before PayPal is asked (watchLater's SET and ZADD after an answer are not). */
  const watchCommand = (command: (string | number)[], commands: Commands) =>
    (command[0] === "EXPIREAT" && String(command[1]).startsWith("nl:ppsell:o:")) ||
    (command[0] === "ZADD" && String(command[1]).startsWith("nl:ppsell:pending:") && !commands.some((other) => other[0] === "SET" && String(other[1]).startsWith("nl:ppsell:o:")));

  part("Claude 5's probe on #3411 (Codex X2's MEDIUM 2): eight returns of one order at once, each read before any try is counted");
  captureWith = "pending";
  const raced = await open("raced@example.com");
  const eight = await together(raced, 8);
  const all = eight.sent.flatMap(({ commands }) => commands.map((command) => ({ command, commands })));
  const watchWrites = all.filter(({ command, commands }) => watchCommand(command, commands)).length;
  const tryWrites = all.filter(({ command }) => tryCommand(command)).length;
  is("all eight read the order's count before any of them counted a try", eight.read, 8);
  is("control: PayPal is asked to take the payment three times, the bound", captures.get(raced), PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost);
  is("only the three admitted tries put the order in pending or renew its record", watchWrites, PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.watchCommandsPerCaptureAsked);
  is("the admitted tries together send at most what the registry prices for the order (3 x 4 = 12)", watchWrites + PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.countCommandsPerTry <= PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked, true);
  is("each refused return sends only its count, the refused path the registry prices per return", tryWrites, 8 * PAYPAL_CAPTURE_WATCH.countCommandsPerTry);
  is("every watch and count command of the eight together: 3 x 4 + 5 x 2, not 8 x 4", watchWrites + tryWrites <= PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost * PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked + 5 * PAYPAL_CAPTURE_WATCH.commandsPerRefusedReturnAtMost, true);
  // Codex X5 on #3411: a return refused because the others took every try proves no capture is under watch (the one
  // that took the last try may not have written it yet), so it is told it did not go through, never sent to the thanks
  // page; the three admitted ones, each with its capture in pending, are.
  const thanks = eight.shown.filter((shown) => shown.status === 303 && shown.location.includes("/thanks?paypal=")).length;
  const told = eight.shown.filter((shown) => shown.status === 303 && shown.location.includes("status=paypal-error")).length;
  is("the admitted returns land on the thanks page, the refused ones on the store's notice", [thanks, told], [PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost, 8 - PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost]);
  is("the order stands in pending, never written down as paid", [await pending(raced), Boolean(await readPaid(raced))], [true, false]);

  part("Codex X2's MEDIUM 2: two returns at once with one try left, PayPal declines: only the admitted one adds to pending, and the order is not put back");
  captureWith = "decline";
  const lastSlot = await open("last-slot@example.com");
  await redis.pipeline([["SET", `nl:ppsell:try:${lastSlot}`, String(PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost - 1), "EX", 86_400]]);
  const pair = await together(lastSlot, 2);
  const adds = pair.sent.flatMap(({ commands }) => commands).filter((command) => command[0] === "ZADD" && String(command[1]).startsWith("nl:ppsell:pending:")).length;
  is("both read the count with one try left", pair.read, 2);
  is("PayPal is asked once", captures.get(lastSlot), 1);
  is("only one return sends the order to pending", adds, 1);
  is("declined: the order is not left in pending, nothing paid", [await pending(lastSlot), Boolean(await readPaid(lastSlot))], [false, false]);

  part("Codex X5's MEDIUM on #3411: two returns read the last try, the admitted one never records pending: neither is sent to the thanks page");
  captureWith = "pending";
  const lostWrite = await open("lost-write@example.com");
  await redis.pipeline([["SET", `nl:ppsell:try:${lostWrite}`, String(PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost - 1), "EX", 86_400]]);
  const unrecorded = await together(lostWrite, 2, true);
  is("both read the count with one try left", unrecorded.read, 2);
  is("PayPal is asked nothing, nothing is in pending or paid", [captures.get(lostWrite) ?? 0, await pending(lostWrite), Boolean(await readPaid(lostWrite))], [0, false, false]);
  is("neither return is sent to the thanks page", unrecorded.shown.some((shown) => shown.location.includes("/thanks?paypal=")), false);
  is("the refused one is told it did not go through", unrecorded.shown.some((shown) => shown.status === 303 && shown.location.includes("status=paypal-error")), true);

  part("Codex X2's MEDIUM 1 (Claude 5: LEVE): past the bound after confirmed refusals, the return does not say PayPal is still taking it");
  captureWith = "decline";
  const refused = await open("refused@example.com");
  for (let i = 0; i < PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost; i += 1) {
    const shown = await returnFor(store, refused, "none");
    is(`try ${i + 1}: shown as declined`, shown.location.includes("status=paypal-declined"), true);
  }
  is("declined three times, off pending", [captures.get(refused), await pending(refused)], [3, false]);
  const fourth = await returnFor(store, refused, "none");
  is("a fourth return asks PayPal nothing", captures.get(refused), 3);
  is("and is not sent to the thanks page, which would say PayPal is still taking it", fourth.location.includes("/thanks?paypal="), false);
  is("it is sent to the store's notice, which tells the buyer to write to the store if PayPal shows money taken", fourth.location.includes("status=paypal-error"), true);
  is("nothing written: not put back in pending, not watched", [await pending(refused), watchSent.length], [false, 0]);

  part("Control: past the bound with a capture really under watch, the return still lands on the thanks page");
  captureWith = "lost";
  const watched = await open("watched@example.com");
  orders.set(watched, { id: watched, status: "APPROVED" });
  for (let i = 0; i < PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost; i += 1) await returnFor(store, watched, "none");
  const past = await returnFor(store, watched, "none");
  is("PayPal asked three times, the order in pending", [captures.get(watched), await pending(watched)], [3, true]);
  is("the return past the bound lands on the thanks page and writes nothing", [past.location.includes("/thanks?paypal="), watchSent.length], [true, 0]);

  part("Rule 24: past the bound, the read of where the order stands answers in a shape not known");
  const strange = await open("strange@example.com");
  orders.set(strange, { id: strange, status: "APPROVED" });
  await redis.pipeline([["SET", `nl:ppsell:try:${strange}`, String(PAYPAL_CAPTURE_WATCH.capturesAskedPerOrderAtMost), "EX", 86_400]]);
  const stock: Pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: Commands) => {
    const replies = await stock(commands);
    return commands.some((command) => command[0] === "ZSCORE" && String(command[1]).startsWith("nl:ppsell:pending:")) ? replies.map(() => 7) : replies;
  }) as typeof redis.pipeline;
  let strangeShown: { status: number; location: string };
  try {
    strangeShown = await paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${strange}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": "203.0.113.99" } }))
      .then((response) => ({ status: response.status, location: response.headers.get("location") ?? "" }))
      .catch(() => ({ status: 500, location: "" }));
  } finally {
    redis.pipeline = stock;
  }
  is("an unknown answer is taken for neither: PayPal is not asked, nothing is written, the buyer is not told where it stands", [captures.get(strange) ?? 0, await pending(strange), strangeShown.status], [0, false, 500]);

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
