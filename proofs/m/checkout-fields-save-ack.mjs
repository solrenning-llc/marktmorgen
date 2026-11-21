/** Isolated real-component proof. No signed-in app, Redis or external provider. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const component = join(root, "components/checkout-fields-editor.tsx");
const sourceBlob = execFileSync("git", ["hash-object", component], { cwd: root, encoding: "utf8" }).trim();
const expectedBlob = process.argv.find((argument) => argument.startsWith("--expected-blob="))?.slice("--expected-blob=".length) ?? "48397330d47572bd875b1dcb716168152b314033";
assert.match(expectedBlob, /^[a-f0-9]{40}$/, "name the exact product blob before running the proof");
assert.equal(sourceBlob, expectedBlob, "freeze the product source under review");
const cases = [
  { name: "confirmed", status: 200, body: { ok: true }, accepted: true },
  { name: "explicit-refusal", status: 200, body: { ok: false, error: "signed_out" }, accepted: false },
  { name: "string-ok", status: 200, body: { ok: "true" }, accepted: false },
  { name: "failed-http", status: 503, body: { ok: true }, accepted: false },
];
// Admit the complete synthetic exercise BEFORE the first request. Every page
// gets one local POST <=4 KiB and one JSON response <=128 B. No external route.
assert.equal(cases.length, 4);
for (const item of cases) assert.ok(Buffer.byteLength(JSON.stringify(item.body)) <= 128);
const temp = mkdtempSync(join(tmpdir(), "codex-m-fields-ack-"));
const failures = [];
let checks = 0;
let browser;
let server;
function check(name, actual, expected) {
  checks += 1;
  try { assert.deepEqual(actual, expected); }
  catch { failures.push({ name, actual, expected }); }
}
const common = `
import {createElement as h} from 'react';
import {AppRouterContext} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {CheckoutFieldsEditor} from ${JSON.stringify(component)};
const router={bfcacheId:'synthetic-save',back(){},forward(){},refresh(){window.mObserved.refresh++},push(){},replace(){},prefetch(){}};
const product={id:'synthetic_questions',priceCents:2500,fields:[]};
const tree=()=>h(AppRouterContext.Provider,{value:router},h(CheckoutFieldsEditor,{product}));
`;
try {
  const options = { bundle: true, write: false, absWorkingDir: root, tsconfig: join(root, "tsconfig.json"), logLevel: "error" };
  const ssr = await build({ ...options, platform: "node", format: "cjs", stdin: {
    contents: common + `import {renderToString} from 'react-dom/server';console.log(JSON.stringify(renderToString(tree())));process.exit(0);`,
    resolveDir: root, loader: "tsx",
  } });
  const serverFile = join(temp, "ssr.cjs");
  writeFileSync(serverFile, ssr.outputFiles[0].text);
  const render = spawnSync(process.execPath, [serverFile], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 5e6 });
  if (render.status !== 0) throw Error(render.stderr || String(render.error));
  const html = JSON.parse(render.stdout);
  const client = await build({ ...options, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" }, stdin: {
    contents: common + `import {hydrateRoot} from 'react-dom/client';import {useEffect} from 'react';window.mObserved={refresh:0,toasts:[]};window.addEventListener('nimbus:toast',e=>window.mObserved.toasts.push(e.detail));function Mounted(){useEffect(()=>{document.documentElement.dataset.fixtureReady='yes'},[]);return tree()}hydrateRoot(document.getElementById('app'),h(Mounted));`,
    resolveDir: root, loader: "tsx",
  } });
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app">${html}</div></body></html>`);
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const item of cases) {
    const page = await browser.newPage();
    const posts = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (url !== origin + "/" && url !== origin + "/api/store/fields") return route.abort();
      if (request.method() !== "POST") return route.continue();
      if (url !== origin + "/api/store/fields" || posts.length >= 1) return route.abort();
      const body = request.postData() ?? "";
      assert.ok(Buffer.byteLength(body) <= 4096, "pre-admitted local POST ceiling");
      posts.push(JSON.parse(body));
      return route.fulfill({ status: item.status, contentType: "application/json", body: JSON.stringify(item.body) });
    });
    await page.goto(origin);
    await page.addScriptTag({ content: client.outputFiles[0].text });
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "yes" && !document.querySelector("button")?.disabled);
    await page.getByRole("button", { name: "Ask the buyer something at checkout", exact: true }).click();
    await page.locator('input[type="text"]').first().fill("Synthetic question");
    const replied = page.waitForResponse((response) => response.url() === origin + "/api/store/fields");
    await page.getByRole("button", { name: "Save the questions", exact: true }).click();
    await replied;
    await page.waitForFunction(() => !document.querySelector("form") || !!document.querySelector('[role="alert"]'));
    const observed = await page.evaluate(() => ({ form: !!document.querySelector("form"), ...window.mObserved }));
    check(item.name + ": exactly one admitted local POST", posts.length, 1);
    check(item.name + ": real form submitted its entered question", posts[0]?.fields?.[0]?.label, "Synthetic question");
    check(item.name + ": close only after confirmed success", observed.form, !item.accepted);
    check(item.name + ": refresh only after confirmed success", observed.refresh, item.accepted ? 1 : 0);
    check(item.name + ": toast only after confirmed success", observed.toasts, item.accepted ? ["Checkout questions saved."] : []);
    // A failed HTTP status is deliberately logged by Chromium as a resource
    // error; it is the fixture's injected response, not a hydration failure.
    const hydrationErrors = errors.filter((message) => !message.startsWith("Failed to load resource: the server responded with a status of 503"));
    check(item.name + ": no hydration or page errors", hydrationErrors, []);
    await page.close();
  }
  console.log(JSON.stringify({ sourceBlob, checks, failures, localPostCeiling: 4, externalRequests: 0 }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((resolveClosed) => server.close(resolveClosed));
  rmSync(temp, { recursive: true, force: true });
}
