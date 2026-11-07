/** Real Next interface pixels, loopback services and fictional canonical demo content only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { startServices } from "../../tests/e2e/services.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const { build } = require("esbuild");
const temporary = mkdtempSync(join(root, ".git-feature-capture-"));
if (process.argv.includes("--measure-route-bundle")) {
  try {
    const result = await build({entryPoints:[join(root,"app/platform/[slug]/page.tsx")],absWorkingDir:root,bundle:true,platform:"node",format:"cjs",packages:"external",write:false,metafile:true,alias:{"@":root},loader:{".css":"empty"},logLevel:"error",plugins:[{name:"synthetic-font-only",setup(plugin){plugin.onLoad({filter:/\/components\/morning-fonts\.tsx?$/},()=>({contents:'export const MORNING_FONTS="";',loader:"ts"}));}}]});
    const output = Buffer.concat(result.outputFiles.map(file=>Buffer.from(file.contents)));
    const captureBytes = Object.values(result.metafile.outputs).reduce((sum,file)=>sum+(file.inputs["lib/feature-captures.ts"]?.bytesInOutput??0),0);
    console.log(JSON.stringify({scope:"esbuild actual platform dynamic route server dependency graph; packages external, font substituted; not Next production or hydration",bytes:output.length,gzipBytes:gzipSync(output).length,captureModuleBytes:captureBytes}));
  } finally { rmSync(temporary,{recursive:true,force:true}); }
  process.exit(0);
}
if (process.argv.includes("--verify-component")) {
  const pageSlug = process.env.T_VERIFY_PAGE;
  if (pageSlug && !["store-page", "sales-pages"].includes(pageSlug)) throw Error("Unsupported resource page");
  // Independent rendering of our new component while the shared hero remains reserved.
  // No integration/hydration/global AAA claim follows from this isolated check.
  let previewBrowser;
  try {
    const entry = join(temporary, "component.cjs");
    await build({ stdin: { contents: (pageSlug ? `import {renderToStaticMarkup} from 'react-dom/server';import {TopicPageView} from './components/topic-page';import {findPage} from './lib/site-pages';import {FeatureCapture,hasFeatureCapture} from './components/feature-captures';console.log(JSON.stringify({html:renderToStaticMarkup(<TopicPageView page={findPage("platform",${JSON.stringify(pageSlug)})}/>),unknown:renderToStaticMarkup(<FeatureCapture slug="crm"/>),known:[hasFeatureCapture("store-page"),hasFeatureCapture("sales-pages")],unknownKnown:hasFeatureCapture("crm")}));` : `import {renderToStaticMarkup} from 'react-dom/server';import {FeatureCapture,hasFeatureCapture} from './components/feature-captures';import {FEATURE_CAPTURES} from './lib/feature-captures';console.log(JSON.stringify({html:renderToStaticMarkup(<main>{FEATURE_CAPTURES.map(c=><FeatureCapture key={c.slug} slug={c.slug}/>)}</main>),unknown:renderToStaticMarkup(<FeatureCapture slug="crm"/>),known:FEATURE_CAPTURES.map(c=>hasFeatureCapture(c.slug)),unknownKnown:hasFeatureCapture('crm')}));`), resolveDir: root, loader: "tsx" }, bundle: true, jsx: "automatic", platform: "node", format: "cjs", packages: "external", outfile: entry, alias: { "@": root }, logLevel: "error", banner: { js: 'globalThis.fetch=async()=>{throw Error("Nonlocal resource SSR fetch refused")};' }, plugins: [{name:"synthetic-font-only",setup(plugin){plugin.onLoad({filter:/\/components\/morning-fonts\.tsx?$/},()=>({contents:'export const MORNING_FONTS="";',loader:"ts"}));}}] });
    const rendered = spawnSync(process.execPath, [entry], { cwd: root, encoding: "utf8", maxBuffer: 4_000_000 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const fixture = JSON.parse(rendered.stdout);
    assert.equal(fixture.unknown, "");
    assert.deepEqual(fixture.known, [true, true]);
    assert.equal(fixture.unknownKnown, false);
    const { compile } = require("@tailwindcss/node");
    const compiler = await compile(readFileSync(join(root, "app/globals.css"), "utf8"), { base: root, onDependency() {} });
    const classes = [...fixture.html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/));
    const css = compiler.build(classes) + (pageSlug ? readFileSync(join(root,"app/home.css"),"utf8") + readFileSync(join(root,"app/platform/[slug]/focus-scroll.css"),"utf8") : "");
    previewBrowser = await require("playwright-core").chromium.launch({ headless: true });
    for (const width of [390, 1440]) {
      const context = await previewBrowser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      try {
        let refused = 0, localAssetRequests = 0;
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if(url.origin==="http://127.0.0.1:3217" && /^\/feature-captures\/(store-page|sales-pages)\.webp$/.test(url.pathname) && route.request().method()==="GET"){
            localAssetRequests++;
            return route.fulfill({contentType:"image/webp",body:readFileSync(join(root,"public",url.pathname))});
          }
          refused++; return route.abort();
        });
        const page = await context.newPage();
        await page.setContent('<!doctype html><html lang="en"><head><base href="http://127.0.0.1:3217/"><style>' + css + '</style></head><body>' + fixture.html + '</body></html>');
        const figures = page.locator("figure[data-feature-capture]");
        assert.equal(await figures.count(), pageSlug ? 1 : 2);
        for (const figure of await figures.all()) {
          const image = figure.locator("img");
          await image.scrollIntoViewIfNeeded();
          await image.evaluate(node => node.decode());
          assert.deepEqual(await image.evaluate(node => [node.naturalWidth, node.naturalHeight]), [1280, 820]);
          const text = await figure.locator("figcaption").innerText();
          assert.match(text, /November 6, 2026/);
          assert.match(text, /fictional test content/);
          assert.match(text, /not a customer result/);
          assert.ok(await figure.evaluate(node => node.scrollWidth <= node.clientWidth));
          assert.ok(await figure.locator("figcaption").evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.addScriptTag({ content: readFileSync(require.resolve("axe-core/axe.min.js"), "utf8") });
        const audit = await (pageSlug ? figures.first() : page.locator("main")).evaluate(async node => {
          const result = await window.axe.run(node, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21aa", "wcag22aa"] } });
          return { violations: result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), incomplete: result.incomplete.map(v => v.id) };
        });
        assert.deepEqual(audit.violations, []);
        assert.equal(refused, 0);
        if (pageSlug && process.env.T_CAPTURE_DIRECTORY) { mkdirSync(process.env.T_CAPTURE_DIRECTORY,{recursive:true}); await figures.first().screenshot({path:join(process.env.T_CAPTURE_DIRECTORY,pageSlug+"-"+width+".png")}); }
        console.log(JSON.stringify({ scope: pageSlug ? "actual TopicPageView SSR and actual CSS; capture figure axe scope; no Next hydration or global AAA" : "isolated real capture component, actual CSS, system font; not shared hero integration or global AAA", pageSlug, width, htmlBytes:Buffer.byteLength(fixture.html), decodedCaptures: pageSlug ? 1 : 2, unknownSlug: "empty", localAssetRequests, refused, ...audit }));
      } finally { await context.close(); }
    }
  } finally { await previewBrowser?.close(); rmSync(temporary, { recursive: true, force: true }); }
  process.exit(0);
}
const origin = "http://127.0.0.1:3216", fake = "http://127.0.0.1:4516";
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const captureDirectory = process.env.T_CAPTURE_DIRECTORY ? resolve(process.env.T_CAPTURE_DIRECTORY) : temporary;
mkdirSync(captureDirectory, { recursive: true });
// No inherited account credentials. Font/service substitutes are explicitly local.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
  DEMO_STUDIO_ADMIN: "operator@example.test", STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  UPSTASH_REDIS_REST_URL: fake, UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in", RESEND_API_BASE: fake,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in", STRIPE_CONNECT_API_BASE: fake,
  ANTHROPIC_API_KEY: "sk-ant-local_only_" + "x".repeat(30), ANTHROPIC_API_BASE: fake,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(root, "tests/e2e/google-fonts-mock.cjs"), E2E_FONT_ORIGIN: fake,
};
const guard = join(temporary, "local-fetch.mjs");
writeFileSync(guard, `const original=globalThis.fetch;globalThis.fetch=(input,...args)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname))throw Error('Nonlocal capture fetch refused: '+u.origin);return original(input,...args);};`);
env.NODE_OPTIONS = "--import=" + guard;
const services = await startServices(4516);
let app, browser, appOutput = "";
const run = (args) => new Promise((accept, reject) => {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  child.once("error", reject);
  child.once("exit", code => code === 0 ? accept(output) : reject(Error(output.slice(-4000))));
});
try {
  const seed = join(temporary, "seed.cjs");
  await build({ entryPoints: [join(root, "tests/e2e/store-copy-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seed, logLevel: "error", alias: { "@": root } });
  const fixture = JSON.parse((await run([seed])).trim().split("\n").at(-1)).homeDemo;
  assert.ok(fixture?.session && fixture?.sid && fixture?.product);
  console.log("CAPTURE_STAGE local fictional fixture seeded");
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "-p", "3216"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", chunk => { appOutput = (appOutput + chunk).slice(-6000); process.stderr.write(chunk); });
  let ready = false;
  for (let n = 0; n < 120; n++) {
    if (app.exitCode !== null) throw Error(appOutput);
    try { ready = (await fetch(origin + "/robots.txt", { signal: AbortSignal.timeout(2000) })).ok; } catch { /* Wait for local listening only. */ }
    if (ready) break;
    await new Promise(accept => setTimeout(accept, 500));
  }
  assert.ok(ready, "local Next server is ready: " + appOutput);
  browser = await require("playwright-core").chromium.launch({ headless: true });
  const captures = [];
  for (const spec of [
    { slug: "store-page", context: "Demo store", sourcePath: "/@harborkitchenpreview", alt: "The fictional Harbor Kitchen profile above three product cards, with product titles and price badges, in the actual Marktmorgen store interface." },
    { slug: "sales-pages", context: "Synthetic studio", sourcePath: "/studio/pages?store=" + fixture.sid + "&product=" + fixture.product, alt: "The product list beside the fictional Weekly Meal Planner editor, with Build and Preview tabs and a page coach score, in the actual Marktmorgen studio." },
  ]) {
    // Capture server-rendered real pixels without starting automatic client analytics.
    // The hydrated store attempted POST /api/store/hit (blocked by the guard).
    // Keep the zero-mutation assertion; this is explicitly not a hydration proof.
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1, reducedMotion: "reduce", serviceWorkers: "block", javaScriptEnabled: false });
    let refusedExternal = 0, refusedWrites = 0;
    const refusedWriteRequests = [];
    try {
      if (spec.context === "Synthetic studio") await context.addCookies([{ name: "nl_session", value: fixture.session, url: origin }]);
      await context.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin) { refusedExternal++; return route.abort(); }
        if (!["GET", "HEAD"].includes(request.method())) { refusedWrites++; refusedWriteRequests.push({ method: request.method(), path: url.pathname }); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      const response = await page.goto(origin + spec.sourcePath, { waitUntil: "networkidle", timeout: 120000 });
      assert.equal(response.status(), 200);
      assert.ok(!new URL(page.url()).pathname.startsWith("/signin"), "actual authenticated fixture, not sign-in");
      await page.locator("main h1").waitFor({ state: "visible" });
      await page.evaluate(() => document.fonts.ready);
      const visible = await page.locator("body").innerText();
      assert.match(visible, /Harbor Kitchen|Weekly Meal Planner/);
      assert.doesNotMatch(visible, /home-demo@example\.test|operator@example\.test/);
      const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1280, height: 820 } });
      const pixels = await require("sharp")(png).webp({ quality: 78 }).toBuffer();
      assert.ok(pixels.length <= 100_000, "publish ceiling checked before static payload creation");
      const metadata = await require("sharp")(pixels).metadata();
      assert.deepEqual([metadata.width, metadata.height], [1280, 820]);
      const capturedAt = new Date().toISOString();
      const sha256 = createHash("sha256").update(pixels).digest("hex");
      writeFileSync(join(captureDirectory, spec.slug + ".webp"), pixels);
      captures.push({ ...spec, sourceCommit, capturedAt, width: 1280, height: 820, sha256, src: "/feature-captures/" + spec.slug + ".webp" });
      console.log(JSON.stringify({ slug: spec.slug, sourceCommit, capturedAt, bytes: pixels.length, sha256, refusedExternal, refusedWrites, refusedWriteRequests, browser: browser.version(), scope: "actual Next development SSR; JavaScript disabled to prevent analytics; local synthetic services and substitute font; no hydration/provider/account/payment" }));
      assert.equal(refusedWrites, 0, "capture makes no browser mutation");
    } finally { await context.close(); }
  }
  assert.equal(services.checkouts().length, 0);
  assert.equal(services.emails().length, 0);
  assert.equal(services.writing().length, 0);
  assert.equal(services.subscriptionUpdates().length, 0);
  writeFileSync(join(captureDirectory, "feature-captures.ts"), "/** Actual application pixels; isolated fictional fixtures, dated per capture. */\nexport const FEATURE_CAPTURES = " + JSON.stringify(captures, null, 2) + " as const;\n");
  console.log("CAPTURES_COMPLETE " + captureDirectory);
} catch (error) {
  console.error(appOutput);
  throw error;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { const ended = new Promise(accept => app.once("exit", accept)); app.kill("SIGTERM"); await ended; }
  await services.close();
  rmSync(temporary, { recursive: true, force: true });
}
