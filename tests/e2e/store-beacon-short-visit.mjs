// A short visit to a store is still counted (Claude 7's MEDIUM on #3642).
//
// The real StoreBeacon (components/store-beacon.tsx), with the real browser
// check client (botid/client/core, through lib/browser-check-client.ts) and
// the real pause (lib/quiet-moment.ts), bundled with esbuild as production
// code (tests/e2e/store-beacon-harness.tsx). A local server stands in for the
// host: it serves the check's script the way CI does (V_C.push({b:0,d:0})),
// after a mobile round trip and with the long block CI measured, and counts
// only the visit counts that carry the check's header, as the server does.
// The buyer leaves (the tab is closed) 500 ms and 1.5 s after the page loaded,
// in Chromium with the CPU slowed four times, five times each. Every visit
// must reach the server. Synthetic only: no Vercel, no Redis, nothing sent
// outside this machine.
//
// node tests/e2e/store-beacon-short-visit.mjs   (CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const CHALLENGE_PATH = "/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/a-4-a/c.js";
const LATENCY_MS = 300;
const BLOCK_MS = 180;
const RUNS = 5;

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/store-beacon-harness.tsx")],
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

let signed = 0, unsigned = 0;
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
    }, LATENCY_MS);
    return;
  }
  if (url.pathname === "/api/store/hit" && req.method === "POST") {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.headers["x-is-human"]) signed++;
      else unsigned++;
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
try {
  for (const after of [500, 1500]) {
    let counted = 0, warmUps = 0;
    for (let run = 0; run < RUNS; run++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const before = { signed, unsigned };
      await page.goto(`${origin}/@harborkitchen`, { waitUntil: "load" });
      await page.waitForTimeout(after);
      await page.close({ runBeforeUnload: true });
      // Room for a keepalive request still on its way.
      await new Promise((done) => setTimeout(done, LATENCY_MS + 1500));
      counted += signed - before.signed;
      warmUps += unsigned - before.unsigned;
      await context.close();
    }
    is(`the tab closed ${after} ms after load: every visit reaches the server, signed by the check`, `${counted}/${RUNS}`, `${RUNS}/${RUNS}`);
    is(`the tab closed ${after} ms after load: nothing else is sent unsigned`, warmUps, 0);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${cases} checks, ${failed ? `${failed} failing` : "all passing"}.`);
process.exit(failed ? 1 : 0);
