/**
 * An offer taken in one click after paying, through an affiliate's link, earns
 * the affiliate their share (lib/upsell.ts, afterPaid; lib/affiliates.ts,
 * noteCharge). Since the review of round 30 (#3366) a share that does not read,
 * or a write of the book that fails, throws rather than set the sale down at 0%
 * for good (HSETNX). A checkout's sale is then kept by the five-minute sweep and
 * written on a later run (lib/checkout-sweep.ts, failOrder, inside
 * CONFIRM_WITHIN_SECONDS); an offer's charge was only logged, and nothing ever
 * tried again: the affiliate lost the commission (Claude 5's LEVE 1 on #3366).
 *
 * Now a paid offer whose share was not written stays on the list the
 * five-minute job already walks for offers (settlePendingOffers), and the job
 * writes the share once it can, inside the same window a checkout has. Each
 * try is the same HSETNX, so the share is written once however many tries it
 * takes; a try sends no second confirmation and charges nothing. Past the
 * window the offer leaves the list, and nothing is set down at 0%.
 *
 * Everything runs against a stand-in for the creator's Stripe account and an
 * in-memory store; a moment of trouble writing the book is made by failing the
 * one write of the affiliate's sales once.
 */
import { NextRequest } from "next/server";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setAffiliateSetting,
  setProductFunnel,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { UPSELL_COOKIE, newUpsellKey, readUpsell, settlePendingOffers } from "@/lib/upsell";
import { CONFIRM_WITHIN_SECONDS } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_commission_retry_only";
process.env.RESEND_API_KEY = "re_test_upsell_commission_retry_only";

const OWNER = "glazier@example.com";
const HANDLE = "glazeworks";
const ACCOUNT = "acct_1TestUpRetry1";
const AFFILIATE = "aaaaaaaaaaaa";
const NOW = Math.floor(Date.now() / 1000);
const PENDING = "nl:upsell:pending";

let emails = 0;
const charges: Record<string, Record<string, unknown>> = {};
const reads: string[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    emails += 1;
    return answer({ id: `email_${emails}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const id = `pi_test_${String(Object.keys(charges).length + 1).padStart(10, "0")}`;
    charges[id] = {
      id,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    };
    return answer(charges[id]);
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one && method === "GET") {
    reads.push(one[1]);
    return charges[one[1]] ? answer(charges[one[1]]) : answer({ error: { message: "no such payment" } }, 404);
  }
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** Fails the next `n` writes of the affiliate's book, as a moment of trouble with the store would. */
let failSales = 0;
let failed = 0;
let salesKey = "";
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (failSales > 0 && salesKey && JSON.stringify(commands).includes(salesKey)) {
    failSales -= 1;
    failed += 1;
    throw new Error("the store did not answer for a moment");
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

/** The job, run a few minutes later than now (it leaves an offer a minute's grace), or `ms` later. */
async function job(ms = 3 * 60_000): Promise<void> {
  const real = Date.now;
  Date.now = () => real() + ms;
  try {
    await settlePendingOffers(async (handle) => (handle === HANDLE ? storeForEmail(OWNER) : null), Date.now() + 60_000);
  } finally {
    Date.now = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Glazeworks", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00003", subscriptionId: "sub_Owner00003", active: true, period: paidPeriod() });
  const set = await setAffiliateSetting(OWNER, { ...NO_AFFILIATES, enabled: true, percent: 20 });
  if (!set.ok) throw new Error("affiliates not on");
  const statsId = set.store.statsId as string;
  salesKey = `nl:aff:${statsId}:sales`;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, AFFILIATE, JSON.stringify({ id: AFFILIATE, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })],
  ]);
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Kiln Basics Course", "49");
  const offer = await add("Glaze Chemistry Notes", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "chem1", productId: offer, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  if (!saved.ok) throw new Error("no funnel");

  const sale = async (ref: string) => {
    const [raw] = (await pipeline([["HGET", salesKey, ref]])) as unknown[];
    return typeof raw === "string" ? (JSON.parse(raw) as { rate?: unknown; aff?: unknown }) : null;
  };
  const book = async () => Number(((await pipeline([["HLEN", salesKey]])) as unknown[])[0]);
  const listed = async (session: string) => ((await pipeline([["ZSCORE", PENDING, `${HANDLE}|${session}|`]])) as unknown[])[0] !== null;

  const browser = newUpsellKey();
  const press = async (session: string) => {
    sessions[session] = {
      id: session,
      status: "complete",
      payment_status: "paid",
      created: NOW - 60,
      customer: "cus_TestRetryBuyer",
      currency: "usd",
      metadata: { store: HANDLE, product: front, upsell_key: browser.fingerprint, via: AFFILIATE, via_rate: "20" },
      customer_details: { email: "buyer@example.com" },
      payment_intent: { id: "pi_test_front00003", payment_method: { id: "pm_test_card0003", type: "card", customer: "cus_TestRetryBuyer" } },
    };
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("session_id", session);
    form.set("step", "chem1");
    form.set("answer", "yes");
    form.set(CONSENT_FIELD, "yes");
    form.set(CONSENT_VERSION_FIELD, TEST_CONSENT.version);
    const response = await upsellRoute(
      new NextRequest("https://marktmorgen.com/api/store/upsell", {
        method: "POST",
        body: form,
        headers: { host: "marktmorgen.com", cookie: `${UPSELL_COOKIE}=${browser.secret}` },
      }),
    );
    return new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell");
  };

  part("Control: an offer through an affiliate's link, its share written at once");
  const control = "cs_test_retrycontrol00001";
  is("taken and paid", [await press(control), (await readUpsell(control))?.state], ["done", "paid"]);
  const controlPi = (await readUpsell(control))?.pi as string;
  is("its share on the book at 20%, the affiliate's", [(await sale(controlPi))?.rate, (await sale(controlPi))?.aff], [20, AFFILIATE]);
  is("and nothing left for the job", await listed(control), false);

  part("The book's write fails once as the offer is taken: the share waits for the job, never lost");
  const taken = "cs_test_retrytaken000001";
  failSales = 1;
  is("the buyer's answer is unchanged: taken and paid", [await press(taken), (await readUpsell(taken))?.state], ["done", "paid"]);
  const takenPi = (await readUpsell(taken))?.pi as string;
  is("the write did fail, and nothing is on the book yet", [failed, await sale(takenPi)], [1, null]);
  is("the offer stays on the job's list", await listed(taken), true);
  const mailed = emails;
  const readsBefore = reads.length;
  await job();
  is("the job writes the share, at the 20% the charge carries", [(await sale(takenPi))?.rate, (await sale(takenPi))?.aff], [20, AFFILIATE]);
  is("by reading that one payment once", reads.slice(readsBefore), [takenPi]);
  is("and sends no second confirmation", emails, mailed);
  is("the offer is still paid, and off the list", [(await readUpsell(taken))?.state, await listed(taken)], ["paid", false]);
  const written = await book();
  await job();
  await job();
  is("later runs read nothing more and write nothing twice", [reads.length - readsBefore, await book()], [1, written]);

  part("Found paid by the job, the write failing once: written on the next run");
  const settled = "cs_test_retrysettled0001";
  const settledPi = "pi_test_settled00001";
  charges[settledPi] = {
    id: settledPi,
    object: "payment_intent",
    amount: 1900,
    currency: "usd",
    status: "succeeded",
    receipt_email: "buyer@example.com",
    created: NOW,
    metadata: { kind: "upsell", store: HANDLE, parent: settled, product: offer, title: "Glaze Chemistry Notes", via: AFFILIATE, via_rate: "20" },
  };
  await pipeline([
    ["SET", `nl:upsell:${settled}`, JSON.stringify({ state: "pending", product: offer, pi: settledPi, customer: "cus_TestRetryBuyer", at: Date.now() - 5 * 60_000 })],
    ["ZADD", PENDING, Date.now() - 5 * 60_000, `${HANDLE}|${settled}|`],
  ]);
  failSales = 1;
  await job();
  is("the job finds it paid; the write fails, nothing on the book", [(await readUpsell(settled))?.state, failed, await sale(settledPi)], ["paid", 2, null]);
  is("and it stays on the list", await listed(settled), true);
  // Put back on the list as the run found it paid, so it is the next run's, five minutes on (each run leaves a minute's grace).
  await job(8 * 60_000);
  is("the next run writes the share once", [(await sale(settledPi))?.rate, await listed(settled)], [20, false]);

  part("An offer the bank held for 30 hours: its window counts from when its share was found unwritten, not from when it began");
  const held = "cs_test_retryheld0000001";
  const heldPi = "pi_test_held000000001";
  charges[heldPi] = { ...charges[settledPi], id: heldPi, metadata: { ...(charges[settledPi].metadata as Record<string, string>), parent: held } };
  await pipeline([
    ["SET", `nl:upsell:${held}`, JSON.stringify({ state: "pending", product: offer, pi: heldPi, customer: "cus_TestRetryBuyer", at: Date.now() - 30 * 60 * 60_000 })],
    ["ZADD", PENDING, Date.now() - 30 * 60 * 60_000, `${HANDLE}|${held}|`],
  ]);
  failSales = 1;
  await job();
  is("found paid, the write failing: nothing on the book, still on the list", [(await readUpsell(held))?.state, await sale(heldPi), await listed(held)], ["paid", null, true]);
  await job(8 * 60_000);
  is("the next run writes it, though the offer began more than a day ago", [(await sale(heldPi))?.rate, await listed(held)], [20, false]);

  part("A share that does not read waits inside the window, then leaves the list, never set down at 0%");
  const garbled = "cs_test_retrygarbled0001";
  const garbledPi = "pi_test_garbled00001";
  charges[garbledPi] = { ...charges[settledPi], id: garbledPi, metadata: { ...(charges[settledPi].metadata as Record<string, string>), parent: garbled, via_rate: "twenty" } };
  await pipeline([
    ["SET", `nl:upsell:${garbled}`, JSON.stringify({ state: "pending", product: offer, pi: garbledPi, customer: "cus_TestRetryBuyer", at: Date.now() - 5 * 60_000 })],
    ["ZADD", PENDING, Date.now() - 5 * 60_000, `${HANDLE}|${garbled}|`],
  ]);
  await job();
  is("paid, nothing on the book, still on the list", [(await readUpsell(garbled))?.state, await sale(garbledPi), await listed(garbled)], ["paid", null, true]);
  await job(60 * 60_000);
  is("an hour on: still waiting, still nothing at 0%", [await sale(garbledPi), await listed(garbled)], [null, true]);
  // The window counts from the run that found the share unwritten (three minutes on): ten minutes past it.
  await job((CONFIRM_WITHIN_SECONDS + 10 * 60) * 1000);
  is("past the window a checkout has: off the list, and still never at 0%", [await sale(garbledPi), await listed(garbled)], [null, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
