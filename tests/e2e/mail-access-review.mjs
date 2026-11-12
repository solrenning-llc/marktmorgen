// The email's "Can everyone read it?" panel in a real browser (AX274 Part A item 6; ATAG 2.0 Part B), on its
// own (tests/e2e/mail-access-harness.tsx) with the site's own style sheet: no server, nothing sent.
// Checked: axe with every WCAG 2.0–2.2 A/AA/AAA rule (7:1 contrast included) with notes and once clear; every
// control at least 44 × 44 px (2.5.5); real Tab presses reach every control with a visible focus; a fix pressed
// with typed words changes only that place, is said in the status region and can be undone; vague words are
// refused with the error tied to the field; "Show it in the text" selects the place; marking a picture as
// decoration leaves the text as it is. Not a conformity claim; no assistive technology was run here.
// node tests/e2e/mail-access-review.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const driver = require("playwright-core")[engine];
const axe = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const { compile } = require("@tailwindcss/node");
const { Scanner } = require("@tailwindcss/oxide");

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/mail-access-harness.tsx")],
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "error",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundle.outputFiles[0].text;
const compiler = await compile(readFileSync(join(root, "app/globals.css"), "utf8"), { base: join(root, "app"), onDependency() {} });
const css = compiler.build(new Scanner({ sources: [
  { base: root, pattern: "components/mail-access-review.tsx", negated: false },
  { base: root, pattern: "tests/e2e/mail-access-harness.tsx", negated: false },
] }).scan());
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Email access check</title><link rel="stylesheet" href="/globals.css"></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/panel.js"></script></body></html>`;

const PIC = "https://marktmorgen.com/api/image/" + "a".repeat(24) + "/" + "1".repeat(32) + ".jpg";
const START = ["Hello bakers", `![](${PIC})`, "[Click here](https://example.com/guide)", "https://example.com/plan"].join("\n\n");

const browser = await driver.launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
try {
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route((url) => url.protocol === "http:" || url.protocol === "https:", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://localhost:41905") return route.abort();
      if (url.pathname === "/panel.js") return route.fulfill({ contentType: "text/javascript", body: script });
      if (url.pathname === "/globals.css") return route.fulfill({ contentType: "text/css", body: css });
      return url.pathname === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://localhost:41905/");
    await page.evaluate((body) => window.harness.mount(body), START);
    await page.getByRole("heading", { name: "Can everyone read it?" }).waitFor();
    const settled = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const text = () => page.locator("#mail-body").inputValue();
    const status = async () => ((await page.locator('section p[role="status"]').textContent()) ?? "").trim();
    const at = `${width} px: `;

    const audit = async () => {
      await page.addScriptTag({ content: axe });
      return page.evaluate(async () => {
        const tags = ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag21aaa", "wcag22a", "wcag22aa", "wcag22aaa"];
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
        return result.violations.map((rule) => ({ id: rule.id, targets: rule.nodes.map((node) => node.target) }));
      });
    };
    const small = () => page.evaluate(() => [...document.querySelectorAll("section button, section input, section summary")].map((node) => { const b = node.getBoundingClientRect(); return { what: node.textContent?.trim().slice(0, 30) || node.tagName, w: Math.round(b.width), h: Math.round(b.height) }; }).filter((t) => t.w < 44 || t.h < 44));
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

    is(at + "three notes listed", await page.locator("section ol > li").count(), 3);
    is(at + "axe AAA: no violation with notes", await audit(), []);
    is(at + "every control at least 44 × 44 px", await small(), []);
    is(at + "no sideways scroll", await overflow(), false);

    // Real Tab presses from the text box through the panel: every control is reached, each with a visible focus.
    await page.locator("#mail-body").focus();
    const reached = [];
    for (let n = 0; n < 14; n++) {
      await page.keyboard.press("Tab");
      const state = await page.evaluate(() => { const node = document.activeElement; if (!node || node === document.body) return null; const b = node.getBoundingClientRect(); return { inPanel: Boolean(node.closest("section")), visible: node.matches(":focus-visible"), name: node.getAttribute("id") ?? node.textContent?.trim().slice(0, 24) ?? "", w: b.width }; });
      if (state?.inPanel) reached.push(state);
    }
    is(at + "keyboard reaches the panel's controls, each with a visible focus", reached.length >= 8 && reached.every((s) => s.visible && s.w > 0), true);

    // Vague words: refused, said next to the field and tied to it; nothing changed.
    const buttonField = page.getByLabel("Words for the button").first();
    await buttonField.fill("Read more");
    await buttonField.press("Enter");
    await settled();
    is(at + "vague words refused, tied to the field", await buttonField.evaluate((node) => [node.getAttribute("aria-invalid"), document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent ?? ""]), ["true", "Say where it goes, for example “Read the bread guide”."]);
    is(at + "nothing changed", await text(), START);

    // A fix with typed words: only that place changes; it is said and can be undone.
    await buttonField.fill("Read the bread guide");
    await buttonField.press("Enter");
    await settled();
    is(at + "button renamed in the text", (await text()).includes("[Read the bread guide](https://example.com/guide)"), true);
    is(at + "the fix is said", await status(), "Button words changed. You can undo it.");
    is(at + "two notes left", await page.locator("section ol > li").count(), 2);
    await page.getByRole("button", { name: /^Undo/ }).click();
    await settled();
    is(at + "undo brings the text back", await text(), START);
    is(at + "the undo is said", await status(), "Button words changed: undone.");

    // Show it in the text: the place is selected in the text box.
    await page.getByRole("button", { name: /^Show it in the text ?: the picture$/ }).click();
    is(at + "show selects the picture's line", await page.evaluate(() => { const box = document.getElementById("mail-body"); return [document.activeElement === box, box.value.slice(box.selectionStart, box.selectionEnd)]; }), [true, `![](${PIC})`]);

    // Decoration: the text stays as it is; the note leaves the list and can be asked again.
    await page.getByRole("button", { name: "It is only decoration" }).click();
    await settled();
    is(at + "decoration changes no text", await text(), START);
    is(at + "decoration is said", await status(), "Marked as decoration: screen readers skip it.");
    is(at + "two notes left after decoration", await page.locator("section ol > li").count(), 2);

    // The lone address made a button with typed words, then the button: nothing left to fix.
    await page.getByLabel("Words for the button").last().fill("See the meal plan");
    await page.getByRole("button", { name: "Make it a button" }).click();
    await settled();
    await page.getByLabel("Words for the button").first().fill("Read the bread guide");
    await page.getByRole("button", { name: "Use these words" }).click();
    await settled();
    is(at + "clear: nothing to fix", (await page.locator("section").textContent()).includes("Nothing to fix"), true);
    is(at + "axe AAA: no violation once clear", await audit(), []);
    is(at + "every control at least 44 × 44 px once clear", await small(), []);
    await context.close();
  }
  is("no page error", errors, []);
} finally {
  await browser.close();
}
console.log(`MAIL_ACCESS_REVIEW_SUMMARY:${JSON.stringify({ engine, cases, failed, scope: "The panel alone, synthetic text, no server; no assistive technology run." })}`);
process.exitCode = failed ? 1 : 0;
