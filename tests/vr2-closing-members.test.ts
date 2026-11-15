/**
 * What happens to a closing store's members, said as the code and the Terms do it (VR, item 2; finding of session
 * 5FNwB on main, passed on by the coordinator, 15 November 2026). RED before the fix: the help center
 * (lib/help-content.ts) and the plan refund's list of effects (lib/plan-refund-words.ts) told the creator that the
 * memberships and payment plans sold through the store "are stopped at Stripe, each at the end of the period already
 * paid; refunds stay your decision". The code (lib/closing-holds.ts, lib/plan-closing.ts) and the Terms
 * (app/terms/page.tsx #closing-members) do otherwise: their collection is paused on the creator's own Stripe account
 * from the day the plan ends, every one of them ends on the closing day, and the part of a member's last payment that
 * paid for time after that day is refunded automatically from the creator's Stripe account, if its balance covers it
 * and the creator has not refunded it already.
 */
import { readFileSync } from "node:fs";
import { refundEffects } from "@/lib/plan-refund-words";
import { done, is, part } from "./check";

const help = readFileSync("lib/help-content.ts", "utf8").replace(/\s+/g, " ");
const effects = refundEffects({ assistant: false }).join(" ");
const terms = readFileSync("app/terms/page.tsx", "utf8").replace(/\s+/g, " ");

part("Control: the Terms say it as the code does");
is("the Terms refund the time after the closing day automatically", terms.includes("refunded automatically from the creator&rsquo;s own Stripe account"), true);

for (const [where, text] of [["the help center", help], ["the plan refund's effects", effects]] as const) {
  part(`${where} says it the same way`);
  is("never that each stops at the end of the period already paid", text.includes("each at the end of the period already paid"), false);
  is("never that refunds stay the creator's decision", text.includes("refunds stay your decision"), false);
  is("collection paused on the creator's own Stripe account", /collection is paused on your own Stripe account/.test(text), true);
  is("every membership and payment plan ends on the closing day", /every membership and payment plan you sold through it ends/i.test(text), true);
  is("the time paid for after that day is refunded automatically, if the balance covers it", text.includes("is refunded automatically from your Stripe account, if its balance covers it and you have not refunded it already"), true);
  is("Marktmorgen never pays them", text.includes("Marktmorgen never pays these refunds"), true);
}
done();
