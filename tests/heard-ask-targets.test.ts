/**
 * WCAG 2.2 2.5.5 (AAA, AX274): every answer of "how did you hear about us?" on the receipt
 * (components/heard-ask.tsx) is a target of at least 44 by 44 px. `.btn-sm` (app/globals.css) gives the
 * height only; a one-letter answer ("X") came out 42 px wide in the buyer-actions browser audit
 * (#2728's CI, simulated-paid-receipt at 320 px), so each answer also carries min-w-11 (44 px).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { HeardAsk } from "@/components/heard-ask";
import { HEARD_ANSWERS } from "@/lib/heard-rules";
import { done, is, part } from "./check";

part("Every answer is 44 px wide at the least, whatever its words");
for (const lang of ["en", "es", "fr", "de", "it", "nl", "pt"]) {
  const html = renderToStaticMarkup(createElement(HeardAsk, { handle: "shop", session: "cs_test_heard00000000000000", storeName: "Shop", lang }));
  const buttons = [...html.matchAll(/<button\b[^>]*class="([^"]*)"/g)].map((m) => m[1]);
  is(`${lang}: one button an answer, each with min-w-11 and min-h-11 or btn-sm`, [buttons.length === HEARD_ANSWERS.length, buttons.every((c) => /\bmin-w-11\b/.test(c) && (/\bmin-h-11\b/.test(c) || /\bbtn-sm\b/.test(c)))], [true, true]);
}

done();
