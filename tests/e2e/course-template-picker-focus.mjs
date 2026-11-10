// Actual picker in a browser; the surrounding editor holds a synthetic save.
// All network traffic is intercepted. Run: node tests/e2e/course-template-picker-focus.mjs
// E2E_BROWSER=chromium|firefox|webkit; CHROMIUM can name an installed executable.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(root + "/package.json");
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported browser");
const bundle = await build({
  stdin: { contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {CourseTemplatePicker} from '@/components/course-template-picker';
    import {emptyCourse} from '@/lib/course';
    function Harness() {
      const [busy,setBusy]=useState(false), [course]=useState(emptyCourse);
      return <CourseTemplatePicker course={course} busy={busy}
        save={async payload=>{window.calls.push(payload);setBusy(true);
          const answer=await new Promise(resolve=>window.finish=resolve);
          setBusy(false);return answer;}}
        onSkip={()=>window.skips++} onApplied={()=>window.applied++}/>;
    }
    window.calls=[];window.skips=0;window.applied=0;
    createRoot(document.getElementById('root')).render(<Harness/>);
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
});
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
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.abort());
  await page.route("https://course.test/", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Course structure check</title><body><main id="root"></main></body></html>' }));
  await page.goto("https://course.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('input[value="mini"]').check();
  await page.getByRole("button", { name: "Use this structure", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.calls.length === 1);
  is("pending save keeps focus on the apply button", await page.evaluate(() => document.activeElement?.textContent), "Use this structure");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  is("keyboard cannot submit a second pending save", await page.evaluate(() => window.calls), [{ action: "template", template: "mini" }]);
  await page.keyboard.press("Tab");
  is("Tab can leave the pending apply button normally", await page.evaluate(() => document.activeElement?.textContent), "Keep an empty course");

  const mini = page.locator('input[value="mini"]');
  await mini.evaluate(element => element.focus());
  is("a busy radio remains a keyboard focus target", await page.evaluate(() => document.activeElement?.getAttribute("value")), "mini");
  for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End", "Space"]) await page.keyboard.press(key);
  is("radio keyboard actions cannot change a pending choice", await page.locator('input:checked').inputValue(), "mini");
  const weekly = await page.locator('input[value="weekly"]').locator("..").boundingBox();
  if (!weekly) throw Error("Weekly label missing");
  await page.mouse.click(weekly.x + weekly.width / 2, weekly.y + weekly.height / 2);
  is("a label click cannot change a pending choice", await page.locator('input:checked').inputValue(), "mini");

  const leave = page.getByRole("button", { name: "Keep an empty course", exact: true });
  await leave.evaluate(element => element.focus());
  is("pending skip remains focusable", await page.evaluate(() => document.activeElement?.textContent), "Keep an empty course");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  is("keyboard cannot leave during the save", await page.evaluate(() => window.skips), 0);

  await mini.evaluate(element => element.focus());
  await page.evaluate(() => window.finish({ ok: false }));
  await page.waitForFunction(() => document.querySelector('fieldset').getAttribute('aria-disabled') !== 'true' && !document.querySelector('fieldset').disabled);
  is("a rejected save leaves focus where the user put it", await page.evaluate(() => document.activeElement?.getAttribute("value")), "mini");
  await page.locator('input[value="weekly"]').check();
  is("choices work again after rejection", await page.locator('input:checked').inputValue(), "weekly");
  await page.getByRole("button", { name: "Use this structure", exact: true }).focus();
  await page.keyboard.press("Enter");
  is("retry sends the newly chosen structure", await page.evaluate(() => window.calls[1]), { action: "template", template: "weekly" });
  await page.evaluate(() => window.finish({ ok: false }));
  await page.waitForFunction(() => document.querySelector('fieldset').getAttribute('aria-disabled') !== 'true' && !document.querySelector('fieldset').disabled);
  is("rejection keeps the retry button focused", await page.evaluate(() => document.activeElement?.textContent), "Use this structure");
  is("a rejected save never claims success", await page.evaluate(() => window.applied), 0);
  await leave.click();
  is("leaving while idle still works once", await page.evaluate(() => window.skips), 1);
  await page.locator('input[value="scratch"]').check();
  await page.getByRole("button", { name: "Start from scratch", exact: true }).click();
  is("starting empty still works without a save", await page.evaluate(() => [window.skips, window.calls.length]), [2, 2]);
  is("the browser reported no component error", errors, []);
} finally { await browser.close(); }
console.log(`${checks} checks, ${failures} failing.`);
process.exitCode = failures ? 1 : 0;
