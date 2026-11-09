/**
 * The mark a buyer sees once a payment is confirmed (queue item 654 [WG14],
 * part (a), added 6 November 2026): components/payment-received.tsx, its rule
 * in app/globals.css and its words in lib/buyer-words/thanks.ts.
 *
 * Checked:
 *
 *   - the words are said in a status region, in plain text, and the drawing
 *     is hidden from screen readers (it repeats the words);
 *   - the circle and the check are drawn once, 600 ms in all, never looped;
 *   - under prefers-reduced-motion: reduce nothing moves, and the mark is
 *     already complete (it is drawn by default, animated only on no-preference);
 *   - no sound, no confetti, no amount: the component takes only its words;
 *   - the words exist in every buyer language.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentReceived } from "@/components/payment-received";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("The words, said to everyone");
const html = renderToStaticMarkup(createElement(PaymentReceived, { label: "Payment received" }));
is("a status region holds the words", /<div[^>]*role="status"[^>]*>[\s\S]*Payment received/.test(html), true);
is("the drawing is hidden from screen readers", /<svg[^>]*aria-hidden="true"/.test(html), true);
is("and is never focusable", /<svg[^>]*focusable="false"/.test(html), true);
is("it draws in the text's own color, so forced colors and dark mode follow", (html.match(/stroke="currentColor"/g) ?? []).length, 2);
is("a ring and a check, each drawn along its own length", (html.match(/pathLength="1"/g) ?? []).length, 2);
is("no sound, no picture, no number", /<audio|<video|<img|\$|\d+\.\d\d/.test(html), false);

part("Drawn once, 600 ms, never in reduce");
const css = readFileSync("app/globals.css", "utf8");
const at = css.indexOf("/* 654 [WG14] payment received */");
is("the rule is in the stylesheet", at >= 0, true);
const rule = css.slice(at, css.indexOf("/* end 654 [WG14] */", at));
is("drawn complete by default (what reduce gets)", /\.mm-paid-ring,\s*\.mm-paid-check\s*\{[^}]*stroke-dashoffset:\s*0/.test(rule), true);
is("animated only when motion is welcome", /@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*animation:/.test(rule), true);
is("no animation outside that media query", rule.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/, "").includes("animation:"), false);
const durations = [...rule.matchAll(/animation:\s*mm-check-draw\s+(\d+)ms\s+[a-z-]+(?:\s+(\d+)ms)?\s+1\s+both/g)].map((m) => [Number(m[1]), Number(m[2] ?? 0)]);
is("two animations, each played once", durations.length, 2);
is("600 ms from the first stroke to the last", Math.max(...durations.map(([d, delay]) => d + delay)), 600);
is("never looped", /infinite/.test(rule), false);
is("nothing blinks: only the stroke is drawn", /opacity|visibility|blink/.test(rule), false);

part("On the thanks page: only a payment Stripe confirmed, of an amount");
const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
const uses = thanks.match(/<PaymentReceived label=\{t\.paymentReceived\} \/>/g) ?? [];
is("shown on the five paid views (main, package, pre-order, gift, group)", uses.length, 5);
is("each of the four short views only for an amount, else the old words", (thanks.match(/\{\(order\.amount \?\? 0\) > 0 \? <PaymentReceived label=\{t\.paymentReceived\} \/> : <p className="st-price text-sm">\{t\.paid\}<\/p>\}/g) ?? []).length, 4);
is("the main view never for a trial, a moved membership or a free order", thanks.includes("{!(order.product.recurring && (order.firstChargeAt > 0 || order.trialDays > 0)) && (order.amount ?? 0) > 0 ? ("), true);
is("never on the PayPal or waiting views (not confirmed by Stripe)", /paidWithPayPal\}<\/p>|waitingPayPal\}<\/p>/.test(thanks) && !/PaymentReceived[^\n]*(paidWithPayPal|waitingPayPal)/.test(thanks), true);

part("In every buyer language");
for (const code of LANGUAGE_CODES) {
  const said = THANKS_WORDS[code].paymentReceived;
  is(`${code}: says it`, typeof said === "string" && said.trim().length > 0, true);
  if (code !== "en") is(`${code}: in its own words`, said !== THANKS_WORDS.en.paymentReceived, true);
}
is("English says it plainly", THANKS_WORDS.en.paymentReceived, "Payment received");

done();
