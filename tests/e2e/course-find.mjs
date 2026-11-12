// "Find a lesson" over a course's outline (291 [SQ2], unit 1) in a real browser: the real CourseFind and the
// real CourseOutline with a synthetic course; every request is intercepted, nothing leaves the machine.
// node tests/e2e/course-find.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
const { compile } = require("@tailwindcss/node");
const css = (await compile(readFileSync("app/globals.css", "utf8"), { base: root, onDependency() {} })).build(["block", "mb-4", "mt-1", "w-full", "min-h-5", "text-sm", "space-y-5", "space-y-1", "flex", "items-start", "gap-2"]);
const bundle = await build({
  stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {CourseFind} from '@/components/course-find';
    import {CourseOutline} from '@/components/course-outline';
    const lesson = (id, title) => ({ id, title, video: null, preview: false });
    const course = { id: 'c'.repeat(32), modules: [
      { id: 'mod000000001', title: 'Getting started', dripDays: 0, lessons: [lesson('les000000001', 'Welcome & setup'), lesson('les000000002', 'Your first sale'), lesson('les000000003', 'Leçon bonus')] },
      { id: 'mod000000002', title: 'Pricing', dripDays: 0, lessons: [lesson('les000000004', 'Price anchors'), lesson('les000000005', 'Discounts that work')] },
      { id: 'mod000000003', title: 'Email', dripDays: 0, lessons: [lesson('les000000006', 'Your welcome email'), lesson('les000000007', 'A weekly letter'), lesson('les000000008', 'Q & A')] },
    ] };
    createRoot(document.getElementById('root')).render(
      <CourseFind language="en"><CourseOutline course={course} base="/@shop/course/p" start={0} done={new Set()} language="en" /></CourseFind>
    );
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  // The outline's links are next/link, which reads process.env outside Next: a stand-in, as in the production build.
  banner: { js: "var process = { env: { NODE_ENV: 'production' } };" },
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
});

const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const browser = await require("playwright-core")[engine].launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let checks = 0, failures = 0;
function is(name, got, expected) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`}`);
}
try {
  const tab = await browser.newPage({ viewport: { width: 320, height: 900 } }), errors = [];
  tab.setDefaultTimeout(5000);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.route("**/*", (route) => route.abort());
  await tab.route("https://course.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><title>Find a lesson check</title><style>${css}</style><body><main id="root"></main></body></html>` }));
  await tab.goto("https://course.test/");
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  const box = tab.getByRole("searchbox", { name: "Find a lesson" });
  await box.waitFor().catch((e) => { console.log("page errors:", errors); throw e; });
  const lessons = () => tab.locator("[data-find]").evaluateAll((all) => all.filter((li) => li.offsetParent !== null).map((li) => li.textContent.replace(/^[✓○🔒]\s*/u, "").trim()));
  const modules = () => tab.locator("[data-find-module]").evaluateAll((all) => all.filter((li) => li.offsetParent !== null).length);
  is("at first, the whole outline", [(await lessons()).length, await modules()], [8, 3]);
  await box.fill("welcome");
  is("a word: the lessons that hold it, from any module", await lessons(), ["Welcome & setup", "Your welcome email"]);
  is("said", await tab.getByRole("status").textContent(), "2 lessons match.");
  is("a module with none left is hidden too", await modules(), 2);
  await box.fill("pricing");
  is("a module's title finds its lessons", await lessons(), ["Price anchors", "Discounts that work"]);
  await box.fill("lecon");
  is("accents do not matter", [await lessons(), await tab.getByRole("status").textContent()], [["Leçon bonus"], "1 lesson matches."]);
  await box.fill("zzz");
  is("nothing: said, and the outline is empty", [await lessons(), await modules(), await tab.getByRole("status").textContent()], [[], 0, "No lesson matches “zzz”."]);
  await box.fill("");
  is("emptied: all back, nothing said", [(await lessons()).length, await modules(), await tab.getByRole("status").textContent()], [8, 3, ""]);
  is("the box comes before every lesson link, so the keyboard reaches it first", await tab.evaluate(() => { const box = document.querySelector('input[type="search"]'); const first = document.querySelector("[data-find] a"); return Boolean(box && first && box.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING); }), true);
  is("at 320 px, no sideways scrolling", await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  is("no script error", errors, []);
} finally {
  await browser.close();
}
console.log(`${engine}: ${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
