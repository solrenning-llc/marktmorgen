/**
 * #4399 (Codex X4, money, studio): a URL parameter alone never makes the studio say that a payment account is
 * ready or that a subscription was canceled or resumed. "Ready" holds only when the store's own record says so
 * (written by the route that asked Stripe or PayPal); a cancel or a resume only when the billing route left its
 * short answer for this store (lib/told-receipt.ts). Notices that confirm nothing pass as before. Synthetic only.
 */
import { readFileSync } from "node:fs";
import { tell, urlNoticeHolds } from "@/lib/told-receipt";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const base = { sid: "sidnotice01", stripeAccountId: null, stripeChargesEnabled: false, paypalSeller: null } as unknown as Store;
const shop = (over: Partial<Store>) => ({ ...base, ...over }) as Store;

async function main() {
  redis.clear();
  part("Stripe and PayPal: ready only as the store's record says");
  is("stripe=ready on a store with no account: not shown", await urlNoticeHolds("stripe", "ready", base), false);
  is("stripe=ready on an account Stripe has not cleared: not shown", await urlNoticeHolds("stripe", "ready", shop({ stripeAccountId: "acct_1TestNotice001" })), false);
  is("stripe=ready on a cleared account: shown", await urlNoticeHolds("stripe", "ready", shop({ stripeAccountId: "acct_1TestNotice001", stripeChargesEnabled: true })), true);
  is("paypal=ready with no PayPal account on record: not shown", await urlNoticeHolds("paypal", "ready", base), false);
  is("paypal=ready with the account on record: shown", await urlNoticeHolds("paypal", "ready", shop({ paypalSeller: { merchant: "ABCDEFGH12", at: 1 } })), true);
  is("no store: nothing that confirms is shown", await urlNoticeHolds("stripe", "ready", null), false);

  part("Billing: canceled or resumed only after the route said so for this store");
  for (const value of ["canceling", "resumed"]) {
    is(`billing=${value} from the address alone: not shown`, await urlNoticeHolds("billing", value, base), false);
  }
  await tell(base.sid, "billing", "canceling");
  is("billing=canceling after the route's answer: shown", await urlNoticeHolds("billing", "canceling", base), true);
  is("billing=resumed while the route's answer was canceling: not shown", await urlNoticeHolds("billing", "resumed", base), false);
  is("another store's answer is not this store's", await urlNoticeHolds("billing", "canceling", shop({ sid: "sidnotice02" })), false);
  const [ttl] = await redis.pipeline([["TTL", `nl:told:billing:${base.sid}`]]);
  is("the answer is short-lived (10 minutes at most)", typeof ttl === "number" && ttl > 0 && ttl <= 600, true);

  part("Notices that confirm nothing are unchanged");
  for (const [kind, value] of [["stripe", "pending"], ["stripe", "error"], ["paypal", "error"], ["billing", "cancel-error"], ["billing", "none"]] as const) {
    is(`${kind}=${value}: shown as before`, await urlNoticeHolds(kind, value, base), true);
  }

  part("The routes leave the answer and the studio asks before it speaks");
  const page = readFileSync("app/studio/page.tsx", "utf8");
  is("the studio passes the Stripe, PayPal and billing notices through urlNoticeHolds", ["\"stripe\"", "\"paypal\"", "\"billing\""].every((k) => new RegExp(`urlNoticeHolds\\(${k}`).test(page)), true);
  const cancel = readFileSync("app/api/billing/cancel/route.ts", "utf8");
  is("the cancel route leaves its answer before it redirects", /tell\(store\.sid, "billing"/.test(cancel), true);
  const refund = readFileSync("app/api/billing/refund/route.ts", "utf8");
  is("the refund route leaves its answer before it redirects", /tell\(store\.sid, "refund"/.test(refund), true);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
