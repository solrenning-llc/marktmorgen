/** Real-component ACK evidence, architecture credited to Codex M 948d2c88. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(process.argv[2] ?? evidenceRoot);
const expectedSourceBlob = (process.argv[3] ?? "d38fe5553e45b3e214a7f46ceb5052bd218940a7").toLowerCase();
assert.match(expectedSourceBlob, /^[a-f0-9]{40}$/, "the expected source blob must be a complete Git SHA");
const component = join(sourceRoot, "components/forms-editor.tsx");
const sourceBlob = execFileSync("git", ["hash-object", component], { cwd: sourceRoot, encoding: "utf8" }).trim();
assert.equal(sourceBlob, expectedSourceBlob, "confirm the caller-selected product source before any browser request");
const sourceRequire = createRequire(join(sourceRoot, "package.json"));
const { build } = sourceRequire("esbuild");
const { chromium } = sourceRequire("playwright-core");
// Keep framework identity and every @/ product import in the selected source
// checkout, while the immutable fixture stays in this evidence checkout.
const alias = {
  "@": sourceRoot,
  react: dirname(sourceRequire.resolve("react/package.json")),
  "react-dom": dirname(sourceRequire.resolve("react-dom/package.json")),
  next: dirname(sourceRequire.resolve("next/package.json")),
};
const cases = [
  { name: "confirmed", status: 200, body: { ok: true }, accepted: true },
  { name: "explicit-refusal", status: 200, body: { ok: false, error: "server_error" }, accepted: false },
  { name: "string-ok", status: 200, body: { ok: "true" }, accepted: false },
  { name: "failed-http", status: 503, body: { ok: true }, accepted: false },
];
// Admit the entire exercise before building or starting the local server.
const POST_CEILING = 4, POST_BYTES = 4096, RESPONSE_BYTES = 128;
assert.equal(cases.length, POST_CEILING);
for (const item of cases) assert.ok(Buffer.byteLength(JSON.stringify(item.body)) <= RESPONSE_BYTES);
const temp = mkdtempSync(join(tmpdir(), "k2-form-save-ack-"));
const failures = [], observations = [];
let checks = 0, localPosts = 0, forbiddenRequests = 0;
let browser, server;
function check(name, actual, expected) {
  checks++;
  try { assert.deepEqual(actual, expected); }
  catch { failures.push({ name, actual, expected }); }
}
const common = `
import {createElement as h} from 'react';
import {FormSaveAckProofRoot,installFormSaveObservation} from ${JSON.stringify(join(evidenceRoot, "tests/k-form-save-ack.proof.ts"))};
`;
try {
  const options = { bundle: true, write: false, absWorkingDir: sourceRoot, tsconfig: join(sourceRoot, "tsconfig.json"), alias, logLevel: "error" };
  const ssr = await build({ ...options, platform: "node", format: "cjs", stdin: {
    contents: common + `import {renderToString} from 'react-dom/server';console.log(JSON.stringify(renderToString(h(FormSaveAckProofRoot))));process.exit(0);`,
    resolveDir: sourceRoot, loader: "tsx",
  } });
  const ssrFile = join(temp, "ssr.cjs");
  writeFileSync(ssrFile, ssr.outputFiles[0].text);
  const rendered = spawnSync(process.execPath, [ssrFile], { cwd: sourceRoot, encoding: "utf8", timeout: 10000, maxBuffer: 5e6 });
  if (rendered.status !== 0) throw Error(rendered.stderr || String(rendered.error));
  const html = JSON.parse(rendered.stdout);
  const client = await build({ ...options, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '\"production\"', "process.env": "{}" }, stdin: {
    contents: common + `import {hydrateRoot} from 'react-dom/client';installFormSaveObservation();hydrateRoot(document.getElementById('app'),h(FormSaveAckProofRoot));`,
    resolveDir: sourceRoot, loader: "tsx",
  } });
  server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="app">${html}</div></body></html>`);
  });
  await new Promise(ready => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const item of cases) {
    const page = await browser.newPage();
    const posts = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/*", async route => {
      const request = route.request(), url = request.url();
      if (url !== origin + "/" && url !== origin + "/api/store/forms") { forbiddenRequests++; return route.abort(); }
      if (request.method() !== "POST") return route.continue();
      if (url !== origin + "/api/store/forms" || posts.length >= 1 || localPosts >= POST_CEILING) {
        forbiddenRequests++; return route.abort();
      }
      const body = request.postData() ?? "";
      assert.ok(Buffer.byteLength(body) <= POST_BYTES, "admitted local POST bytes before fulfillment");
      posts.push(JSON.parse(body)); localPosts++;
      return route.fulfill({ status: item.status, contentType: "application/json", body: JSON.stringify(item.body) });
    });
    await page.goto(origin);
    await page.addScriptTag({ content: client.outputFiles[0].text });
    await page.waitForFunction(() => document.documentElement.dataset.fixtureReady === "yes");
    await page.getByRole("button", { name: "New form", exact: true }).click();
    await page.getByPlaceholder("Application for coaching", { exact: true }).fill("Synthetic form");
    const replied = page.waitForResponse(response => response.url() === origin + "/api/store/forms");
    await page.getByRole("button", { name: "Save form", exact: true }).click();
    await replied;
    // Both confirmed success and explicit refusal have observable terminal UI.
    // No fixed sleep, changed timeout, mocked hook, or product-source rewrite.
    await page.waitForFunction(() => !document.querySelector('input[placeholder="Application for coaching"]') || !!document.querySelector('[role="alert"]'));
    const observed = await page.evaluate(() => ({
      editor: !!document.querySelector('input[placeholder="Application for coaching"]'),
      ...window.k2FormSaveObservation,
    }));
    observations.push({ name: item.name, status: item.status, observed });
    check(item.name + ": exactly one admitted local POST", posts.length, 1);
    check(item.name + ": entered form was submitted", posts[0]?.form?.name, "Synthetic form");
    check(item.name + ": close only on confirmed success", observed.editor, !item.accepted);
    check(item.name + ": refresh only on confirmed success", observed.refresh, item.accepted ? 1 : 0);
    check(item.name + ": toast only on confirmed success", observed.toasts, item.accepted ? ["Form made."] : []);
    const hydrationErrors = errors.filter(message => !message.startsWith("Failed to load resource: the server responded with a status of 503"));
    check(item.name + ": no hydration or page error", hydrationErrors, []);
    await page.close();
  }
  assert.equal(localPosts, POST_CEILING);
  assert.equal(forbiddenRequests, 0);
  console.log(JSON.stringify({ evidenceRoot, sourceRoot, expectedSourceBlob, sourceBlob, browser: browser.version(), checks, failures, observations,
    bounds: { localPosts, postBytes: POST_BYTES, responseBytes: RESPONSE_BYTES }, forbiddenRequests }, null, 2));
  if (failures.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(closed => server.close(closed));
  rmSync(temp, { recursive: true, force: true });
}
