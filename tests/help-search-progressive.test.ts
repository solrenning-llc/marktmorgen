import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpSearch } from "@/components/help-search";

test("server-rendered help search is unavailable until its application code runs", () => {
  const html = renderToStaticMarkup(createElement(HelpSearch));
  const input = html.match(/<input\b[^>]*>/)?.[0];
  assert.ok(input, "the labeled search control remains present");
  assert.match(input, /\sdisabled=""/, "the native search input cannot promise an unavailable action");
});

test("server-rendered keyword buttons do not offer inactive filtering", () => {
  const html = renderToStaticMarkup(createElement(HelpSearch));
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  assert.equal(buttons.length, 5, "the existing five keyword choices remain");
  assert.ok(buttons.every(button => /\sdisabled=""/.test(button)), "every unavailable keyword action is natively disabled");
});

test("server-rendered help explains the working native answer path", () => {
  const html = renderToStaticMarkup(createElement(HelpSearch));
  assert.ok(html.includes("All answers are below. Open a question to read its answer."));
  assert.ok(!html.includes("Type a word and the answers that mention it open below."), "no filtering promise before application code");
  const hint = html.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(hint && html.includes(`id="${hint}"`), "the input retains its description relationship");
});
