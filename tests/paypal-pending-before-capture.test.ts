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
 * taken); "lost-late": the answer never comes back and a minute passes meanwhile.
 */
let captureWith: "take" | "decline" | "lost" | "lost-late" = "take";
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
 *  - "life-text" / "life-two" / "life-null": that renewal is applied and answers in a shape not known (rule 24).
 */
type Fault = "none" | "settle" | "watch-unsent" | "watch-lost" | "watch-text" | "watch-wrapped" | "record-gone" | "life-text" | "life-two" | "life-null";
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
    if (struck || fault === "none") return pipeline(commands);
    if (fault === "settle" && settleWrite(commands)) {
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
  is("one step put it in pending and renewed its record, the commands tests/plan-cost-registry.ts prices", [watchSent.length, watchSent[0]?.length], [1, PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked]);
  is("inside the order's own work (ORDER_COMPUTE)", PAYPAL_CAPTURE_WATCH.commandsPerCaptureAsked * COMMAND < ORDER_COMPUTE / 10, true);
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

  part("Thirty days from the opening pass while PayPal is asked: the order is not kept past them");
  captureWith = "lost-late";
  const edge = await open("edge@example.com");
  orders.set(edge, { id: edge, status: "APPROVED" });
  await openedAgo(edge, 30 * 86_400 - 30);
  const edgeBack = await returnFor(store, edge, "none");
  is("PayPal was asked once, before the thirty days passed", captures.get(edge), 1);
  is("the buyer sees the same notice as for a record that ended", [edgeBack.status, edgeBack.location.includes("status=paypal-error")], [303, true]);
  is("its record is not written again past thirty days from its opening", recordSent.map((command) => command[0]), ["EXPIREAT"]);
  is("and it has ended", (await record(edge)).opened, null);
  is("a sweep lets go of the entry and takes nothing", [await sweep(), await pending(edge), captures.get(edge)], [0, false, 1]);

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

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
