/** Prove the real shipping form's locator with unrelated studio forms present. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { shippingForm } from "../../tests/e2e/shipping-save-confirmation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temp = mkdtempSync(join(tmpdir(), "codex-m-shipping-scope-"));
const productId = "synthetic_shipping";
// One local document, one real editor opening, zero POSTs or external routes.
const unrelatedForms = 27;
assert.equal(unrelatedForms, 27);
const common = `
import {createElement as h} from 'react';
import {AppRouterContext} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {ShippingEditor} from ${JSON.stringify(join(root, "components/shipping-editor.tsx"))};
const router={bfcacheId:'synthetic-shipping-scope',back(){},forward(){},refresh(){},push(){},replace(){},prefetch(){}};
const product={id:${JSON.stringify(productId)},priceCents:2500,shipping:{cents:500,region:'us',countries:['US'],note:'',sku:'Synthetic-SKU'}};
const unrelated=Array.from({length:${unrelatedForms}},(_,i)=>h('form',{key:i},h('input',{id:i===0?'ship-other-sku':'unrelated-'+i,defaultValue:'Other fixture'})));
const tree=()=>h(AppRouterContext.Provider,{value:router},h('main',null,...unrelated,h('div',{id:'shipping-fixture'},h(ShippingEditor,{product}))));
`;
let browser;
let server;
let checks = 0;
const failures = [];
function check(name, actual, expected) {
  checks += 1;
  try { assert.deepEqual(actual, expected); }
  catch { failures.push({ name, actual, expected }); }
}
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
    contents: common + `import {hydrateRoot} from 'react-dom/client';import {useEffect} from 'react';function Mounted(){useEffect(()=>{document.documentElement.dataset.fixtureReady='yes'},[]);return tree()}hydrateRoot(document.getElementById('app'),h(Mounted));`,
    resolveDir: root, loader: "tsx",
  } });
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app">${html}</div></body></html>`);
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let writes = 0;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) { writes += 1; return route.abort(); }
    return route.request().url() === origin + "/" ? route.continue() : route.abort();
  });
  await page.goto(origin);
  console.log("Shipping scope: real SSR document loaded");
  check("unrelated forms are actually present in SSR", await page.locator("form").count(), 27);
  check("the real closed shipping editor has no shipping form", await shippingForm(page, productId).count(), 0);
  check("the other product's form is selected only for its own id", await shippingForm(page, "other").count(), 1);
  await page.addScriptTag({ content: client.outputFiles[0].text });
  console.log("Shipping scope: hydration script supplied");
  await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "yes" && !document.querySelector("#shipping-fixture button")?.disabled);
  console.log("Shipping scope: real component ready");
  await page.locator("#shipping-fixture").getByRole("button", { name: "Change", exact: true }).click();
  await page.locator("#ship-" + productId + "-sku").waitFor();
  console.log("Shipping scope: real form opened");
  check("opening the real editor adds exactly one form", await page.locator("form").count(), 28);
  check("an actually open shipping form is still detected", await shippingForm(page, productId).count(), 1);
  check("the other product's form is still isolated after opening", await shippingForm(page, "other").count(), 1);
  check("the actual editor retains its own SKU", await page.locator("#ship-" + productId + "-sku").inputValue(), "Synthetic-SKU");
  check("the complete scope proof starts no write", writes, 0);
  check("the real component hydrates without errors", errors, []);
  console.log(JSON.stringify({ checks, failures, unrelatedForms, productiveRequests: 0 }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((closed) => server.close(closed));
  rmSync(temp, { recursive: true, force: true });
}
