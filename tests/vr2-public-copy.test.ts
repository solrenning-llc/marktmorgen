/**
 * Nothing shown as working that does not work today (VR, item 2; findings of session 5FNwB on main, passed on by the
 * coordinator, 15 November 2026). RED before the fix:
 *
 * 1. lib/feature-pages.ts: two cards of the Store assistant ("One next product after a purchase", "One reminder after
 *    a checkout left unpaid") said "Switch it on" with no word that it is not sold yet, while ASSISTANT_ON_SALE is
 *    false; the assistant's own card already says "(not on sale yet)".
 * 2. lib/feature-pages.ts: the affiliate page said a dispute does not cancel a commission, but the code does
 *    (lib/affiliates.ts: while the bank holds the disputed money, and for good once the dispute is lost, it earns
 *    nothing; a dispute won earns again), as the help center already says (lib/help-content.ts).
 * 3. components/home-parts.tsx: "in 15 currencies" read as a buyer paying in their own currency, while a store charges
 *    in the one currency it chose (and BUYER_CURRENCY_LIVE is false).
 * 4. lib/feature-pages.ts, /for/cooks: "you can buy them right now" in the demo store, where a purchase is a test one,
 *    made with Stripe's test card.
 * 5. lib/yearly-offer.ts (MEDIUM): the yearly offer email said "Every charge is covered by our 30-day refund, the
 *    yearly one too", while the guarantee covers the first payment, once per person, within 30 days
 *    (lib/plan-refund-words.ts); a yearly plan also gets back the months not started, less the card fee.
 *    (lib/plan-pause.ts has the same sentence; it is reserved by Codex A3 and left to it.)
 */
import { readFileSync } from "node:fs";
import { ASSISTANT_ON_SALE } from "@/lib/opening";
import { done, is, part } from "./check";

const flat = (file: string) => readFileSync(file, "utf8").replace(/\s+/g, " ");
const features = flat("lib/feature-pages.ts");
const home = flat("components/home-parts.tsx");

part("The Store assistant's cards say it is not on sale yet");
is("control: the assistant is not on sale", ASSISTANT_ON_SALE, false);
is("the next-product card says so", /title: "One next product after a purchase, with the " \+ ASSISTANT_NAME \+ " \(not on sale yet\)"/.test(features), true);
is("the reminder card says so", /title: "One reminder after a checkout left unpaid, only when asked for, with the " \+ ASSISTANT_NAME \+ " \(not on sale yet\)"/.test(features), true);

part("The affiliate page says what a dispute does to a commission, as the code does");
is("never that a dispute does not cancel it", features.includes("does not cancel a commission"), false);
is("a chargeback earns nothing while the bank holds the money and for good if lost; a dispute won earns again", features.includes("A chargeback on your Stripe account cancels a commission while the bank holds the disputed amount, and for good if the dispute is lost; a dispute you win earns again."), true);

part("The home page says a store charges in one currency it chooses");
is("never the bare 'in 15 currencies' for what a buyer pays in", home.includes("Stripe account, in 15 currencies"), false);
is("the store's prices in one of 15 currencies", home.includes("Your store's prices in one of 15 currencies, and Apple Pay"), true);
is("buyers pay in the store's currency, one of 15", home.includes("Buyers pay into your own Stripe account, in your store's currency (one of 15), and the money is yours."), true);

part("The cooks' page says a demo purchase is a test one");
is("never 'you can buy them right now' in the demo store", features.includes("you can buy them right now"), false);
is("try buying them with Stripe's test card", features.includes("The meal plans are in the demo store, and you can try buying them now with Stripe's test card."), true);

part("The yearly offer says what the money-back guarantee covers");
const yearly = flat("lib/yearly-offer.ts");
is("never that every charge, the yearly one too, is covered", yearly.includes("Every charge is covered by our 30-day refund"), false);
is("the first payment, once per person; a yearly plan gets back the months not started, less the card fee", yearly.includes("Our 30-day money-back guarantee covers your first payment, once per person; a yearly plan also gets back the months not started, less the card fee."), true);
done();
