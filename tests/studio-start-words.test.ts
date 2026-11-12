/**
 * "Getting your store ready", as a brand-new creator reads it (issue #4308, creator funnel, Claude 1, 12/11/2026).
 * Found by walking main as a new creator on this computer with synthetic services:
 * - one minute after the store was made it said "First offer published 1 minutes after…", and a moment
 *   after it was made "0 minutes since this store was registered";
 * - "Prepare your first offer" said "Keep an AI draft…" where no AI draft is offered;
 * - "Publish your first offer yourself" said "then choose Publish" while a product added by hand is on
 *   the page at once (there is no Publish to choose; the button on a draft is "Publish it").
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { StudioStart, minutesWords, type StartStep } from "@/components/studio-start";
import { done, is, part } from "./check";

const steps: StartStep[] = ["product", "publish", "stripe", "plan", "share"].map((key) => ({ key, title: `Title ${key}`, hint: `Hint ${key}`, done: false, href: `#${key}` }));
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const render = (state: "published" | "waiting", minutes: number) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router as never }, createElement(StudioStart, { steps, activation: { state, minutes, startedAt: "", publishedAt: "" } })));

part("Minutes, said in English");
is("never \"1 minutes\" or \"0 minutes\"", [minutesWords(0), minutesWords(1), minutesWords(12), minutesWords(1500), minutesWords(null)], ["less than a minute", "1 minute", "12 minutes", "1,500 minutes", "less than a minute"]);
is("published one minute after", /First offer published 1 minute after this store was registered\./.test(render("published", 1)), true);
is("waiting, a moment after", /Less than a minute since this store was registered\./.test(render("waiting", 0)), true);
is("waiting, one minute after", /1 minute since this store was registered\./.test(render("waiting", 1)), true);
is("nothing on the page says 1 minutes or 0 minutes", [/\b[01] minutes\b/.test(render("published", 1)), /\b[01] minutes\b/.test(render("waiting", 0)), /\b[01] minutes\b/.test(render("waiting", 1))], [false, false, false]);

part("The hints name only what this studio offers");
const page = readFileSync("app/studio/page.tsx", "utf8");
const product = page.slice(page.indexOf('{ key: "product"'), page.indexOf('{ key: "publish"'));
const publish = page.slice(page.indexOf('{ key: "publish"'), page.indexOf("\n", page.indexOf('{ key: "publish"')));
is("an AI draft is named only where the AI box is offered", /hint: productCount\(store\) === 0 && ai\.on \? "Keep an AI draft[^"]*" : "Add what you sell[^"]*"/.test(product), true);
is("no \"choose Publish\" for what is published at once; the draft's button by its own name", [publish.includes("then choose Publish."), publish.includes("on your page at once"), publish.includes("choose Publish it")], [false, true, true]);
is("that button is still called Publish it", readFileSync("components/product-editor.tsx", "utf8").includes("Publish it\n"), true);

done();
