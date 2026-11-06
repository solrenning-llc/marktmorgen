// Isolated real-page SSR and real CSS. No Next hydration, provider, or production timing claim.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const { build } = require("esbuild");
const { compile } = require("@tailwindcss/node");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(root, "tests/test-config.mjs")));
const baseline = "8bb21d01614fc1b7830a0ae7e8f7c512ca98673f";
const temporary = mkdtempSync(join(root, ".git-pricing-proof-"));
const results = [];
let browser;
try {
  const fixtures = {};
  for (const mode of ["before", "after"]) {
    const built = await build({
      stdin: { contents: `import {renderToStaticMarkup} from 'react-dom/server';import Page from './app/pricing/page';import {PRICING_GROUPS,PRICING_PLANS} from './lib/pricing-page-data';import {contrast} from './lib/store-look';console.log(JSON.stringify({html:renderToStaticMarkup(Page()),groups:PRICING_GROUPS,plans:PRICING_PLANS,contrast:{white:contrast('#1e3a8a','#ffffff'),blue:contrast('#1e3a8a','#eaf3ff')}}));`, resolveDir: root, loader: "tsx" },
      bundle: true, platform: "node", format: "cjs", packages: "external", write: false,
      alias: testAliases("pricing-section-navigation.test.ts", root, join(root, "tests")),
      loader: { ".css": "empty" }, logLevel: "error",
      banner: { js: 'globalThis.fetch=async()=>{throw new Error("External request refused in isolated pricing SSR")};' },
      plugins: [{ name: "isolated-font-and-baseline", setup(plugin) {
        // Font classes only; do not replace a page, component, value, or control.
        plugin.onLoad({ filter: /\/components\/morning-fonts\.tsx?$/ }, () => ({ contents: 'export const MORNING_FONTS="";', loader: "ts" }));
        if (mode === "before") plugin.onLoad({ filter: /\/app\/pricing\/page\.tsx$/ }, () => ({ contents: execFileSync("git", ["show", baseline + ":app/pricing/page.tsx"], { cwd: root, encoding: "utf8" }), loader: "tsx", resolveDir: join(root, "app/pricing") }));
      } }],
    });
    const entry = join(temporary, mode + ".cjs");
    writeFileSync(entry, built.outputFiles[0].text);
    const rendered = spawnSync(process.execPath, [entry], { cwd: root, encoding: "utf8", env: testEnvironment({ ...process.env, NODE_PATH: join(root, "node_modules") }), maxBuffer: 12000000 });
    if (rendered.status !== 0) throw new Error(rendered.stderr || String(rendered.error));
    const fixture = JSON.parse(rendered.stdout);
    const classes = [...fixture.html.matchAll(/class="([^"]*)"/g)].flatMap(match => match[1].split(/\s+/));
    const compiler = await compile(readFileSync(join(root, "app/globals.css"), "utf8"), { base: root, onDependency() {} });
    fixture.css = compiler.build(classes) + readFileSync(join(root, "app/home.css"), "utf8") + (mode === "after" ? readFileSync(join(root, "app/pricing/pricing.css"), "utf8") : "");
    fixtures[mode] = fixture;
  }
  assert.deepEqual(fixtures.after.groups, fixtures.before.groups, "the entire canonical matrix is unchanged");
  assert.deepEqual(fixtures.after.plans, fixtures.before.plans, "all plan values are unchanged");
  browser = await require("playwright-core").chromium.launch({ headless: true });
  for (const width of [320, 390, 1440]) for (const mode of ["before", "after"]) {
    const fixture = fixtures[mode];
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    let blocked = 0, writes = 0;
    try {
      await context.route("**/*", route => {
        const request = route.request();
        if (request.method() !== "GET") writes++;
        if (request.isNavigationRequest() && request.url().split("#")[0] === "http://pricing.test/pricing") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + fixture.css + '</style></head><body>' + fixture.html + "</body></html>" });
        blocked++;
        return route.abort();
      });
      const page = await context.newPage();
      await page.goto("http://pricing.test/pricing", { waitUntil: "load" });
      const initial = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth, viewport: innerWidth }));
      const record = { mode, width, ...initial, rows: fixture.groups.reduce((sum, group) => sum + group.rows.length, 0) };
      if (mode === "after") {
        assert.ok(initial.width <= width + 1, "no page overflow at " + width);
        const tables = page.locator("table.pricing-comparison");
        assert.equal(await tables.count(), fixture.groups.length);
        for (const [i, group] of fixture.groups.entries()) {
          const table = tables.nth(i);
          assert.ok(await table.isVisible(), group.id);
          const rows = table.locator("tbody tr");
          assert.equal(await rows.count(), group.rows.length);
          for (const [j, row] of group.rows.entries()) {
            assert.deepEqual(await rows.nth(j).locator("td").allTextContents(), fixture.plans.map(plan => row.values[plan.tier]), row.key);
            const label = await rows.nth(j).locator("th").innerText();
            assert.ok(label.includes(row.label));
            if (row.note) assert.ok(label.includes(row.note));
          }
          assert.equal(await table.locator("th,td").evaluateAll(cells => cells.filter(cell => cell.scrollWidth > cell.clientWidth + 1).length), 0, "all cell text fits at " + width);
        }
        const nav = page.getByRole("navigation", { name: "Pricing sections" });
        const links = nav.locator("a");
        assert.equal(await links.count(), 6);
        const sizes = await links.evaluateAll(nodes => nodes.map(node => ({ height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width })));
        assert.ok(sizes.every(size => size.height >= 44 && size.width >= 44));
        record.indexTargets = sizes;
        assert.ok(await tables.first().locator("td").first().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize) >= 16), "comparison values retain 16px text");
        for (const link of await links.all()) {
          const href = await link.getAttribute("href");
          await link.click();
          await page.waitForFunction(hash => location.hash === hash, href);
          const geometry = await page.evaluate(hash => {
            const target = document.querySelector(hash).getBoundingClientRect();
            const bar = document.querySelector('[aria-label="Pricing sections"]').getBoundingClientRect();
            return { targetTop: target.top, barBottom: bar.bottom, barTop: bar.top };
          }, href);
          assert.ok(geometry.targetTop >= -1, href + " above viewport");
          if (geometry.barTop < 1 && href !== "#plans") assert.ok(geometry.targetTop >= geometry.barBottom - 1, href + " obscured by sticky index");
        }
        // The anchor geometry checks used pointer clicks. Establish keyboard
        // modality before checking :focus-visible and the native Tab sequence.
        await page.keyboard.press("Tab");
        await links.first().focus();
        const ratios = [];
        for (let i = 0; i < 6; i++) {
          assert.equal(await links.nth(i).evaluate(node => node === document.activeElement), true, "native index Tab order");
          assert.notEqual(await links.nth(i).evaluate(node => getComputedStyle(node).outlineStyle), "none");
          const colors = await links.nth(i).evaluate(node => {
            const style = getComputedStyle(node);
            const background = style.backgroundColor === "rgba(0, 0, 0, 0)" ? getComputedStyle(node.parentElement).backgroundColor : style.backgroundColor;
            return { foreground: style.color, background };
          });
          assert.equal(colors.foreground, "rgb(30, 58, 138)");
          assert.ok(["rgb(255, 255, 255)", "rgb(234, 243, 255)"].includes(colors.background));
          const ratio = colors.background === "rgb(255, 255, 255)" ? fixture.contrast.white : fixture.contrast.blue;
          assert.ok(ratio >= 7, "computed index foreground/background has AAA text contrast");
          ratios.push(ratio);
          if (i < 5) await page.keyboard.press("Tab");
        }
        record.minimumIndexContrast = Math.min(...ratios);
        const zoom = await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
        await page.waitForFunction(() => getComputedStyle(document.documentElement).fontSize === "32px");
        const zoomGeometry = await nav.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth, font: getComputedStyle(node.querySelector("a")).fontSize }));
        console.log(JSON.stringify({ mode, width, zoomGeometry }));
        assert.ok(zoomGeometry.scroll <= zoomGeometry.client + 1, "index reflows at 200% text");
        assert.equal(await tables.locator("th,td").evaluateAll(cells => cells.filter(cell => cell.scrollWidth > cell.clientWidth + 1).length), 0, "all comparison text fits at 200%");
        record.textZoom = "200% index and table reflow passed";
        await zoom.evaluate(node => node.remove());
      }
      if (process.env.T_PRICING_SCREENSHOTS) {
        const folder = resolve(root, process.env.T_PRICING_SCREENSHOTS);
        mkdirSync(folder, { recursive: true });
        if (mode === "after") await page.getByRole("navigation", { name: "Pricing sections" }).locator('a[href="#limits-heading"]').click();
        else await page.locator("#limits-heading").evaluate(node => node.scrollIntoView({ block: "start" }));
        await page.screenshot({ path: join(folder, mode + "-" + width + ".png") });
      }
      assert.equal(blocked, 0, "no external resources in the fixture");
      assert.equal(writes, 0);
      record.blocked = blocked; record.writes = writes;
      results.push(record);
      console.log(JSON.stringify(record));
    } finally { await context.close(); }
  }
  for (const width of [320, 390]) {
    const before = results.find(row => row.mode === "before" && row.width === width);
    const after = results.find(row => row.mode === "after" && row.width === width);
    assert.ok(after.height < before.height, "the isolated mobile page is shorter without hiding data");
  }
  console.log(JSON.stringify({ chromium: browser.version(), scope: "isolated SSR; real CSS; system fonts; no Next hydration, provider, production LCP or AAA certification", results }));
} finally {
  if (browser) await browser.close();
  rmSync(temporary, { recursive: true, force: true });
}
