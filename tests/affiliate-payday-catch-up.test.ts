/**
 * A payday the daily run did not reach is still kept on the next days of the month (#4620, part 1).
 *
 * sendPaydayEmails handled a store only when its payday was today's date. The run stops at its deadline, and a page
 * of stores that does not read threw out of the loop, so a store the run did not reach on its payday got no payday
 * email and, with auto-pay, no pay, and the next day its payday was no longer today: it waited a whole month. A store
 * is now due on its payday and the PAYDAY_CATCH_UP_DAYS days after it in the same month, while the month's claim
 * (claimMonth) is not taken, so nothing is ever sent twice; and a page that does not read ends the run as not
 * complete instead of throwing.
 *
 * A store that pays by itself is pressed once a month at most (Claude 6 on #4488): payday's auto-pay takes no
 * integration unit and is priced once a month (PAYPAL_PRESSES_UNTAKEN). In the worst month the store's email figure is
 * used up, so the payday email is refused; the month must still be kept, or the next day's run claims it again and
 * presses again. Whoever was not paid stays owed, for the next payday or the studio's press.
 *
 * Synthetic store, affiliate and sale; Resend and PayPal are stand-ins that keep what was asked; MemoryRedis.
 */
import { mock } from "node:test";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import * as paydayJob from "@/lib/affiliate-payday";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { connectPayPal, onTheirWay, payableLines, setAutoPay } from "@/lib/paypal-payouts";
import { readBook } from "@/lib/affiliates";
import { forceAllowance } from "@/lib/store-allowance";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = new Date(Date.UTC(2026, 10, 15, 14));
mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
process.env.STRIPE_SECRET_KEY = "sk_test_payday_catch_up_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const sent: string[] = [];
const CLIENT = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const SECRET = "EFGHijklMNOPqrstUVWXyz0123456789abcd";
/** Every batch PayPal was asked to make: each is a press that reached PayPal. */
let presses = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api-m.paypal.com") {
    if (url.pathname === "/v1/oauth2/token") {
      return new Response(JSON.stringify({ access_token: "A21AAtoken", token_type: "Bearer", scope: "https://uri.paypal.com/payments/payouts openid", expires_in: 32400 }));
    }
    if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
      presses += 1;
      // Refused before anything was made: nobody is paid, so everyone stays owed and a second press would find them.
      return new Response(JSON.stringify({ name: "INSUFFICIENT_FUNDS", message: "Sender does not have sufficient funds." }), { status: 422 });
    }
    return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND" }), { status: 404 });
  }
  if (url.hostname === "api.resend.com") {
    sent.push(String((JSON.parse(String(init?.body ?? "{}")) as { subject?: string }).subject));
    return new Response(JSON.stringify({ id: `email_${sent.length}` }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const OWNER = "payday-owner@example.com";
const DAY = 86_400;
const T0 = Math.floor(NOW.getTime() / 1000) - 400 * DAY;

async function storeWithPayday(day: number): Promise<void> {
  redis.clear();
  sent.length = 0;
  presses = 0;
  await claimHandle(OWNER, "paydaystore", "Payday Store", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPayday01", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, payday: day }));
  const statsId = (await storeForEmail(OWNER))!.statsId!;
  const aff = "a1a1a1a1a1a1";
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, aff, JSON.stringify({ id: aff, email: `${aff}@example.com`, code: "a1a1a", status: "approved", appliedAt: T0 * 1000, decidedAt: T0 * 1000, note: "" })],
    ["HSET", `nl:aff:${statsId}:sales`, "cs_1", JSON.stringify({ ref: "cs_1", pi: "pi_cs_1", aff, at: T0 + 10 * DAY, product: "prod01", title: "Bread course", base: 1000, total: 1000, currency: "usd", rate: 20, self: false, how: "click" })],
  ]);
}

const { sendPaydayEmails } = paydayJob;
const { PAYDAY_CATCH_UP_DAYS } = paydayJob;
const run = () => sendPaydayEmails(Date.now() + 20_000, NOW);

async function main(): Promise<void> {
  part("A payday two days ago that no run reached");
  await storeWithPayday(13);
  const late = await run();
  is("the payday email goes today", [late.sent, sent.length], [1, 1]);
  is("and a second run sends nothing more (the month's claim)", (await run()).sent, 0);

  part("Control: a payday today still goes, and one long past waits for next month");
  await storeWithPayday(15);
  is("today's payday", (await run()).sent, 1);
  await storeWithPayday(15 - PAYDAY_CATCH_UP_DAYS - 1);
  is("a payday past the catch-up days is not sent this late", (await run()).sent, 0);
  await storeWithPayday(16);
  is("a payday later this month is not sent early", (await run()).sent, 0);

  part("A page of stores that does not read ends the run as not complete");
  await storeWithPayday(15);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "SCAN")) return [["0", "not a list"]];
    return pipeline(commands);
  }) as typeof redis.pipeline;
  const odd = await run().catch(() => "threw" as const);
  redis.pipeline = pipeline;
  is("no throw out of the run", odd === "threw", false);
  is("said not complete", odd !== "threw" && odd.complete, false);

  part("Auto-pay in the worst month: the payday email refused, the month still kept, one press");
  for (const emailUsedUp of [true, false]) {
    mock.timers.setTime(NOW.getTime());
    await storeWithPayday(13);
    const store = (await storeForEmail(OWNER))!;
    is(`${emailUsedUp ? "used up" : "control"}: PayPal connected`, (await connectPayPal(store, CLIENT, SECRET)).ok, true);
    is(`${emailUsedUp ? "used up" : "control"}: paying by itself`, await setAutoPay(store, true), true);
    if (emailUsedUp) is("the store's email figure used up", await forceAllowance(store, "email", 1_000_000), true);
    const first = await run();
    is(`${emailUsedUp ? "used up" : "control"}: the 15th presses once`, [first.due, presses], [1, 1]);
    is(`${emailUsedUp ? "used up" : "control"}: the payday email ${emailUsedUp ? "refused" : "sent"}`, sent.length, emailUsedUp ? 0 : 1);
    mock.timers.setTime(NOW.getTime() + DAY * 1000);
    await sendPaydayEmails(Date.now() + 20_000, new Date(Date.now()));
    is(`${emailUsedUp ? "used up" : "control"}: a run one day later does not press again`, presses, 1);
    const book = await readBook(store);
    is(`${emailUsedUp ? "used up" : "control"}: nobody paid is still owed, never dropped`, payableLines(book, await onTheirWay(store)).length, 1);
  }
  mock.timers.setTime(NOW.getTime());

  part("Auto-pay: the month is kept before the press, and a month not kept is not pressed");
  const pipeline2 = redis.pipeline.bind(redis);
  async function autoPayStore(): Promise<Awaited<ReturnType<typeof storeForEmail>> & object> {
    mock.timers.setTime(NOW.getTime());
    await storeWithPayday(13);
    const store = (await storeForEmail(OWNER))!;
    await connectPayPal(store, CLIENT, SECRET);
    await setAutoPay(store, true);
    return store;
  }
  const nextDay = async () => {
    mock.timers.setTime(NOW.getTime() + DAY * 1000);
    await sendPaydayEmails(Date.now() + 20_000, new Date(Date.now()));
  };
  {
    // A run stopped as its press begins: the month was already kept, so no later run this month presses; the affiliate
    // stays owed. The press's link read fails here. Since #2844 the press catches it (an unknown link pays nothing and
    // answers "error", rule 24) instead of letting it throw out of the run, so the error injected here is an unknown
    // the press handled, not a stop; payday counts a press that answered "error" as FAILED, not as sent, so the owner's
    // report still sees a payday that paid nothing by an error (HOLD 6922548572 on #2844 and the author's decision
    // after it). Its "could not pay" email goes once, on the run, and never again that month.
    const store = await autoPayStore();
    const emailsBefore = sent.length;
    let linkReads = 0;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => c[0] === "GET" && c[1] === `nl:pp:${store.statsId}`) && ++linkReads === 2) throw new Error("the run stopped here");
      return pipeline2(commands);
    }) as typeof redis.pipeline;
    const stopped = await run();
    redis.pipeline = pipeline2;
    is("stopped mid-press: counted failed, nothing pressed", [stopped.failed, presses], [1, 0]);
    is("and not counted as sent; its email went once", [stopped.sent, sent.length - emailsBefore], [0, 1]);
    await nextDay();
    is("and a run one day later does not press: one press a month at most", presses, 0);
    is("nor sends that email again", sent.length - emailsBefore, 1);
    is("the affiliate is still owed, for the next payday or the studio's press", payableLines(await readBook(store), await onTheirWay(store)).length, 1);
  }
  {
    // The month could not be confirmed kept: nothing is pressed, the hold runs out, and the next day's run pays.
    const store = await autoPayStore();
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((c) => (c[0] === "EXPIRE" || (c[0] === "SET" && c[2] === "kept")) && String(c[1]).startsWith("nl:aff:payday:"))) throw new Error("no answer");
      return pipeline2(commands);
    }) as typeof redis.pipeline;
    const unkept = await run();
    redis.pipeline = pipeline2;
    is("not kept: counted failed, nothing pressed", [unkept.failed, presses], [1, 0]);
    await nextDay();
    is("the next day's run presses once", presses, 1);
    is("and keeps the month: a run after it does not press again", await (async () => {
      mock.timers.setTime(NOW.getTime() + 2 * DAY * 1000);
      await sendPaydayEmails(Date.now() + 20_000, new Date(Date.now()));
      return presses;
    })(), 1);
    is("its affiliate still owed after PayPal refused (never dropped)", payableLines(await readBook(store), await onTheirWay(store)).length, 1);
  }
  mock.timers.setTime(NOW.getTime());

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
