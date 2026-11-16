import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MorningHeader } from "@/components/morning-header";

function action(html: string, className: string) {
  const links = [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)]
    .filter(([, attrs]) => new RegExp(`class(?:Name)?="${className}"`).test(attrs));
  assert.equal(links.length, 1, `${className}: one existing native action`);
  assert.match(links[0][1], /href="\/signin"/, `${className}: existing destination retained`);
  assert.equal(links[0][2], "Start your store", `${className}: action names the store without a free-callout`);
}

for (const current of [undefined, "/pricing"] as const) {
  action(renderToStaticMarkup(createElement(MorningHeader, { current })), "hm-nav-cta");
}
action(readFileSync("app/page.tsx", "utf8"), "hm-plan-button");
console.log("Home source and real shared header retain native sign-in actions with factual labels");
