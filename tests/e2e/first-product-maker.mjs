// "Make your first product" (490 [PP1], unit 2) in a real browser: components/first-product-maker.tsx alone, the
// PDF route answered here, all other traffic refused. Run: node tests/e2e/first-product-maker.mjs
// E2E_BROWSER=chromium|firefox|webkit; CHROMIUM can name an installed executable.
// Checked: typing a title and a part, the download sends exactly the outline's parts and says where to go next with
// focus on that sentence; a refusal is said as an alert; what was written comes back after a reload (this device
// only); "Start over" asks first; every control is reached and used by keyboard; axe finds no WCAG A/AA/AAA
// violation of names, roles, labels or structure (colors are the site's stylesheet's and are not loaded here).
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
    import {FirstProductMaker} from '@/components/first-product-maker';
    createRoot(document.getElementById('root')).render(<FirstProductMaker storeKey="shop1" productsHref="/studio#products" currency="usd" folder="f0"/>);
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
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
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent = [];
  let answer = "pdf";
  await page.route("**/*", (route) => route.abort());
  await page.route("https://studio.test/", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>First product check</title><body><main id="root"></main></body></html>' }));
  await page.route("https://studio.test/api/store/first-product/pdf", async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? "{}"));
    if (answer === "pdf") return route.fulfill({ status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="Bread-at-home.pdf"' }, body: "%PDF-1.7\n%%EOF" });
    return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: answer }) });
  });
  // The product draft (unit 3): the draft route, the file door (lib/vault-upload.ts) and the attach route, answered here.
  const calls = [];
  await page.route("https://studio.test/api/store/first-product/draft", async (route) => {
    calls.push(["draft", JSON.parse(route.request().postData() ?? "{}")]);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, product: { id: "p1abcd", title: "Bread at home", hidden: true } }) });
  });
  await page.route("https://studio.test/api/store/vault", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    calls.push(["vault", body.action, body.ownerId ?? null, body.type ?? null]);
    if (body.action === "open") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, upload: { pathname: "v/f0/p1abcd/Bread-at-home.pdf", pieces: 1, pieceBytes: 8 * 1024 * 1024, multipart: true } }) });
    if (body.action === "sign") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, pieces: [{ number: 1, url: "https://studio.test/piece/1", type: "application/pdf" }] }) });
    if (body.action === "done") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, file: { pathname: "v/f0/p1abcd/Bread-at-home.pdf", bytes: 13, contentType: "application/pdf" } }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("https://studio.test/piece/1", (route) => route.fulfill({ status: 200, headers: { etag: '"e1"', "access-control-expose-headers": "ETag" }, body: "" }));
  await page.route("https://studio.test/api/store/file/attach", async (route) => {
    calls.push(["attach", JSON.parse(route.request().postData() ?? "{}")]);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  const open = async () => {
    await page.goto("https://studio.test/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole("heading", { name: "3. Download it" }).waitFor();
  };
  await open();

  // A refusal first: no title.
  answer = "title";
  await page.getByRole("button", { name: "Download the PDF" }).click();
  const alert = page.getByRole("alert");
  is("a refusal is said as an alert, in words, with focus on it", [await alert.textContent(), await page.evaluate(() => document.activeElement?.getAttribute("role"))], ["Give it a title first. The title is the first thing on the PDF.", "alert"]);

  // Written by keyboard: the title, then the first step.
  answer = "pdf";
  await page.getByLabel("Title").focus();
  await page.keyboard.type("Bread at home");
  await page.getByLabel("What goes under “Step 1”").fill("Mix flour and water.");
  await page.getByLabel("Heading of part 3").fill("");
  is("a heading cleared stays empty, and says what it is called then", [await page.getByLabel("Heading of part 3").inputValue(), await page.getByText("Left empty, it is called “Step 2”.").isVisible()], ["", true]);
  is("the count of parts written follows the writing", (await page.getByText(/parts written;/).textContent())?.startsWith("1 of "), true);
  await page.getByRole("button", { name: "Download the PDF" }).focus();
  const downloading = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  const download = await downloading;
  is("the file is downloaded under the title's name", download.suggestedFilename(), "Bread-at-home.pdf");
  const status = page.getByRole("status");
  is("then it says where to go next, with focus on that sentence", [(await status.textContent())?.startsWith("Downloaded “Bread-at-home.pdf”. Next, sell it:"), await page.evaluate(() => document.activeElement?.getAttribute("role")), await status.getByRole("link", { name: "Go to your products" }).getAttribute("href")], [true, "status", "/studio#products"]);
  const body = sent.at(-1);
  is("it sent the format, the answers, the title and exactly the outline's parts", [body.format, body.answers, body.title, body.parts.length, body.parts[1]], ["guide", { reader: "new", length: "short", tone: "friendly", ending: "summary" }, "Bread at home", 5, { heading: "", body: "Mix flour and water." }]);
  is("the notes are never sent", Object.hasOwn(body, "know"), false);

  // Make it a product draft: the price is empty and nothing is marked; a starting point fills it.
  is("after the download, the draft step appears, its price empty and its button off until a price is typed", [await page.getByRole("heading", { name: "4. Make it a product draft" }).isVisible(), await page.getByLabel("Price, in USD").inputValue(), await page.getByRole("button", { name: "Make the product draft" }).isDisabled()], [true, "", true]);
  is("no starting point is marked", await page.getByRole("button", { name: /^\$\d+(\.\d\d)?$/ }).evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-pressed"))), ["false", "false", "false"]);
  await page.getByRole("button", { name: "$19", exact: true }).click();
  is("a starting point fills the price and says it is chosen", [await page.getByLabel("Price, in USD").inputValue(), await page.getByRole("button", { name: "$19", exact: true }).getAttribute("aria-pressed")], ["19", "true"]);
  await page.getByRole("button", { name: "Make the product draft" }).click();
  const made = page.getByRole("status").filter({ hasText: "The draft" });
  await made.waitFor();
  is("the draft is made hidden, the PDF goes up as its file and is attached", calls.map((c) => c[0] === "vault" ? `vault:${c[1]}` : c[0]), ["draft", "vault:open", "vault:sign", "vault:done", "attach"]);
  is("with the title and price the creator chose, the file for that product, as a PDF", [calls[0][1], calls[1][2], calls[1][3], calls.at(-1)[1]], [{ title: "Bread at home", price: "19" }, "p1abcd", "application/pdf", { id: "p1abcd", pathname: "v/f0/p1abcd/Bread-at-home.pdf", name: "Bread-at-home.pdf" }]);
  is("it says the draft is hidden, with the file, to review and publish, with focus on it", [(await made.textContent())?.startsWith("The draft “Bread at home” is in your products, hidden, with the PDF as its file."), await page.evaluate(() => document.activeElement?.getAttribute("role"))], [true, "status"]);
  is("and a second press makes no second draft", await page.getByRole("button", { name: "Make the product draft" }).isDisabled(), true);

  // Kept on this device: a reload brings it back.
  await open();
  is("after a reload, what was written is back", [await page.getByLabel("Title").inputValue(), await page.getByLabel("What goes under “Step 1”").inputValue()], ["Bread at home", "Mix flour and water."]);

  // Choices by keyboard: a longer guide has more parts, and what was written stays.
  await page.getByRole("radio", { name: "Long: 8 steps" }).check();
  is("a longer guide has more parts, and the first one keeps its words", [await page.locator("textarea").count(), await page.getByLabel("What goes under “Step 1”").inputValue()], [1 + 1 + 8 + 1, "Mix flour and water."]);

  // Start over asks first.
  await page.getByRole("button", { name: "Start over" }).click();
  is("start over asks before clearing", await page.getByRole("button", { name: "Yes, clear what I wrote" }).isVisible(), true);
  await page.getByRole("button", { name: "Keep it" }).click();
  is("and keeping it changes nothing", await page.getByLabel("Title").inputValue(), "Bread at home");

  // Every control by Tab alone, none skipped or trapped.
  const controls = await page.evaluate(() => document.querySelectorAll("input:not([type=radio]), textarea, button, a[href]").length);
  await page.evaluate(() => document.body.focus());
  const reached = new Set();
  for (let i = 0; i < controls + 20; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => { const el = document.activeElement; if (!el || el === document.body) return null; if (!el.dataset.k) el.dataset.k = String(Math.random()); return el.dataset.k; });
    if (id) reached.add(id);
  }
  const named = await page.evaluate(() => [...document.querySelectorAll("input, textarea, button, a[href]")].filter((el) => el.dataset.k).length);
  is("Tab reaches every field, button and link (radio groups as one stop each)", named >= controls, true);

  // Names, roles, labels and structure.
  await page.addScriptTag({ content: axe });
  const result = await page.evaluate(async () => {
    const run = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag22aa"] }, rules: { "color-contrast": { enabled: false }, "color-contrast-enhanced": { enabled: false } } });
    return run.violations.map((v) => `${v.id}: ${v.nodes.length}`);
  });
  is("axe: no violation of names, roles, labels or structure", result, []);
  is("no error in the page", errors, []);
} finally {
  await browser.close();
}
console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exitCode = failures ? 1 : 0;
