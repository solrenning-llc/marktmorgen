/**
 * 647 [WG7], unit 1: the payment protection rules of a creator's store, pure
 * (lib/payment-risk.ts). Checked: the risk read off a charge's Stripe outcome,
 * never "low" and never "normal" when it cannot be read; the store's simple
 * rules read back whole or not at all; when the buyer's bank is asked to verify
 * a payment (3D Secure "any", the value lib/billing.ts already sends); and when
 * a physical order's shipping is held for review. Nothing here calls Stripe,
 * changes a price or touches a refund, an access or a cancellation.
 */
import { readFileSync } from "node:fs";
import {
  MAX_RULES,
  RISK_WORDS,
  STRIPE_MAX_CENTS,
  VERIFY_HINT,
  VERIFY_LABEL,
  asksVerification,
  parsePaymentRules,
  riskLevelOf,
  shippingDecision,
  threeDSecureFields,
} from "@/lib/payment-risk";
import { done, is, part } from "./check";

const charge = (risk_level: unknown) => ({ id: "ch_1", object: "charge", outcome: { type: "authorized", risk_level } });

part("The risk Stripe gave the charge, as the creator reads it");
is("normal, elevated and highest are read as they are", [riskLevelOf(charge("normal")), riskLevelOf(charge("elevated")), riskLevelOf(charge("highest"))], ["normal", "elevated", "highest"]);
is("not assessed or unknown by Stripe: not available, never normal", [riskLevelOf(charge("not_assessed")), riskLevelOf(charge("unknown"))], ["not_available", "not_available"]);
is("a value Stripe does not send (low, a number, a different case): not available", [riskLevelOf(charge("low")), riskLevelOf(charge(12)), riskLevelOf(charge("Normal"))], ["not_available", "not_available", "not_available"]);
is("no outcome, no charge, a bare id or another object: not available", [riskLevelOf({ id: "ch_1", object: "charge" }), riskLevelOf(null), riskLevelOf("ch_1"), riskLevelOf({ id: "pi_1", object: "payment_intent", outcome: { risk_level: "normal" } }), riskLevelOf({ id: "ch_1", object: "charge", outcome: "normal" })], ["not_available", "not_available", "not_available", "not_available", "not_available"]);
is("the words on the sales list and the order", RISK_WORDS, { normal: "Risk: normal", elevated: "Risk: elevated", highest: "Risk: highest", not_available: "Risk: not available" });
is("no word says low and none is a score", Object.values(RISK_WORDS).some((w) => /\blow\b|\d/.test(w)), false);

part(`A store's simple rules: at most ${MAX_RULES}, each kind once, read back whole or not at all`);
is("the three kinds read back", parsePaymentRules([{ kind: "verify_over", cents: 25_000 }, { kind: "verify_first_purchase" }, { kind: "hold_risky_shipping" }]), [{ kind: "verify_over", cents: 25_000 }, { kind: "verify_first_purchase" }, { kind: "hold_risky_shipping" }]);
is("no rules is a real answer: an empty list", parsePaymentRules([]), []);
is("only the fields we keep are read back", parsePaymentRules([{ kind: "verify_over", cents: 100, note: "x" }]), [{ kind: "verify_over", cents: 100 }]);
is("a kind twice, more than three, or a kind we do not have: nothing", [parsePaymentRules([{ kind: "verify_first_purchase" }, { kind: "verify_first_purchase" }]), parsePaymentRules([{ kind: "verify_over", cents: 1 }, { kind: "verify_first_purchase" }, { kind: "hold_risky_shipping" }, { kind: "verify_over", cents: 2 }]), parsePaymentRules([{ kind: "block_country" }])], [null, null, null]);
is("an amount that is not whole cents, zero, negative or past Stripe's largest charge: nothing", [parsePaymentRules([{ kind: "verify_over", cents: 10.5 }]), parsePaymentRules([{ kind: "verify_over", cents: 0 }]), parsePaymentRules([{ kind: "verify_over", cents: -5 }]), parsePaymentRules([{ kind: "verify_over", cents: STRIPE_MAX_CENTS + 1 }]), parsePaymentRules([{ kind: "verify_over", cents: "100" }])], [null, null, null, null, null]);
is("Stripe's largest charge itself is a threshold we keep", parsePaymentRules([{ kind: "verify_over", cents: STRIPE_MAX_CENTS }]), [{ kind: "verify_over", cents: STRIPE_MAX_CENTS }]);
is("not a list, or a list holding something else: nothing", [parsePaymentRules(null), parsePaymentRules({ kind: "verify_first_purchase" }), parsePaymentRules(["verify_first_purchase"]), parsePaymentRules([null])], [null, null, null, null]);

part("When the buyer's bank is asked to verify the payment");
const none = { productAsks: false, rules: [], amountCents: 5_000, firstPurchase: false };
is("off by default: no option and no rule asks nothing", asksVerification(none), false);
is("the product's own option asks", asksVerification({ ...none, productAsks: true }), true);
const over = [{ kind: "verify_over" as const, cents: 10_000 }];
is("above the rule's amount asks; at it or below does not", [asksVerification({ ...none, rules: over, amountCents: 10_001 }), asksVerification({ ...none, rules: over, amountCents: 10_000 }), asksVerification({ ...none, rules: over, amountCents: 9_999 })], [true, false, false]);
is("an amount we cannot read, under that rule, asks (unknown is never the cheap side)", [asksVerification({ ...none, rules: over, amountCents: null }), asksVerification({ ...none, rules: over, amountCents: Number.NaN }), asksVerification({ ...none, rules: over, amountCents: -1 }), asksVerification({ ...none, rules: over, amountCents: 1.5 })], [true, true, true, true]);
const first = [{ kind: "verify_first_purchase" as const }];
is("the first purchase of an address in a product asks; a later one does not", [asksVerification({ ...none, rules: first, firstPurchase: true }), asksVerification({ ...none, rules: first, firstPurchase: false })], [true, false]);
is("not knowing whether it is the first, under that rule, asks", asksVerification({ ...none, rules: first, firstPurchase: null }), true);
is("without those rules, an unreadable amount or first purchase asks nothing", asksVerification({ ...none, amountCents: null, firstPurchase: null }), false);
is("the shipping rule never asks the bank", asksVerification({ ...none, rules: [{ kind: "hold_risky_shipping" }], amountCents: null, firstPurchase: null }), false);

part("What goes on the checkout session: one field, the value our own plans already send");
is("asked: 3D Secure \"any\" on the card", threeDSecureFields(true), { "payment_method_options[card][request_three_d_secure]": "any" });
is("not asked: nothing is sent, Stripe keeps its own judgement", threeDSecureFields(false), {});
is("the value is the one lib/billing.ts sends for the yearly plan", /request_three_d_secure\]", "any"\)/.test(readFileSync("lib/billing.ts", "utf8")), true);
is("the option's words, with no percentage", [VERIFY_LABEL, VERIFY_HINT, /%|\d/.test(VERIFY_HINT)], ["Ask the buyer's bank to verify this payment", "Verification can reduce fraud and disputes, and some buyers may not finish paying.", false]);

part("Shipping a physical order: held for review only on a risky charge, under the store's rule");
const hold = [{ kind: "hold_risky_shipping" as const }];
is("elevated or highest: held; normal: shipped", [shippingDecision({ rules: hold, physical: true, risk: "elevated" }), shippingDecision({ rules: hold, physical: true, risk: "highest" }), shippingDecision({ rules: hold, physical: true, risk: "normal" })], ["hold", "hold", "ship"]);
is("a risk we cannot read is said as such, never as shipped clean", shippingDecision({ rules: hold, physical: true, risk: "not_available" }), "risk_not_available");
is("without the rule, or for something not shipped, nothing is held", [shippingDecision({ rules: [], physical: true, risk: "highest" }), shippingDecision({ rules: hold, physical: false, risk: "highest" })], ["ship", "ship"]);

part("Nothing here charges, refunds, cancels or closes an access");
const source = readFileSync("lib/payment-risk.ts", "utf8");
is("no Stripe call, no Redis, no fetch", /onAccount|stripeFetch|@\/lib\/redis|fetch\(/.test(source), false);
is("no refund, cancel or access word in what it decides", /refund|cancel|access/i.test(source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false);

done();
