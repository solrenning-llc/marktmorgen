// "Where should I start?" (562 [QZ1], unit 1) in a real browser: components/start-quiz.tsx alone, with the facts the
// page hands it, all network traffic refused. Run: node tests/e2e/start-quiz.mjs
// E2E_BROWSER=chromium|firefox|webkit; CHROMIUM can name an installed executable.
// Checked: answered by keyboard alone (Tab to a group, arrow keys within it); nothing is shown before the last
// answer; the answer is in a status region and names the pages, the template and the plan; changing an answer
// changes the answer; no request leaves the page; axe finds no WCAG A/AA/AAA violation of names, roles, labels or
// structure (colors and target sizes are the site's stylesheet's, min-h-11 and min-h-12, and are not loaded here).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(root + "/package.json");
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported browser");
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {StartQuiz} from '@/components/start-quiz';
    import {FUNNEL_STARTERS} from '@/lib/funnel-starters';
    import {starterCard} from '@/lib/funnel-starter-catalog';
    import {STARTER_GALLERY_TITLE} from '@/lib/funnel-niche-feature';
    import {MIGRATION_GUIDES} from '@/lib/migration-guides';
    import {PLAN_TITLES, publishedPriceWords} from '@/lib/plan';
    const facts = {
      starters: Object.fromEntries(FUNNEL_STARTERS.map((s) => { const c = starterCard(s); return [s.id, { label: s.label, hint: s.hint, gathers: c.forms > 0 || c.products.some((p) => p.wants === "free") }]; })),
      gallery: STARTER_GALLERY_TITLE,
      listPlan: { name: PLAN_TITLES.pro, monthly: publishedPriceWords("pro", "month") },
      guides: MIGRATION_GUIDES.map((g) => ({ slug: g.slug, platform: g.platform })),
      plan: { tier: "creator", name: PLAN_TITLES.creator, monthly: publishedPriceWords("creator", "month"), yearly: publishedPriceWords("creator", "year"), onSale: false },
    };
    createRoot(document.getElementById('root')).render(<StartQuiz facts={facts}/>);
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
  // next/link outside a Next app: a plain link, which is what it renders.
  plugins: [{ name: "link", setup(b) {
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: "link", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "import React from 'react'; export default function Link({href, prefetch, ...rest}) { return React.createElement('a', {href, ...rest}); }", loader: "js", resolveDir: root }));
  } }],
});
const axe = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const browser = await require("playwright-core")[engine].launch({
  headless: true,
  ...(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}),
});
let checks = 0, failures = 0;
function is(name, actual, expected) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => { requests.push(route.request().url()); return route.abort(); });
  await page.route("https://site.test/start-here", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Where should I start?</title><body><main id="root"></main></body></html>' }));
  await page.goto("https://site.test/start-here");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const status = page.getByRole("status");
  is("before answering, it says what to do", await status.textContent(), "Answer the 3 questions above and your starting point appears here.");

  // Keyboard only: Tab into the first group, arrow down to its second choice (courses); and so on.
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  is("the first answer is chosen by arrow key", await page.getByRole("radio", { name: "Online courses or lessons" }).isChecked(), true);
  is("one answer is not enough", (await status.textContent())?.startsWith("Answer the 2 questions"), true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  is("the second, back by arrow key: starting out", await page.getByRole("radio", { name: "Not yet: I am starting out" }).isChecked(), true);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  is("the third: no other platform", await page.getByRole("radio", { name: "No", exact: true }).isChecked(), true);
  is("only a short sentence is announced", await status.textContent(), "Your starting point is below: the template “Free lesson, then the course”, on the Store plan.");
  const answer = page.locator("section[aria-labelledby='start-result-title']");
  const text = await answer.textContent();
  is("the answer names the pages, the template where the studio shows it, and the plan", [text?.includes("Marktmorgen for course creators"), text?.includes("How courses work"), text?.includes("in “Start with a campaign, with first words written”, choose “Free lesson, then the course”"), text?.includes("Store plan: $69 a month, or $690 a year."), text?.includes("Paid plans and paid selling are not open yet.")], [true, true, true, true, true]);
  is("a template that gathers addresses says writing to them all needs the list plan or an email platform", text?.includes("Sending emails to all of them later is on the Studio plan"), true);
  is("its links go where they say", await answer.getByRole("link").evaluateAll((links) => links.map((a) => a.getAttribute("href"))), ["/for/course-creators", "/platform/courses", "/platform/email-platforms", "/pricing#plans", "/signin?plan=creator&billing=month"]);

  await page.getByRole("radio", { name: "Yes: people already read, watch or follow me" }).check();
  is("changing an answer changes the answer", (await status.textContent())?.includes("Launch a complete course"), true);
  is("one that gathers no address says nothing of it", (await answer.textContent())?.includes("Sending emails to all of them"), false);

  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(async () => {
    const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false }, "color-contrast-enhanced": { enabled: false }, "target-size": { enabled: false } } });
    return run.violations.map((v) => `${v.id}: ${v.nodes.length} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  });
  is("axe: no violation of names, roles, labels or structure", result, []);
  is("no request left the page", requests, []);
  is("no error in the page", errors, []);
} finally {
  await browser.close();
}
console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exitCode = failures ? 1 : 0;
