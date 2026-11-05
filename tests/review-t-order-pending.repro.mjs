/** Independent browser proof for #2415. Only a local server and intercepted writes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = process.cwd();
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { PageOrderEditor } from "@/components/page-order-editor";
import { USUAL_ORDER } from "@/lib/store-order";
createRoot(document.getElementById("root")).render(<>
  <a href="/away">Path</a>
  <PageOrderEditor order={[...USUAL_ORDER]} on={Object.fromEntries(USUAL_ORDER.map(p => [p, true]))}/>
</>);
`;
const output = await build({
  stdin: { contents: source, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, logLevel: "error",
  plugins: [{ name: "navigation-shell", setup(builder) {
    builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "router", namespace: "shell" }));
    builder.onLoad({ filter: /.*/, namespace: "shell" }, () => ({
      contents: "export function useRouter(){ return { refresh(){} }; }", loader: "js",
    }));
  } }],
});
const bundle = output.outputFiles[0].text;
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/app.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(bundle); return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(request.url === "/away" ? "<!doctype html><p>Left the draft</p>" :
    '<!doctype html><html lang="en"><head><title>Local order review</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const findings = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  findings.push({ name, pass, actual, expected });
}
async function unloadProtected(page) {
  return page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
}
async function move(page) {
  await page.getByRole("button", { name: "Move What you sell down", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[data-order-part]")?.getAttribute("data-order-part") === "quotes");
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}
try {
  browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let release;
  let requestSeen;
  const seen = new Promise(resolve => { requestSeen = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/api/store/order", async route => {
    requestSeen(); await held;
    try { await route.fulfill({ status: 503, contentType: "application/json", body: '{"ok":false}' }); } catch { /* The pending request was abandoned by navigation. */ }
  });
  await page.goto(base);
  await page.locator('[data-order-ready="true"]').waitFor();
  check("clean control has no unload confirmation", await unloadProtected(page), false);
  await move(page);
  check("idle draft control protects unload", await unloadProtected(page), true);
  const draft = await page.locator("[data-order-part]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-order-part")));
  await page.getByRole("button", { name: "Save the order", exact: true }).click();
  await seen;
  await page.locator('#order[aria-busy="true"]').waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  check("unconfirmed save keeps unload protection", await unloadProtected(page), true);
  const notices = [];
  page.on("dialog", async dialog => { notices.push(dialog.message()); await dialog.dismiss(); });
  await page.getByRole("link", { name: "Path", exact: true }).focus();
  await page.getByRole("link", { name: "Path", exact: true }).press("Enter");
  await page.waitForLoadState();
  check("pending save asks before keyboard navigation", notices,
    ["You have changes that are not saved. Leave without saving them?"]);
  check("choosing to stay keeps the order document", new URL(page.url()).pathname, "/");
  check("choosing to stay keeps the pending draft",
    await page.locator("[data-order-part]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-order-part"))), draft);
  release();
  check("no browser exception caused the result", errors, []);
  console.log(JSON.stringify(findings, null, 2));
  assert.equal(findings.filter(f => !f.pass).length, 0, "an unconfirmed save must not expose an unprotected draft");
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
