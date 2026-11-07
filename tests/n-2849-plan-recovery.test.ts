/**
 * The EU withdrawal function for Marktmorgen's own plans (588 [KB9] unit 3,
 * Directive 2011/83/EU art. 11a; the owner's decision: a creator who buys a
 * plan is a consumer): lib/plan-withdrawal.ts, its route
 * (app/api/billing/withdraw) and its place on the plan refund page
 * (app/studio/refund), against the stand-in Stripe and Resend of
 * tests/plan-refund-stripe-world.ts. The signed-in creator is set by the test
 * (tests/plan-refund-route-world.ts). Nothing real is reached.
 *
 * What fails here:
 *   - inside the 14 days, the function missing, its labels not the law's, a
 *     name not asked for, or the owner's address not filled in;
 *   - "Confirm withdrawal" that does not record the withdrawal once, email
 *     the receipt with what was sent and when, and give the payment back in
 *     full through the existing refund flow;
 *   - a second statement that refunds again or sends the receipt again;
 *   - a receipt that did not go and is not sent again on the next statement,
 *     or one tried more than 3 times;
 *   - the function offered after the 14 days, or used by someone who is not
 *     the store's owner;
 *   - a refund the money-back guarantee does not give made anyway, or such a
 *     withdrawal left with nobody to handle it;
 *   - an answer from the store's data that does not read taken as "not
 *     withdrawn" or as success;
 *   - the name or the email put in the address bar.
 */
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST } from "@/app/api/billing/withdraw/route";
import StudioRefundPage from "@/app/studio/refund/page";
import { PLAN_WITHDRAW_ACK_SENDS, planWithdrawKey, planWithdrawal, withdrawFromPlan } from "@/lib/plan-withdrawal";
import { redisPipeline } from "@/lib/redis";
import { who } from "./plan-refund-route-world";
import { paidShop, world } from "./plan-refund-stripe-world";

const DAY = 86_400;
/** The page and the route read the real clock, so the payments are set from it. */
const REAL = Math.floor(Date.now() / 1000);
const NAME = "Ana Souza";
const ADDRESS = "ana.receipts@example.com";
const SUPPORT = "support@marktmorgen.com";

const page = async (query: Record<string, string> = {}) => renderToStaticMarkup(await StudioRefundPage({ searchParams: Promise.resolve(query) }));
const post = async (fields: Record<string, string>) => {
  const response = await POST(new NextRequest("https://local.example/api/billing/withdraw", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const to = new URL(response.headers.get("location")!);
  return { status: response.status, page: to.pathname, state: to.searchParams.get("withdraw"), location: response.headers.get("location")! };
};
const recordOf = async (sid: string, sub: string) => (await redisPipeline([["HMGET", planWithdrawKey(sid, sub), "at", "tries", "sent"]]))[0] as (string | null)[];
const receipts = () => world.emails.filter((e) => e.subject.includes("withdrawal"));

/** Refuses the next `n` emails at the stand-in Resend, counting every try of a receipt (subject naming the withdrawal). */
let refuse = 0;
let receiptTries = 0;
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
  if (hostOf(url) === "api.resend.com") {
    const subject = String((JSON.parse(String(init?.body ?? "{}")) as { subject?: string }).subject ?? "");
    if (subject.includes("withdrawal")) receiptTries += 1;
    if (refuse > 0) {
      refuse -= 1;
      return new Response(JSON.stringify({ message: "unavailable" }), { status: 500 });
    }
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  who.role = "owner";

  part("Inside the 14 days: offered, in the law's words");
  const a = await paidShop({ at: REAL - 3 * DAY });
  who.store = await a.store();
  const offered = await page();
  is("the function, labeled as the law says", offered.includes("Withdraw from contract here"), true);
  is("its confirmation, labeled as the law says", offered.includes("Confirm withdrawal"), true);
  const nameField = offered.match(/<input[^>]*name="name"[^>]*>/)?.[0] ?? "";
  is("a name is asked for, and required", [nameField !== "", /\brequired\b/.test(nameField)], [true, true]);
  const emailField = offered.match(/<input[^>]*name="email"[^>]*>/)?.[0] ?? "";
  is("the owner's address is filled in and can be changed", [emailField.includes(`value="${who.store.email}"`), /\breadonly\b|\bdisabled\b/.test(emailField)], [true, false]);
  is("the contract is named: the subscription", offered.includes(a.subId), true);
  is("the form posts to the withdrawal route, with no script needed", /<form[^>]*action="\/api\/billing\/withdraw\?store=[^"]+"[^>]*method="post"/.test(offered), true);
  is("each hint is tied to its field", (offered.match(/aria-describedby="[^"]+"/g) ?? []).length >= 2, true);

  part("Confirm withdrawal: recorded once, receipt sent, refunded in full");
  world.emails = [];
  const first = await post({ name: NAME, email: ADDRESS });
  is("told on the refund page", [first.status, first.page, first.state], [303, "/studio/refund", "refunded"]);
  is("the name and the email never go in the address", [first.location.includes("Ana"), first.location.includes("@") || first.location.includes("%40")], [false, false]);
  const kept = await recordOf(who.store.sid, a.subId);
  is("the withdrawal is recorded with its time, its receipt marked sent", [typeof kept[0] === "string" && /^\d+$/.test(kept[0]), kept[1], kept[2]], [true, "1", "1"]);
  is("one receipt, to the address given", receipts().map((e) => e.to), [ADDRESS]);
  const receipt = receipts()[0];
  is("the receipt says what was sent and when", [NAME, a.subId, ADDRESS, " UTC"].every((s) => receipt.text.includes(s)), true);
  is("the whole payment back, once, through the refund flow", a.refunds().map((r) => r.amount), [6_900]);
  is("the plan ended", [a.sub().status, (await a.store()).subscriptionActive], ["canceled", false]);
  is("the refund's own confirmation reaches the store's address", world.emails.some((e) => e.to === who.store!.email && e.subject.endsWith("your plan payment was refunded")), true);
  is("support is not asked to do what was done", world.emails.some((e) => e.to === SUPPORT), false);

  part("A second statement: nothing again");
  who.store = await a.store();
  const again = await post({ name: NAME, email: ADDRESS });
  is("already done", again.state, "already");
  is("no second refund, no second receipt", [a.refunds().length, receipts().length], [1, 1]);
  const after = await page({ withdraw: "already" });
  is("the page says it was done and offers no second one", [after.includes("You withdrew from your plan on"), after.includes("Confirm withdrawal")], [true, false]);
  is("its notice is a status", /role="status"[^>]*data-withdraw-done="already"|data-withdraw-done="already"[^>]*role="status"/.test(after), true);

  part("A receipt that did not go is sent again, at most 3 times");
  const b = await paidShop({ at: REAL - 2 * DAY });
  who.store = await b.store();
  world.emails = [];
  refuse = 1;
  const unsent = await post({ name: NAME, email: ADDRESS });
  is("recorded and refunded although the receipt did not go", [unsent.state, b.refunds().length, (await recordOf(who.store.sid, b.subId))[2]], ["refunded", 1, null]);
  who.store = await b.store();
  const retry = await page();
  is("the page says the receipt has not gone and offers to send it", [retry.includes("We could not email your receipt yet"), retry.includes("Confirm withdrawal")], [true, true]);
  const resent = await post({ name: NAME, email: ADDRESS });
  is("the next statement sends it, with the first statement's time; nothing refunded again", [resent.state, receipts().length, b.refunds().length], ["resent", 1, 1]);
  is("then nothing more", (await post({ name: NAME, email: ADDRESS })).state, "already");

  const c = await paidShop({ at: REAL - 2 * DAY });
  who.store = await c.store();
  receiptTries = 0;
  refuse = 1_000;
  const states: (string | null)[] = [];
  for (let i = 0; i < PLAN_WITHDRAW_ACK_SENDS + 2; i += 1) states.push((await post({ name: NAME, email: ADDRESS })).state);
  refuse = 0;
  is("the ceiling is the law's 3 tries", PLAN_WITHDRAW_ACK_SENDS, 3);
  is("tried 3 times in all, then no more", [states, receiptTries], [["refunded", "unsent", "unsent", "already", "already"], 3]);
  is("refunded once", c.refunds().length, 1);

  part("After the 14 days: not offered");
  const d = await paidShop({ at: REAL - 20 * DAY });
  who.store = await d.store();
  const late = await page();
  is("inside the money-back days but past the 14: no function", [late.includes("Withdraw from contract here"), late.includes("Confirm withdrawal")], [false, false]);
  world.emails = [];
  const closed = await post({ name: NAME, email: ADDRESS });
  is("a statement sent anyway: closed, nothing recorded, refunded or sent", [closed.state, (await recordOf(who.store.sid, d.subId))[0], d.refunds().length, world.emails.length], ["closed", null, 0, 0]);
  const e = await paidShop({ at: REAL - 40 * DAY });
  who.store = await e.store();
  is("long after: no function either", (await page()).includes("Withdraw from contract here"), false);

  part("Only the store's owner");
  const f = await paidShop({ at: REAL - 2 * DAY });
  who.store = await f.store();
  who.role = "admin";
  world.emails = [];
  const asAdmin = await post({ name: NAME, email: ADDRESS });
  is("an admin: refused before anything", [asAdmin.state, (await recordOf(who.store.sid, f.subId))[0], f.refunds().length, world.emails.length], ["owner", null, 0, 0]);
  is("and the page offers it no form", (await page()).includes("Confirm withdrawal"), false);
  who.role = "owner";

  part("The statement must read");
  is("no name: nothing recorded", [(await post({ name: "  ", email: ADDRESS })).state, (await recordOf(who.store.sid, f.subId))[0]], ["form", null]);
  is("an email that does not read: nothing recorded", [(await post({ name: NAME, email: "not an email" })).state, (await recordOf(who.store.sid, f.subId))[0]], ["form", null]);

  part("When the guarantee cannot be read: recorded, receipt sent, support handles the refund");
  const g = await paidShop({ at: REAL - 2 * DAY });
  who.store = await g.store();
  const writesBefore = world.calls.filter((call) => call.startsWith("POST /refunds")).length;
  const stripeDown = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.stripe.com/v1/charges")) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
    return stripeDown(input, init);
  }) as typeof fetch;
  world.emails = [];
  const unknownPage = await page();
  const handled = await post({ name: NAME, email: ADDRESS });
  globalThis.fetch = stripeDown;
  is("the function stays offered while the time cannot be read (never hidden on a guess)", unknownPage.includes("Withdraw from contract here"), true);
  is("recorded, the receipt sent, said to be handled", [handled.state, typeof (await recordOf(who.store.sid, g.subId))[0], receipts().length], ["handled", "string", 1]);
  is("no refund made outside the existing flow's reading", [g.refunds().length, world.calls.filter((call) => call.startsWith("POST /refunds")).length - writesBefore], [0, 0]);
  is("support is told once, with the subscription", world.emails.filter((m) => m.to === SUPPORT).map((m) => m.text.includes(g.subId)), [true]);
  is("a later statement does not tell support again", [(await post({ name: NAME, email: ADDRESS })).state, world.emails.filter((m) => m.to === SUPPORT).length], ["already", 1]);

  part("A reply from the store's data that does not read is never success");
  const h = await paidShop({ at: REAL - 2 * DAY });
  const shopH = await h.store();
  const pipeline = redis.pipeline.bind(redis);
  for (const [what, bad] of [["the record's fields", (cmd: (string | number)[]) => cmd[0] === "HMGET"], ["the write's answer", (cmd: (string | number)[]) => cmd[0] === "HSETNX"]] as const) {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (commands.some((cmd) => bad(cmd) && String(cmd[1]).startsWith("nl:plan-withdraw:"))) return commands.map(() => ["not", "a", "reply"]);
      return pipeline(commands);
    }) as typeof redis.pipeline;
    world.emails = [];
    const outcome = await withdrawFromPlan(shopH, { name: NAME, reference: h.subId, email: ADDRESS }).catch(() => "threw");
    redis.pipeline = pipeline;
    is(`${what} out of shape: an error, nothing refunded, nothing sent`, [["error", "threw"].includes(outcome), h.refunds().length, world.emails.length], [true, 0, 0]);
  }
  redis.pipeline = (async (commands: (string | number)[][]) => (commands.some((cmd) => cmd[0] === "HMGET") ? [[1, 2]] : pipeline(commands))) as typeof redis.pipeline;
  const unread = await planWithdrawal(shopH).then(() => "read", () => "threw");
  redis.pipeline = pipeline;
  is("reading whether it was withdrawn: unknown throws, never 'not withdrawn'", unread, "threw");
  is("and a statement whose subscription is not the store's is refused", await withdrawFromPlan(shopH, { name: NAME, reference: "sub_someoneelse01", email: ADDRESS }), "error");

  part("N independent recovery: support transport refusal cannot silently strand a declaration");
  // Finite fixture: two route submissions, one temporary Stripe-read failure,
  // and one refused support delivery. All IO remains the author's synthetic world.
  const recoveryShop = await paidShop({ at: REAL - DAY });
  who.store = await recoveryShop.store();
  world.emails = [];
  const beforeRecovery = globalThis.fetch;
  let refusedSupport = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.stripe.com/v1/charges")) return new Response(JSON.stringify({ error: { message: "Synthetic temporary read outage" } }), { status: 500 });
    if (hostOf(url) === "api.resend.com") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
      if ([body.to].flat().includes(SUPPORT)) {
        refusedSupport++;
        return new Response(JSON.stringify({ message: "Synthetic temporary support outage" }), { status: 503 });
      }
    }
    return beforeRecovery(input, init);
  }) as typeof fetch;
  let refusedHandoff: Awaited<ReturnType<typeof post>>;
  try { refusedHandoff = await post({ name: NAME, email: ADDRESS }); }
  finally { globalThis.fetch = beforeRecovery; }
  const supportBefore = world.emails.filter((m) => m.to === SUPPORT).length;
  const recordBefore = await planWithdrawal(who.store);
  is("N precondition: one support email was refused and none accepted", [refusedSupport, supportBefore], [1, 0]);
  is("N precondition: declaration and buyer receipt exist, no refund moved", [typeof recordBefore.at, recordBefore.sent, recoveryShop.refunds().length], ["number", true, 0]);
  is("N precondition: no existing refund-flow note can resume this branch", await recoveryShop.note(), null);
  is("N failed support handoff is not reported as handled", refusedHandoff!.state === "handled", false);
  const recoveredHandoff = await post({ name: NAME, email: ADDRESS });
  const supportAfter = world.emails.filter((m) => m.to === SUPPORT).length;
  console.log("N_PLAN_HANDOFF", JSON.stringify({ first: refusedHandoff!.state, second: recoveredHandoff.state, supportBefore, supportAfter, refunds: recoveryShop.refunds().length, refundFlag: (await planWithdrawal(who.store)).refund, note: await recoveryShop.note() }));
  is("N healthy repeat recovers support handoff or the existing refund flow", supportAfter > 0 || recoveryShop.refunds().length > 0, true);

  done();
}

void main();
