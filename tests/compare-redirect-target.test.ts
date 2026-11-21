/**
 * next.config.ts sends /compare and /comparison (permanent redirects) to the
 * page that holds the comparisons. The home page has no element with
 * id="compare" and no comparison section any more, so the old "/#compare"
 * target dropped a visitor at the top of the home page with nothing compared
 * (audit R33, finding 4). The comparisons index is /proof/comparisons, the
 * same address as the "All comparisons" link in the footer and the menu.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import Home from "@/app/page";
import { findPage } from "@/lib/site-pages";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  const next = readFileSync("next.config.ts", "utf8");
  const html = renderToStaticMarkup(Home());

  part("Control");
  is("the home page renders (its pricing anchor is there)", /id="pricing"/.test(html), true);
  is("the home page has no compare anchor", /id="compare"/.test(html), false);
  is("/proof/comparisons is a published page", Boolean(findPage("proof", "comparisons")), true);

  part("/compare and /comparison go to the comparisons page");
  is("they redirect (permanent) to /proof/comparisons", next.includes('...to("/proof/comparisons", "/compare", "/comparison"),'), true);
  is("no redirect points at the missing /#compare anchor", next.includes('"/#compare"'), false);
}

void main().then(done);
