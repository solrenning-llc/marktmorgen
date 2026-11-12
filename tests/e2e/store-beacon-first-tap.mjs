// The first tap on a store page is not held up by the host's check (#3642, option 1, v2).
//
// The real StoreBeacon (components/store-beacon.tsx) with the real browser check client
// (botid/client/core through lib/browser-check-client.ts), bundled as production code with a
// button beside it (tests/e2e/store-beacon-tap-harness.tsx). A local server stands in for the host:
// it serves the check's script (c.js) after a chosen delay, with the long block CI measured
// (180 ms), and counts the signed visit counts.
//
// For each c.js delay (300, 500, 700 and 900 ms) and RUNS runs, in Chromium with the CPU slowed
// four times, the buyer taps the button once, at a time drawn around the script's arrival
// (delay - 150 ms to delay + 250 ms after load, the same draws for every build). The tap's
// interaction-to-paint is read from the page's own Event Timing entries (the first tap's
// longest entry, as INP counts it), and must stay under LIMIT_MS. Synthetic only.
//
// node tests/e2e/store-beacon-first-tap.mjs [runs]   (CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const CHALLENGE_PATH = "/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/a-4-a/c.js";
const BLOCK_MS = 180;
const LIMIT_MS = 200;
const RUNS = Number(process.argv[2] ?? 20);
const DELAYS = (process.env.DELAYS ?? "300,500,700,900").split(",").map(Number);

// A fixed sequence of tap times, so every build is measured on the same draws.
let seed = 3642;
const draw = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/store-beacon-tap-harness.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  logLevel: "error",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundle.outputFiles[0].text;

let delay = 300;
let signed = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (url.pathname === "/@harborkitchen") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><title>Harbor Kitchen</title></head><body><main id="root"></main><script>${script}</script></body></html>`);
    return;
  }
  if (url.pathname === CHALLENGE_PATH) {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`var t=Date.now();while(Date.now()-t<${BLOCK_MS}){}window.V_C.push({b:0,d:0});`);
    }, delay);
    return;
  }
  if (url.pathname === "/api/store/hit" && req.method === "POST") {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.headers["x-is-human"]) signed++;
      res.writeHead(204);
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const rows = [];
try {
  for (const d of DELAYS) {
    delay = d;
    const inp = [];
    for (let run = 0; run < RUNS; run++) {
      const at = Math.max(50, Math.round(d - 150 + draw() * 400));
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.addInitScript(() => {
        window.__taps = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (e.interactionId) window.__taps.push(e.duration);
        }).observe({ type: "event", durationThreshold: 16, buffered: true });
      });
      await page.goto(`${origin}/@harborkitchen`, { waitUntil: "load" });
      await page.waitForTimeout(at);
      await page.tap("#tap");
      await page.waitForTimeout(1200);
      const durations = await page.evaluate(() => window.__taps);
      inp.push(durations.length ? Math.max(...durations) : 0);
      await context.close();
    }
    const over = inp.filter((v) => v >= LIMIT_MS).length;
    const sorted = [...inp].sort((a, b) => a - b);
    rows.push({ delay: d, runs: RUNS, over, worst: sorted.at(-1), median: sorted[Math.floor(sorted.length / 2)] });
  }
} finally {
  await browser.close();
  server.close();
}
console.log("FIRST_TAP_TABLE " + JSON.stringify(rows));
for (const r of rows) console.log(`c.js at ${r.delay} ms: ${r.over}/${r.runs} first taps at or over ${LIMIT_MS} ms; worst ${r.worst} ms; median ${r.median} ms`);
process.exit(rows.some((r) => r.over) ? 1 : 0);
