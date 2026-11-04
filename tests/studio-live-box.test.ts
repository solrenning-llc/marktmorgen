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
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("Before its first answer, the box is already there, in the shape it keeps");
const html = renderToStaticMarkup(createElement(RightNow, { currency: "usd" }));
is("drawn, and said to be checking", [html.includes("Checking who has opened your store in the last 5 minutes"), html.includes('aria-busy="true"')], [true, true]);
is("with today's four numbers in their places, waiting, read as \"Loading\"", [html.includes("Today so far"), (html.match(/<dd[^>]*><span aria-hidden="true">…<\/span><span class="sr-only">Loading<\/span><\/dd>/g) ?? []).length], [true, 4]);
is("and the lines under them, so the answer fills them in rather than adding them", [html.includes("Reading today&#x27;s numbers.") || html.includes("Reading today's numbers."), html.includes("The day in UTC")], [true, true]);

part("Today left out of an answer is a reading that failed, said with when it is read again (inbox C4-34)");
{
  const source = readFileSync("components/stats-panel.tsx", "utf8");
  const route = readFileSync("app/api/store/live/route.ts", "utf8");
  is("the route leaves today out only when its reading fails", route.includes("readToday(access.store).catch(() => null)"), true);
  is("the box says it failed on the last try, and when it is read again, or to reload once it rests", [source.includes("Today's numbers could not be read on the last try; they are read again in half a minute."), source.includes("Today's numbers could not be read on the last try; reload the page to read them again.")], [true, true]);
  is("never \"just now\" with nothing after it", source.includes("Today's numbers could not be read just now."), false);
}

done();
