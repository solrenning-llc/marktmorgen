/**
 * "Who is on your store right now" is drawn from the first paint with the
 * shape it keeps (inbox C4-28). It used to draw nothing until its first
 * answer and then push everything under it down by 221 to 354 pixels, the
 * product editor included, about a second and a half after the studio
 * opened: in WebKit, which has no scroll anchoring, a press on "Add something
 * to sell" landed on a product row instead (WCAG 2.4.3, 3.2.5).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RightNow } from "@/components/stats-panel";
import { done, is, part } from "./check";

part("Before its first answer, the box is already there, in the shape it keeps");
const html = renderToStaticMarkup(createElement(RightNow, { currency: "usd" }));
is("drawn, and said to be checking", [html.includes("Checking who has opened your store in the last 5 minutes"), html.includes('aria-busy="true"')], [true, true]);
is("with today's four numbers in their places, waiting", [html.includes("Today so far"), (html.match(/<dd[^>]*>…<\/dd>/g) ?? []).length], [true, 4]);
is("and the lines under them, so the answer fills them in rather than adding them", [html.includes("Reading today&#x27;s numbers.") || html.includes("Reading today's numbers."), html.includes("The day in UTC")], [true, true]);

done();
