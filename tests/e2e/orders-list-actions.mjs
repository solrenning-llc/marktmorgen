// Reviewer 3 C79: real buyer components, keyboard focus and store focus rings.
// Runs on each buyer-matrix engine. All data and fetch replies are synthetic;
// no app server, account, Stripe or Discord is reached.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine));
const driver = require("playwright-core")[engine];
const bundled = await build({
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import { createRoot } from "react-dom/client";
    import { OlderPurchases } from "@/components/older-purchases";
    import { OrdersBundle } from "@/components/orders-bundle";
    import { OrdersSharedProvider } from "@/components/orders-shared";
    const root = createRoot(document.getElementById("root"));
    const shared = { handle:"buyer", token:"synthetic-token", storeName:"Book Studio", language:"en", words:{
      loading:"Getting the products", failed:"Could not show products", check:"Check older purchases", checking:"Checking older purchases", olderFailed:"Could not check purchases",
      bundle:{openCourse:"Open course", startCourse:"Start course", openIt:"Open", keptOn:"Kept on {host}: {link}", downloadIt:"Download", nothingAttached:"Nothing attached"}, key:{}
    }};
    window.card = (title) => ({reference:title,title,meta:"Bought today",preorderLine:null,ended:null,course:null,package:null,podcast:null,alsoIn:null,main:null,added:[],importedNote:null,bundles:[],keys:[],review:null});
    let mount = 0;
    window.mount = (answers) => {
      window.answers = answers;
      root.render(<div className="st-page st-theme-night" key={++mount}>
        <OrdersSharedProvider value={shared}>
          <OlderPurchases older="cursor-1" left="Some purchases are not checked yet" />
          <OrdersBundle reference="purchase" item="main" label="Show bundle products" heading="Inside this bundle" />
        </OrdersSharedProvider>
        <div style={{background:"var(--st-card)",padding:20}}>
          <button id="secondary" className="btn btn-secondary">Secondary action</button>
          <button id="primary" className="btn btn-primary">Primary action</button>
          <a id="footer" className="st-footer-link" href="#root">Back to purchases</a>
        </div>
      </div>);
    };
    window.fetch = async (input) => {
      const path = new URL(input, location.href).pathname;
      if (!path.startsWith("/api/store/orders/")) throw Error("Unexpected request: "+path);
      const answer = window.answers.shift();
      if (!answer) throw Error("No synthetic reply left");
      return new Response(JSON.stringify(answer), {headers:{"Content-Type":"application/json"}});
    };
    window.mount([]);
  ` },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", logLevel: "error",
  alias: { "@": root, "next/link": join(root, "tests/next-link-world.tsx") },
  define: { "process.env.NODE_ENV": '"production"' },
});
const css = readFileSync(join(root, "app/globals.css"), "utf8");
const browser = await driver.launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let checks = 0;
const errors = [];
const check = (name, got, expected) => { checks++; assert.deepEqual(got, expected, name); };
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, "http://orders.test", "nothing leaves the synthetic page");
    if (url.pathname === "/orders.js") return route.fulfill({ contentType: "text/javascript", body: bundled.outputFiles[0].text });
    if (url.pathname === "/globals.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Buyer orders check</title><link rel="stylesheet" href="/globals.css"></head><body><main id="root"></main><script src="/orders.js"></script></body></html>' });
  });
  await page.goto("http://orders.test/");
  const button = page.getByRole("button", { name: "Check older purchases", exact: true });
  await button.waitFor();
  const settled = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const focusedStyle = async (control) => {
    await control.focus();
    // Read after the actual focus transitions finish, including box-shadow.
    await control.evaluate(async (node) => {
      void getComputedStyle(node).boxShadow;
      await Promise.allSettled(node.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished));
    });
  };
  await page.evaluate(() => window.mount([
    { ok: true, cards: [window.card("First batch")], older: "cursor-2", left: "One batch left", said: "One added" },
    { ok: true, cards: [window.card("First of final batch"), window.card("Second of final batch")], older: null, left: "", said: "Two added" },
  ]));
  await button.click();
  await page.getByText("One batch left", { exact: true }).waitFor();
  check("focus stays on the button while a later batch remains", await button.evaluate((node) => document.activeElement === node), true);
  await button.click();
  await page.getByText("Second of final batch", { exact: true }).waitFor();
  await settled();
  check("after the final batch focus is its FIRST new purchase, not an earlier purchase or body", await page.evaluate(() => document.activeElement?.textContent), "First of final batch");
  check("the final button has left the page", await button.count(), 0);
  // WCAG 2.4.10: each purchase the batches added is a heading at the list's purchase level, h2.
  check("each purchase the batches added is an h2, before the bundle's h3 the harness also draws", await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) => `${node.tagName}:${node.textContent}`)), ["H2:First batch", "H2:First of final batch", "H2:Second of final batch", "H3:Inside this bundle"]);

  await page.evaluate(() => window.mount([{ ok: true, cards: [], older: null, left: "", said: "No purchases in this batch" }]));
  await button.click();
  await page.getByText("No purchases in this batch", { exact: true }).waitFor();
  await settled();
  check("an empty final batch puts focus on its status", await page.evaluate(() => ({ role: document.activeElement?.getAttribute("role"), text: document.activeElement?.textContent })), { role: "status", text: "No purchases in this batch" });

  await page.evaluate(() => window.mount([{ ok: false, message: "Please try again" }]));
  await button.click();
  await page.getByRole("alert").waitFor();
  check("a refused batch keeps the retry button focused", await button.evaluate((node) => document.activeElement === node), true);

  await page.evaluate(() => window.mount([{ ok: true, lines: [{ id: "book", title: "A book", link: null, download: "/download/book", course: null, key: null, kept: null }], missing: null }]));
  await page.getByRole("button", { name: "Show bundle products" }).click();
  await page.getByRole("link", { name: "Download", exact: true }).waitFor();
  check("an expanded bundle has only its outer named region", await page.locator("section").count(), 1);
  // WCAG 2.4.10: the bundle's name a heading under its purchase's h2, each of its products one under that.
  check("an expanded bundle's name and each of its products are headings, h3 then h4", await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((node) => `${node.tagName}:${node.textContent}`)), ["H3:Inside this bundle", "H4:A book"]);

  for (const theme of ["light", "sand", "bold", "night"]) {
    await page.locator(".st-page").evaluate((node, theme) => { node.className = `st-page st-theme-${theme}`; }, theme);
    await page.keyboard.press("Tab");
    for (const id of ["secondary", "primary", "footer"]) {
      const control = page.locator(`#${id}`);
      await focusedStyle(control);
      check(`${theme} ${id}: keyboard focus uses the black ring and white halo`, await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { focused: document.activeElement === node, visible: node.matches(":focus-visible"), width: style.outlineWidth, color: style.outlineColor, halo: style.boxShadow.includes("rgb(255, 255, 255)") };
      }), { focused: true, visible: true, width: "3px", color: "rgb(0, 0, 0)", halo: true });
    }
  }
  await page.emulateMedia({ forcedColors: "active" });
  for (const id of ["secondary", "primary", "footer"]) {
    const control = page.locator(`#${id}`);
    await focusedStyle(control);
    check(`${id}: forced colors keep a visible system ring`, await control.evaluate((node) => {
      const style = getComputedStyle(node);
      const sample = document.createElement("span"); sample.style.color = "CanvasText"; node.append(sample);
      const color = getComputedStyle(sample).color; sample.remove();
      const adjust = style.getPropertyValue("forced-color-adjust");
      const supportsAdjust = CSS.supports("forced-color-adjust", "auto");
      return { width: style.outlineWidth, color: style.outlineColor === color, shadow: style.boxShadow, adjust: supportsAdjust ? adjust === "auto" : adjust === "" };
    }), { width: "3px", color: true, shadow: "none", adjust: true });
  }
  check("no browser errors", errors, []);
  console.log(`BUYER_ORDERS_ACTIONS: ${engine}, ${checks} checks passed`);
} finally {
  await browser.close();
}
