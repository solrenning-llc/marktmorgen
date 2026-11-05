/** Run from the repository root. Synthetic metadata; localhost; Chromium only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { checkPdfStampAcknowledgment } from './e2e/pdf-stamp-acknowledgment.mjs';
const root = process.cwd();
const directory = mkdtempSync(join(tmpdir(), 'i2-pdf-hydration-'));
const product = { id: 'review_stamp', stamp: false, file: { name: 'synthetic.pdf', contentType: 'application/pdf', bytes: 1000, url: 'https://example.test/synthetic.pdf' }, options: [] };
const app = `import React from 'react'; import {PdfStampToggle} from '@/components/pdf-stamp-toggle'; import {Toaster} from '@/components/toast'; const product=${JSON.stringify(product)}; function App(){return <><main><details open><summary>Synthetic product</summary><PdfStampToggle product={product}/></details></main><Toaster/></>}`;
const plugin = { name: 'synthetic-router-refresh', setup(builder) {
  builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'router', namespace: 'review' }));
  builder.onLoad({ filter: /.*/, namespace: 'review' }, () => ({ contents: 'export function useRouter(){return {refresh(){}}}', loader: 'js' }));
} };
let server, browser;
let checks = 0;
const pageErrors = [];
const is = (name, actual, expected) => { checks++; assert.deepEqual(actual, expected, name); };
try {
  const options = { bundle: true, write: false, logLevel: 'error', alias: { '@': root }, plugins: [plugin], define: { 'process.env.NODE_ENV': '"production"' } };
  const ssr = await build({ ...options, platform: 'node', format: 'cjs', stdin: { contents: app + "; import {renderToString} from 'react-dom/server'; module.exports=renderToString(<App/>);", resolveDir: root, loader: 'tsx' } });
  const ssrFile = join(directory, 'ssr.cjs');
  writeFileSync(ssrFile, ssr.outputFiles[0].text);
  const markup = createRequire(import.meta.url)(ssrFile);
  const client = await build({ ...options, platform: 'browser', format: 'iife', stdin: { contents: app + "; import {hydrateRoot} from 'react-dom/client'; window.runReviewHydration=()=>hydrateRoot(document.getElementById('root'),<App/>);", resolveDir: root, loader: 'tsx' } });
  server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'application/javascript; charset=utf-8'); response.end(client.outputFiles[0].text); return; }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;padding:12px;overflow-wrap:anywhere}</style></head><body><div id="root">' + markup + '</div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const LOCAL = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true, ...(process.env.REVIEW_CHROMIUM ? { executablePath: process.env.REVIEW_CHROMIUM } : {}) });
  const control = await browser.newPage();
  let prematurePosts = 0;
  control.on('request', request => { if (request.method() === 'POST') prematurePosts++; });
  await control.goto(LOCAL + '/studio');
  const input = control.locator('#stamp-review_stamp');
  is('real SSR checkbox is visible before hydration', await input.isVisible(), true);
  is('SSR node has no installed React handler', await input.evaluate(element => Object.keys(element).some(key => key.startsWith('__reactProps$') && typeof element[key]?.onChange === 'function')), false);
  await input.click();
  is('early native click changes the DOM checkbox', await input.isChecked(), true);
  is('early native click has no application POST', prematurePosts, 0);
  await control.close();
  const gatedBrowser = { async newContext(options) {
    const context = await browser.newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      page.on('pageerror', error => { pageErrors.push(error.message); });
      const originalWait = page.waitForFunction.bind(page);
      page.waitForFunction = async (condition, argument, options) => {
        const waiting = originalWait(condition, argument, options);
        waiting.catch(() => {});
        if (String(condition).includes('__reactProps$')) {
          is('exact production gate is false before hydration', await page.evaluate(condition, argument), false);
          await page.evaluate(() => window.runReviewHydration());
          const result = await waiting;
          is('exact production gate becomes true after real React hydration', await page.evaluate(condition, argument), true);
          return result;
        }
        return waiting;
      };
      return page;
    };
    return context;
  } };
  await checkPdfStampAcknowledgment({ browser: gatedBrowser, LOCAL, fixture: { product: product.id, sid: 'synthetic', session: 'synthetic-session' }, is });
  const source = readFileSync(join(root, 'tests/e2e/pdf-stamp-acknowledgment.mjs'), 'utf8');
  const table = source.slice(source.indexOf('const cases=['), source.indexOf('for(const width of'));
  is('unchanged scenario table contains thirteen cases', (table.match(/name:/g) ?? []).length, 13);
  is('real hydration and scenarios raise no page errors', pageErrors, []);
  console.log(JSON.stringify({ checks, react: '19.2.8', browser: 'Chromium', providerCalls: 0, scope: 'real component and exact browser helper; synthetic router, CSS, metadata and POST replies' }));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
