/**
 * A plan withdrawal's receipt whose send is not known (audit "envio incerto", 9 November 2026; rule 30):
 * lib/plan-withdrawal.ts:185 used to read an uncertain send (a server error, a timeout) as "not sent", so the next
 * statement sent the receipt again, up to PLAN_WITHDRAW_ACK_SENDS copies, and the studio said "We could not email
 * your receipt yet. Confirm again below to get it." Now an uncertain receipt is kept as not confirmed: never tried
 * again, and the page and the notice say it may have gone. A certain refusal (422) is tried again, as before.
 *
 * Against the stand-in Stripe and Resend of tests/plan-refund-stripe-world.ts and the in-memory Redis.
 */
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { POST } from "@/app/api/billing/withdraw/route";
import StudioRefundPage from "@/app/studio/refund/page";
import { planWithdrawal } from "@/lib/plan-withdrawal";
import { PLAN_WITHDRAW_WORDS } from "@/lib/plan-withdrawal-words";
import { who } from "./plan-refund-route-world";
import { paidShop, world } from "./plan-refund-stripe-world";

const DAY = 86_400;
const REAL = Math.floor(Date.now() / 1000);
const NAME = "Ana Souza";
const ADDRESS = "ana.receipts@example.com";

const page = async (query: Record<string, string> = {}) => renderToStaticMarkup(await StudioRefundPage({ searchParams: Promise.resolve(query) }));
const post = async (fields: Record<string, string>) => {
  const response = await POST(new NextRequest("https://local.example/api/billing/withdraw", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  return new URL(response.headers.get("location")!).searchParams.get("withdraw");
};

let receiptTries = 0;
let sender: "ok" | "uncertain" | "refused" = "ok";
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
    if (subject.includes("withdrawal")) {
      receiptTries += 1;
      if (sender === "uncertain") return new Response(JSON.stringify({ message: "internal" }), { status: 500 });
      if (sender === "refused") return new Response(JSON.stringify({ message: "invalid" }), { status: 422 });
    }
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_a_stand_in_key_for_tests_only";
  who.role = "owner";

  part("A receipt that may have gone is never sent again (lib/plan-withdrawal.ts:185)");
  const a = await paidShop({ at: REAL - 3 * DAY });
  who.store = await a.store();
  world.emails = [];
  receiptTries = 0;
  sender = "uncertain";
  const first = await post({ name: NAME, email: ADDRESS });
  sender = "ok";
  is("recorded and refunded; one receipt asked for", [first === "refunded" || first === "ending", receiptTries], [true, 1]);
  who.store = await a.store();
  const kept = await planWithdrawal(who.store);
  is("kept as not confirmed, never as sent", [kept.sent, kept.unsure], [false, true]);
  const studio = await page();
  is("the studio says it may have gone and does not ask to confirm again for it", [
    studio.includes(PLAN_WITHDRAW_WORDS.receiptUnsure),
    studio.includes(PLAN_WITHDRAW_WORDS.receiptUnsent),
    studio.includes(PLAN_WITHDRAW_WORDS.receiptGiveUp),
  ], [true, false, false]);
  const again = await post({ name: NAME, email: ADDRESS });
  is("a second statement sends nothing again", [again, receiptTries], ["already", 1]);

  part("The words");
  is("a notice for it, not the words of a known failure", [Boolean(PLAN_WITHDRAW_WORDS.notices.unsure), PLAN_WITHDRAW_WORDS.notices.unsure?.body === PLAN_WITHDRAW_WORDS.notices.unsent.body], [true, false]);
  is("it says it is not sent again", (PLAN_WITHDRAW_WORDS.receiptUnsure ?? "").includes("We do not send it again, so you do not get two copies"), true);

  part("Control: a certain refusal is tried again on the next statement");
  const b = await paidShop({ at: REAL - 2 * DAY });
  who.store = await b.store();
  receiptTries = 0;
  sender = "refused";
  const refused = await post({ name: NAME, email: ADDRESS });
  sender = "ok";
  who.store = await b.store();
  is("recorded, the page offers it again", [refused === "refunded" || refused === "ending", (await page()).includes(PLAN_WITHDRAW_WORDS.receiptUnsent)], [true, true]);
  const resent = await post({ name: NAME, email: ADDRESS });
  is("the next statement sends it", [resent, receiptTries], ["resent", 2]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
