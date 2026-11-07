/**
 * Claude 5's second review of #2849 (ALTO and two LEVES), held: the plan
 * withdrawal function (lib/plan-withdrawal.ts) is offered with no end only
 * while Stripe could not be read at all, never on a reading that says "unknown"
 * because of the account's own data (a credit on the customer's balance, too
 * many payments, a payment that is not this store's); the page promises a full
 * refund only when the money-back guarantee gives one, and the receipt never
 * promises one, because it goes out before the refund is decided.
 *
 * Also held: the request that claims the refund leaves a note owed to support
 * before the flow runs (a request that dies there is never left with nobody
 * told), and a statement whose record was written but whose expiry could not
 * be set is not answered "your withdrawal was not sent".
 *
 * Against the stand-in Stripe and Resend of tests/plan-refund-stripe-world.ts
 * and the in-memory Redis; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST } from "@/app/api/billing/withdraw/route";
import StudioRefundPage from "@/app/studio/refund/page";
import { planWithdrawKey } from "@/lib/plan-withdrawal";
import { redisPipeline } from "@/lib/redis";
import { who } from "./plan-refund-route-world";
import { paidShop, world } from "./plan-refund-stripe-world";

const DAY = 86_400;
const REAL = Math.floor(Date.now() / 1000);
const NAME = "Ana Souza";
const ADDRESS = "ana.receipts@example.com";
const SUPPORT = "support@marktmorgen.com";
const FULL = "We refund your plan payment in full";

const page = async () => renderToStaticMarkup(await StudioRefundPage({ searchParams: Promise.resolve({}) }));
const post = async (fields: Record<string, string>) => {
  const response = await POST(new NextRequest("https://local.example/api/billing/withdraw", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  return new URL(response.headers.get("location")!).searchParams.get("withdraw");
};
const receipts = () => world.emails.filter((e) => e.to === ADDRESS && e.subject.includes("withdrawal"));

/** The customer's balance the stand-in Stripe answers with, and a hook run when a refund is asked for. */
let balance = 0;
let onRefund: (() => Promise<void>) | null = null;
let stripeDown = false;
/** The host a request goes to, read whole (never a substring of the URL). */
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (hostOf(url) === "api.stripe.com") {
    if (stripeDown) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    if (url.includes("/v1/refunds") && init?.method === "POST" && onRefund) await onRefund();
    const answer = await realFetch(input, init);
    if (balance !== 0 && /\/v1\/subscriptions\/sub_\w+\?/.test(url)) {
      const row = (await answer.json()) as { customer: unknown };
      if (row.customer && typeof row.customer === "object") (row.customer as { balance: number }).balance = balance;
      return new Response(JSON.stringify(row), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    return answer;
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  who.role = "owner";

  part("A credit on the balance, 200 days after paying: not offered, nothing promised (Claude 5's proof)");
  balance = -12_345;
  const credit = await paidShop({ at: REAL - 200 * DAY });
  who.store = await credit.store();
  world.emails = [];
  const creditPage = await page();
  is("control: the page says the refund needs a person (the credit)", creditPage.includes("credit from an earlier change of plan"), true);
  is("the function is not offered", creditPage.includes("Withdraw from contract here"), false);
  is("no full refund promised", creditPage.includes(FULL), false);
  is("a statement sent anyway is closed: nothing recorded, no receipt", [await post({ name: NAME, email: ADDRESS }), receipts().length], ["closed", 0]);
  balance = 0;

  part("Stripe not read at all: still offered with no end, but no full refund promised");
  const down = await paidShop({ at: REAL - 2 * DAY });
  who.store = await down.store();
  world.emails = [];
  stripeDown = true;
  const downPage = await page();
  const downState = await post({ name: NAME, email: ADDRESS });
  stripeDown = false;
  is("offered (never hidden on a guess)", downPage.includes("Withdraw from contract here"), true);
  is("the page does not promise a full refund it has not read", downPage.includes(FULL), false);
  is("recorded and handed to support", downState, "handled");
  is("the receipt went and promises no full refund", [receipts().length, receipts().some((e) => e.text.includes(FULL))], [1, false]);

  part("Under the guarantee: the page says the full refund; the receipt stays neutral");
  const kept = await paidShop({ at: REAL - 3 * DAY });
  who.store = await kept.store();
  world.emails = [];
  const keptPage = await page();
  is("the page promises the full refund the guarantee gives", keptPage.includes(FULL), true);
  let noteOwedAtRefund: unknown = "not asked";
  onRefund = async () => {
    noteOwedAtRefund = (await redisPipeline([["HGET", planWithdrawKey(who.store!.sid, kept.subId), "h"]]))[0];
  };
  const keptState = await post({ name: NAME, email: ADDRESS });
  onRefund = null;
  is("refunded through the existing flow", [keptState === "refunded" || keptState === "ending", kept.refunds().length], [true, 1]);
  is("the receipt promises no full refund (it goes before the refund is decided)", receipts().some((e) => e.text.includes(FULL)), false);
  is("while the flow runs, a note to support is already owed (a request that dies there leaves someone told)", typeof noteOwedAtRefund === "string" && (noteOwedAtRefund as string).length > 0, true);
  const after = (await redisPipeline([["HMGET", planWithdrawKey(who.store.sid, kept.subId), "h", "hd"]]))[0] as (string | null)[];
  is("once refunded, the note is no longer owed (marked done) and support was not emailed", [after[1], world.emails.filter((e) => e.to === SUPPORT).length], ["1", 0]);

  part("The expiry not set on a recorded statement: not answered 'not sent'");
  const slow = await paidShop({ at: REAL - 4 * DAY });
  who.store = await slow.store();
  world.emails = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answers = await pipeline(commands);
    return commands.map((c, i) => (c[0] === "EXPIRE" && commands.some((d) => d[0] === "HSETNX" && d[2] === "at") ? 0 : answers[i]));
  }) as typeof redis.pipeline;
  const slowState = await post({ name: NAME, email: ADDRESS });
  redis.pipeline = pipeline;
  const slowAt = (await redisPipeline([["HGET", planWithdrawKey(who.store.sid, slow.subId), "at"]]))[0];
  is("the statement is recorded and not answered 'error'", [typeof slowAt, slowState === "error"], ["string", false]);

  done();
}

main();
