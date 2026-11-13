// "Focus mode" on a lesson's page (295 [SQ6]) in a real browser: the real component, the lesson page's own
// classes and the CSS Tailwind compiles from them; every request is intercepted, nothing leaves the machine.
// node tests/e2e/lesson-focus.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
// The lesson page's own class lists, so the fixture hides exactly what the page marks.
const cls = (marker) => {
  const at = page.indexOf(marker);
  if (at < 0) throw new Error(`not on the lesson page: ${marker}`);
  return page.slice(at).match(/className="([^"]*)"/)[1];
};
const crumb = cls('<p className="text-sm group-data');
const grid = cls('<div className="mt-4 grid');
const aside = cls("<aside ");
const tokens = [...new Set([crumb, grid, aside, "group/focus", "group-data-[focus=on]/focus:hidden", "sr-only", "inline-flex", "min-h-11", "items-center", "mb-4", "flex", "flex-wrap", "gap-3"].join(" ").split(/\s+/))];
const { compile } = require("@tailwindcss/node");
const css = (await compile(readFileSync("app/globals.css", "utf8"), { base: root, onDependency() {} })).build(tokens);

const bundle = await build({
  stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {LessonFocus} from '@/components/lesson-focus';
    import {COURSES_WORDS} from '@/lib/buyer-words/courses';
    const w = COURSES_WORDS.en;
    createRoot(document.getElementById('root')).render(
      <LessonFocus words={{ focusOn: w.focusOn, focusOff: w.focusOff, focusOnSaid: w.focusOnSaid, focusOffSaid: w.focusOffSaid }}>
        <p className=${JSON.stringify(crumb)} id="crumb"><a href="#c">The course</a></p>
        <div className=${JSON.stringify(grid)}>
          <article id="lesson"><h1>Lesson one</h1><video controls aria-label="Lesson video"></video><p>The lesson's words.</p>
            <div className="group-data-[focus=on]/focus:hidden" id="notes">Notes</div>
            <button id="done">Mark as done</button>
            <span className="group-data-[focus=on]/focus:hidden" id="next"><a href="#n">Next lesson</a></span>
          </article>
          <div className="group-data-[focus=on]/focus:hidden" id="comments"><p id="c-x">A reply to your comment</p></div>
          <aside className=${JSON.stringify(aside)} id="outline">In this course</aside>
        </div>
      </LessonFocus>
    );
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const tab = await context.newPage(), errors = [];
  tab.setDefaultTimeout(5000);
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.route("**/*", (route) => route.abort());
  await tab.route("https://lesson.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><title>Focus mode check</title><style>${css}</style><body><main id="root"></main></body></html>` }));
  const open = async () => {
    await tab.goto("https://lesson.test/");
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });
    await tab.getByRole("button", { name: /focus mode/i }).waitFor();
  };
  const seen = async () => Object.fromEntries(await Promise.all(["crumb", "lesson", "notes", "done", "next", "outline"].map(async (id) => [id, await tab.locator(`#${id}`).isVisible()])));
  await open();
  is("off: everything shown", await seen(), { crumb: true, lesson: true, notes: true, done: true, next: true, outline: true });
  const wide = await tab.locator("#lesson").boundingBox();
  // WebKit leaves buttons out of Tab by default (a macOS setting), so there the button is focused directly.
  if (engine === "webkit") await tab.getByRole("button", { name: "Focus mode" }).focus();
  else {
    await tab.keyboard.press("Tab");
    is("the first stop of the keyboard is the button", await tab.evaluate(() => document.activeElement?.textContent), "Focus mode");
  }
  await tab.keyboard.press("Enter");
  is("on: only the lesson, its player and Mark as done", await seen(), { crumb: false, lesson: true, notes: false, done: true, next: false, outline: false });
  is("the keyboard is still on the same button, which says how to leave", await tab.evaluate(() => [document.activeElement?.tagName, document.activeElement?.textContent]), ["BUTTON", "Leave focus mode"]);
  is("a screen reader is told", await tab.getByRole("status").textContent(), "Focus mode is on. Only the lesson is shown.");
  is("the lesson takes the outline's place", ((await tab.locator("#lesson").boundingBox()).width > wide.width + 200), true);
  await open();
  is("the next lesson opens in focus mode too", await tab.locator("#outline").isVisible(), false);
  is("and says nothing until pressed", await tab.getByRole("status").textContent(), "");
  await tab.getByRole("button", { name: "Leave focus mode" }).click();
  is("left: everything back", await seen(), { crumb: true, lesson: true, notes: true, done: true, next: true, outline: true });
  await tab.setViewportSize({ width: 320, height: 800 });
  await tab.getByRole("button", { name: "Focus mode" }).click();
  is("at 320 px, no sideways scrolling", await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  is("the button is a 44 px target", (await tab.getByRole("button", { name: "Leave focus mode" }).boundingBox()).height >= 44, true);
  // The reply link in a comment email (lib/lesson-comment-notify.ts) points at #c-<id>, inside the comments focus mode hides.
  await tab.evaluate(() => localStorage.setItem("mm:lesson-focus", "on"));
  await tab.goto("https://lesson.test/#c-x");
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  await tab.getByRole("button", { name: /focus mode/i }).waitFor();
  is("a link to a hidden reply opens with focus mode off for that visit, the reply shown", [await tab.locator("#c-x").isVisible(), await tab.getByRole("button", { name: /focus mode/i }).textContent()], [true, "Focus mode"]);
  is("brought into view", await tab.locator("#c-x").evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; }), true);
  is("the remembered choice is left as it was", await tab.evaluate(() => localStorage.getItem("mm:lesson-focus")), "on");
  await tab.goto("https://lesson.test/");
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  await tab.getByRole("button", { name: /focus mode/i }).waitFor();
  is("the next lesson without such a link opens in focus mode again", await tab.locator("#outline").isVisible(), false);
  is("no script error", errors, []);
} finally {
  await browser.close();
}
console.log(`${engine}: ${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
