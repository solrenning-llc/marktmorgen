// The help center's side list of topics (564 [HC1]; components/help-topics.tsx) in a real browser: every topic link,
// short names such as "Tax" included, is at least 44 by 44 CSS pixels (WCAG 2.5.5; review of #4191), at a phone's
// width and a computer's. The real component with the real topics and the CSS Tailwind compiles from the site's own
// styles; every request is intercepted, nothing leaves the machine.
// node tests/e2e/help-topics-targets.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
const source = readFileSync("components/help-topics.tsx", "utf8");
// Every class-like word of the component, as Tailwind itself scans source files (a class inside ${…} included).
const tokens = [...new Set(source.match(/[A-Za-z0-9_:.\/\[\]%-]+/g) ?? [])];
const { compile } = require("@tailwindcss/node");
const css = (await compile(readFileSync("app/globals.css", "utf8"), { base: root, onDependency() {} })).build(tokens);
// The real topics, worked out on the server side (lib/help-pages.ts reads server-only modules), handed to the page as data.
const topicsBuild = await build({
  stdin: { contents: "import {helpTopics} from '@/lib/help-pages'; console.log(JSON.stringify(helpTopics()));", resolveDir: root, loader: "ts" },
  bundle: true, write: false, platform: "node", format: "cjs", alias: { "@": root }, logLevel: "error",
});
const { execFileSync } = await import("node:child_process");
const topics = execFileSync(process.execPath, ["-"], { input: topicsBuild.outputFiles[0].text, encoding: "utf8", maxBuffer: 16 << 20 }).trim();
const bundle = await build({
  stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {HelpTopics} from '@/components/help-topics';
    createRoot(document.getElementById('root')).render(<aside style={{width: '15rem'}}><HelpTopics topics={${topics}} /></aside>);
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  // The links are next/link, which reads process.env outside Next: a stand-in, as in the production build.
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
  for (const width of [320, 1280]) {
    const tab = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.route("**/*", (route) => route.abort());
    await tab.route("https://help.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><title>Help topics check</title><style>${css}</style><body><main id="root"></main></body></html>` }));
    await tab.goto("https://help.test/");
    await tab.addScriptTag({ content: bundle.outputFiles[0].text });
    await tab.locator("[data-help-topics] li a").first().waitFor({ state: "attached" });
    // On a phone the list starts folded: open it, as a person would.
    if (width < 1024) await tab.getByRole("button", { name: "All help topics" }).click();
    const boxes = await tab.locator("[data-help-topics] li a").evaluateAll((links) => links.map((a) => ({ name: a.textContent, w: a.getBoundingClientRect().width, h: a.getBoundingClientRect().height })));
    const small = boxes.filter((b) => b.w < 44 || b.h < 44).map((b) => `${b.name} ${Math.round(b.w)}x${Math.round(b.h)}`);
    is(`${width} px: every topic link, "Tax" included, is at least 44 by 44`, [boxes.length > 40, boxes.some((b) => b.name === "Tax"), small], [true, true, []]);
    is(`${width} px: no script error`, errors, []);
    await tab.close();
  }
} finally {
  await browser.close();
}
console.log(`${engine}: ${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
