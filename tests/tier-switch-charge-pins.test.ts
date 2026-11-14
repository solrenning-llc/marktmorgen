/**
 * A member moving to another tier pays what the page showed (lib/tier-switch.ts): the preview Stripe prices and the
 * update that charges carry the same proration second, the same item and the same price, so the charge is the one the
 * buyer saw; a retry of the same switch sends the same Idempotency-Key, so Stripe never charges twice; and the
 * receipt's amount is read exactly (chargedOf). These four were reached only through the routes, or not at all.
 * Pure values only.
 */
import { chargedOf, previewBody, switchBody, switchKey } from "@/lib/tier-switch";
import { done, is, part } from "./check";

const AT = 1_793_880_000;
const preview = previewBody("cus_pinsTier01", "sub_pinsTier01", "si_pinsTier01", "price_gold01", AT);
const update = switchBody("si_pinsTier01", "price_gold01", AT);

part("The charge is the one the preview priced");
is("the same item", [preview.get("subscription_details[items][0][id]"), update.get("items[0][id]")], ["si_pinsTier01", "si_pinsTier01"]);
is("the same price", [preview.get("subscription_details[items][0][price]"), update.get("items[0][price]")], ["price_gold01", "price_gold01"]);
is("the same proration second", [preview.get("subscription_details[proration_date]"), update.get("proration_date")], [String(AT), String(AT)]);
is("both charge the difference at once", [preview.get("subscription_details[proration_behavior]"), update.get("proration_behavior")], ["always_invoice", "always_invoice"]);
is("the preview is for this member's own subscription", [preview.get("customer"), preview.get("subscription")], ["cus_pinsTier01", "sub_pinsTier01"]);
is("the update is made only if it is paid, and returns its invoice", [update.get("payment_behavior"), update.getAll("expand[]")], ["pending_if_incomplete", ["latest_invoice"]]);
is("nothing else is sent with the update", [...update.keys()].sort(), ["expand[]", "items[0][id]", "items[0][price]", "payment_behavior", "proration_behavior", "proration_date"]);

part("A retry of the same switch is the same request to Stripe");
is("the same membership, second and price give the same key", switchKey("sub_pinsTier01", AT, "price_gold01"), switchKey("sub_pinsTier01", AT, "price_gold01"));
is("and it names all three", switchKey("sub_pinsTier01", AT, "price_gold01"), `switch:sub_pinsTier01:${AT}:price_gold01`);
is("another second, price or membership is another switch", new Set([switchKey("sub_pinsTier01", AT, "price_gold01"), switchKey("sub_pinsTier01", AT + 1, "price_gold01"), switchKey("sub_pinsTier01", AT, "price_silver01"), switchKey("sub_pinsTier02", AT, "price_gold01")]).size, 4);

part("chargedOf: what the receipt says was charged, read exactly");
is("the card paid the whole total", chargedOf({ total: 1_500, amount_paid: 1_500, currency: "usd" }), { cents: 1_500, currency: "usd" });
is("a credit paid part of it: only what the card paid", chargedOf({ total: 1_500, amount_paid: 400, currency: "usd" }), { cents: 400, currency: "usd" });
is("a move down: the credit, as Stripe totals it", chargedOf({ total: -700, amount_paid: 0, currency: "eur" }), { cents: -700, currency: "eur" });
is("nothing to pay", chargedOf({ total: 0, currency: "usd" }), { cents: 0, currency: "usd" });
is("an amount paid that does not read is unknown, never 'nothing charged'", [chargedOf({ total: 1_500, currency: "usd" }), chargedOf({ total: 1_500, amount_paid: -1, currency: "usd" }), chargedOf({ total: 1_500, amount_paid: 12.5, currency: "usd" }), chargedOf({ total: 1_500, amount_paid: "1500", currency: "usd" })], [null, null, null, null]);
is("a total or currency that does not read is unknown", [chargedOf({ total: 15.5, amount_paid: 0, currency: "usd" }), chargedOf({ total: 1_500, amount_paid: 1_500 }), chargedOf({ total: 1_500, amount_paid: 1_500, currency: "" }), chargedOf(null), chargedOf([]), chargedOf("in_123")], [null, null, null, null, null, null]);

done();
