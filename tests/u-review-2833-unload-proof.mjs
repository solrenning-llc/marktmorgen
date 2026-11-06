import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
let failed = 0;
let checks = 0;
function is(name, got, want) {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${same ? "ok  " : "FAIL"}  ${name}`);
  if (!same) {
    failed += 1;
    console.log(`        expected ${JSON.stringify(want)}\n        got      ${JSON.stringify(got)}`);
  }
}

const source = readFileSync(resolve("tests/e2e/social-acknowledgment.mjs"), "utf8");
const wait = 'await page.waitForFunction(()=>window.dispatchEvent(new Event("beforeunload",{cancelable:true})));';
const assertion = 'is("confirmed profiles release unload protection "+name,await page.evaluate(()=>!window.dispatchEvent(new Event("beforeunload",{cancelable:true}))),false);';
is("the wait is present", source.includes(wait), true);
is("the original false-equals-false assertion is unchanged", source.includes(assertion), true);
is("the wait remains immediately before the assertion", source.indexOf(wait) < source.indexOf(assertion), true);
is("the wait uses Playwright's default timeout", source.includes(`${wait.slice(0, -2)},`), false);

let browser;
try {
  browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: "chrome" }));
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  await page.goto("data:text/html,<main>guard timing</main>");
  await page.evaluate(() => {
    const handler = (event) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    const remove = window.removeEventListener.bind(window);
    window.removeEventListener = (type, listener, options) => {
      if (type !== "beforeunload") return remove(type, listener, options);
      setTimeout(() => remove(type, listener, options), 300);
    };
    window.removeEventListener("beforeunload", handler);
  });
  is("RED: the immediate original assertion observes the held guard", await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
  const started = Date.now();
  await page.waitForFunction(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
  const elapsed = Date.now() - started;
  is("the final wait observes the delayed cleanup", elapsed >= 200, true);
  is("GREEN: the unchanged assertion passes after the wait", await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), false);

  const ordinary = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await ordinary.goto("data:text/html,<main>ordinary cleanup</main>");
  is("the wide control has no unload protection", await ordinary.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), false);

  const stuck = await browser.newPage();
  await stuck.goto("data:text/html,<main>stuck guard</main>");
  await stuck.evaluate(() => window.addEventListener("beforeunload", (event) => event.preventDefault()));
  let timedOut = false;
  try {
    await stuck.waitForFunction(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })), null, { timeout: 150 });
  } catch (error) {
    timedOut = error?.name === "TimeoutError";
  }
  is("a guard that is never released still fails", timedOut, true);
} finally {
  await browser?.close();
}

console.log(`\n${checks} checks, ${failed ? `${failed} failing` : "all passing"}.`);
process.exit(failed ? 1 : 0);
