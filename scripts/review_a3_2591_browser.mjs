/** Independent component proof. No account, provider, video or external IO.
 * Real React, Tailwind output and Chromium Fullscreen API on loopback only.
 * This is not a real lesson, streaming service, iPhone or human AAA test. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { compile } from "tailwindcss";
import { chromium } from "playwright-core";

const root = process.cwd();
const source = await readFile(resolve(root, "components/video-stamp.tsx"), "utf8");
const candidates = [...source.matchAll(/className="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/));
candidates.push("hidden", "mt-2", "flex", "justify-end", "mx-auto", "block", "w-full", "object-contain", "max-h-[var(--player-tall,75vh)]");
const compiler = await compile("@theme { --spacing: 0.25rem; --radius-2xl: 1rem; } @tailwind utilities;");
const css = compiler.build(candidates);
assert.ok(css.includes("calc(100vh - 6.5rem)"), "actual Tailwind output normalizes the subtraction");
const text = "synthetic@example.test <img src=x onerror=alert(1)>";
const entry = `import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
import * as module from ${JSON.stringify(resolve(root, "components/video-stamp.tsx"))};
if(typeof module.StampedPlayer!=='function')throw Error('StampedPlayer is absent');
const root=createRoot(document.getElementById('root'));
root.render(createElement(module.StampedPlayer,{text:${JSON.stringify(text)},seed:'synthetic-course',enter:'Full screen',exit:'Exit full screen'},
 createElement('video',{controls:true,className:'mx-auto block max-h-[var(--player-tall,75vh)] w-full object-contain',style:{aspectRatio:'16 / 9'}})));
window.reviewUnmount=()=>root.unmount();`;
const result = await build({ stdin: { contents: entry, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@/lib/video-stamp": resolve(root, "lib/video-stamp.ts") },
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;--st-bg:white}button{min-height:44px}${css}</style></head>
<body><div id="root"></div><script>${result.outputFiles[0].text}</script></body></html>`;
const server = createServer((_req, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); });
await new Promise((resolveReady, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveReady); });
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const open = async (setup) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (setup) await context.addInitScript(setup);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(origin);
    await page.locator("[data-stamped-player]").waitFor();
    return { context, page, errors };
  };
  const native = await open();
  try {
    assert.equal(await native.page.evaluate(() => document.fullscreenEnabled), true);
    await native.page.getByRole("button", { name: "Full screen", exact: true }).click();
    await native.page.waitForFunction(() => document.fullscreenElement?.hasAttribute("data-stamped-player"));
    await native.page.getByRole("button", { name: "Exit full screen", exact: true }).waitFor();
    const proof = await native.page.evaluate(() => {
      const box = document.fullscreenElement, video = box?.querySelector("video"), mark = box?.querySelector("[data-video-stamp]");
      return { containsVideo: Boolean(video), containsMark: Boolean(mark), mark: mark?.textContent,
        hidden: mark?.getAttribute("aria-hidden"), images: box?.querySelectorAll("img").length,
        maximum: video ? getComputedStyle(video).maxHeight : null, viewport: innerHeight };
    });
    assert.equal(proof.containsVideo, true); assert.equal(proof.containsMark, true);
    assert.equal(proof.mark, text); assert.equal(proof.hidden, "true"); assert.equal(proof.images, 0);
    assert.ok(Number.parseFloat(proof.maximum) > 0 && Number.parseFloat(proof.maximum) <= proof.viewport);
    await native.page.getByRole("button", { name: "Exit full screen", exact: true }).click();
    await native.page.waitForFunction(() => document.fullscreenElement === null);
    await native.page.getByRole("button", { name: "Full screen", exact: true }).waitFor();
    assert.deepEqual(native.errors, []);
    console.log(JSON.stringify({ proof: "native-Chromium-entry-and-exit", ...proof, externalRequests: 0 }));
  } finally { await native.context.close(); }

  const unsupported = await open(() => Object.defineProperty(document, "fullscreenEnabled", { value: false, configurable: true }));
  try {
    assert.equal(await unsupported.page.locator("[data-full-screen-row]").isVisible(), false);
    assert.equal(await unsupported.page.locator("video").count(), 1);
    assert.equal(await unsupported.page.locator("[data-video-stamp]").textContent(), text);
    assert.deepEqual(unsupported.errors, []);
    console.log("PASS: unsupported API hides the control and keeps the player/mark");
  } finally { await unsupported.context.close(); }

  const refused = await open(() => {
    window.reviewCalls = 0;
    HTMLElement.prototype.requestFullscreen = () => {
      window.reviewCalls++;
      return Promise.resolve().then(() => { window.reviewRefused = true; throw Error("Synthetic fullscreen refusal"); });
    };
  });
  try {
    await refused.page.getByRole("button", { name: "Full screen", exact: true }).click();
    await refused.page.waitForFunction(() => window.reviewRefused === true);
    assert.equal(await refused.page.evaluate(() => window.reviewCalls), 1);
    assert.equal(await refused.page.evaluate(() => document.fullscreenElement), null);
    assert.equal(await refused.page.getByRole("button", { name: "Full screen", exact: true }).isVisible(), true);
    assert.deepEqual(refused.errors, []);
    await refused.page.evaluate(() => window.reviewUnmount());
    assert.equal(await refused.page.locator("[data-stamped-player]").count(), 0);
    console.log("PASS: rejected API promise does not claim full screen or crash; unmount works");
  } finally { await refused.context.close(); }
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
