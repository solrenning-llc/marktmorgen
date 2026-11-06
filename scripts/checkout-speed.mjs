/**
 * Checkout speed on a slow phone, measured up to the hand-off to Stripe
 * (queue item 277 [H3-2]; method and results in docs/checkout-speed-2026-11-06.md).
 *
 *   node scripts/checkout-speed.mjs [out.json]     (after a production build: npm run build)
 *
 * Local and synthetic only. The site runs from the existing build (`next start`)
 * against the stand-in database, Stripe and email sender of tests/e2e/services.mjs,
 * seeded by tests/e2e/seed.ts and tests/e2e/checkout-speed-seed.ts. No real
 * account, payment, card or email is involved. Stripe's own page is never
 * loaded: the stand-in answers a checkout with the site's own return address,
 * and that navigation is aborted. What is timed ends the moment the browser
 * has the 303 that would send it to Stripe; what Stripe serves after it is
 * not Marktmorgen's code and is not timed.
 *
 * Paths measured, each RUNS times (default 5), cold cache, new browser context:
 *   - product page → press Buy (with the box to start access at once checked);
 *   - payment request page (/pay) → press Pay;
 *   - the card the creator pastes into their own site (/embed/…): its load
 *     only; its button opens the product page above in a new tab.
 *
 * Phone: 412 × 823 CSS px at 1.75, touch, CPU slowed 4×; network with
 * Lighthouse's "Slow 4G" devtools values (562.5 ms per request, 1,474.56
 * kbit/s down, 675 kbit/s up). The same as docs/speed-comparison-2026-11-06.md.
 *
 * Also counted, for each press: the calls the server made to the database and
 * to Stripe before it answered (through a counting relay in front of the
 * stand-ins), because each is a round trip in production that the local
 * stand-ins answer in about a millisecond.
 *
 * It is a measurement, not a CI check: timing on a shared runner varies. The
 * CI budget is static (scripts/checkout-budget.mjs, tests/checkout-budget.test.ts).
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startServices } from "../tests/e2e/services.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = Math.max(1, Number(process.env.RUNS) || 5);
const SERVICES = 4491;
const RELAY = 4492;
const APP = 3191;
const LOCAL = `http://127.0.0.1:${APP}`;
const FAKE = `http://127.0.0.1:${RELAY}`;
const out = process.argv[2] || join(tmpdir(), `checkout-speed-${Date.now()}.json`);

if (!existsSync(join(root, ".next", "BUILD_ID"))) {
  console.error("Build first (npm run build); this measures the production build.");
  process.exit(2);
}
const require = createRequire(join(root, "package.json"));
let chromium;
try {
  ({ chromium } = require(process.env.CHECKOUT_SPEED_PLAYWRIGHT || "playwright"));
} catch {
  console.error("This needs Playwright (npm i -g playwright, then CHECKOUT_SPEED_PLAYWRIGHT=<its path>). Nothing was run.");
  process.exit(2);
}

const NET = { offline: false, latency: 562.5, downloadThroughput: (1474.56 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 };
const CPU = 4;
const DEVICE = {
  viewport: { width: 412, height: 823 },
  deviceScaleFactor: 1.75,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};

const env = {
  ...process.env,
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  STRIPE_SECRET_KEY: "sk_test_local_only_a_stand_in_0000",
  STRIPE_CONNECT_API_BASE: FAKE,
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_a_stand_in_0000",
  ANTHROPIC_API_BASE: FAKE,
  ADS_API_BASE: FAKE,
  PAYPAL_API_BASE: FAKE,
  VERCEL_BLOB_API_URL: `${FAKE}/blob-api`,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_localstore_standinsecret0000",
  CHECKOUT_SPEED_REQUESTS: String(RUNS),
  NEXT_TELEMETRY_DISABLED: "1",
};

/** Counts every call the app makes to the stand-ins, by kind, then passes it on unchanged. */
const counts = { redis: 0, stripe: 0, other: 0 };
let inFlight = 0;
let maxInFlight = 0;
const relay = http.createServer((req, res) => {
  const path = req.url || "/";
  if (path.startsWith("/v1/")) counts.stripe++;
  else if (req.method === "POST" && (path === "/" || path.startsWith("/pipeline") || path.startsWith("/multi-exec"))) counts.redis++;
  else counts.other++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  const upstream = http.request({ host: "127.0.0.1", port: SERVICES, method: req.method, path, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
    reply.on("end", () => inFlight--);
  });
  upstream.on("error", () => {
    inFlight--;
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

async function seed(entry) {
  const dir = mkdtempSync(join(tmpdir(), "checkout-speed-seed-"));
  const file = join(dir, "seed.cjs");
  await build({ entryPoints: [join(root, entry)], bundle: true, platform: "node", format: "cjs", outfile: file, logLevel: "error", alias: { "@": root } });
  const said = await new Promise((done) => {
    const child = spawn(process.execPath, [file], { env, stdio: ["ignore", "pipe", "pipe"] });
    const text = { out: "", err: "" };
    child.stdout.on("data", (chunk) => (text.out += chunk));
    child.stderr.on("data", (chunk) => (text.err += chunk));
    child.on("close", (status) => done({ status, ...text }));
  });
  if (said.status !== 0) throw new Error(`${entry} failed:\n${said.err}`);
  return JSON.parse(said.out.trim().split("\n").at(-1));
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

const INIT = () => {
  window.__cs = { lcp: 0, long: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__cs.lcp = entry.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__cs.long.push([entry.startTime, entry.duration]);
  }).observe({ type: "longtask", buffered: true });
};

/** One cold load of `url` and, when `press` is given, one press of the buy button, timed to the 303. */
async function once(browser, url, press) {
  const context = await browser.newContext(DEVICE);
  const page = await context.newPage();
  await page.addInitScript(INIT);
  // The stand-in's checkout comes back to the site's own return page: never followed, so nothing is settled.
  await page.route(/[?&]session_id=/, (route) => route.abort());
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", NET);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  const reqs = new Map();
  let post = null;
  let handoff = null;
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.method === "POST" && /\/api\/store\/(checkout|pay-request)$/.test(event.request.url)) {
      post = { wall: event.wallTime * 1000, redis: counts.redis, stripe: counts.stripe };
      maxInFlight = 0;
    }
    if (event.redirectResponse && post && /\/api\/store\/(checkout|pay-request)$/.test(event.redirectResponse.url)) {
      handoff = { wall: event.wallTime * 1000, status: event.redirectResponse.status, to: event.request.url, redis: counts.redis - post.redis, stripe: counts.stripe - post.stripe, parallel: maxInFlight };
    }
  });
  cdp.on("Network.responseReceived", (event) => reqs.set(event.requestId, { ...(reqs.get(event.requestId) || {}), type: event.type, url: event.response.url }));
  cdp.on("Network.loadingFinished", (event) => reqs.set(event.requestId, { ...(reqs.get(event.requestId) || {}), bytes: event.encodedDataLength }));
  const reply = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  if (!reply || reply.status() !== 200) throw new Error(`HTTP ${reply?.status()} ${url}`);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  const loaded = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
    const tbt = window.__cs.long.filter(([start]) => fcp === null || start >= fcp).reduce((sum, [, duration]) => sum + Math.max(0, duration - 50), 0);
    return { fcp, lcp: window.__cs.lcp || null, tbt, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd };
  });
  const all = [...reqs.values()].filter((r) => r.url && !r.url.startsWith("data:"));
  const sum = (list) => list.reduce((total, r) => total + (r.bytes || 0), 0);
  const result = {
    ...loaded,
    requests: all.length,
    totalBytes: sum(all),
    jsBytes: sum(all.filter((r) => r.type === "Script")),
    jsFiles: all.filter((r) => r.type === "Script").length,
    thirdParty: all.filter((r) => new URL(r.url).origin !== LOCAL).map((r) => r.url),
  };
  if (press) {
    await press(page);
    const clicked = Date.now();
    await Promise.all([page.waitForEvent("requestfailed", { predicate: (request) => /[?&]session_id=/.test(request.url()), timeout: 120_000 }), page.locator(press.button).first().click()]);
    if (!post || !handoff) throw new Error(`no hand-off seen for ${url}`);
    if (handoff.status !== 303) throw new Error(`hand-off was HTTP ${handoff.status} for ${url}`);
    Object.assign(result, {
      clickToPost: post.wall - clicked,
      postToHandoff: handoff.wall - post.wall,
      clickToHandoff: handoff.wall - clicked,
      redisCalls: handoff.redis,
      stripeCalls: handoff.stripe,
      upstreamParallelMax: handoff.parallel,
      handoffTo: handoff.to.replace(/session_id=[^&]+/, "session_id=…"),
    });
  }
  await context.close();
  return result;
}

/** The server alone: the same press sent from here, without a browser or throttling. */
async function serverOnly(path, body) {
  const before = { ...counts };
  const started = performance.now();
  const reply = await fetch(LOCAL + path, { method: "POST", body: new URLSearchParams(body), redirect: "manual", headers: { origin: LOCAL } });
  const ms = performance.now() - started;
  if (reply.status !== 303) throw new Error(`${path}: HTTP ${reply.status}`);
  return { ms, redis: counts.redis - before.redis, stripe: counts.stripe - before.stripe, location: reply.headers.get("location") };
}

const services = await startServices(SERVICES);
await new Promise((done) => relay.listen(RELAY, "127.0.0.1", done));
let app = null;
let browser = null;
try {
  const { ids } = await seed("tests/e2e/seed.ts");
  const { requests } = await seed("tests/e2e/checkout-speed-seed.ts");
  const directRequests = (await seed("tests/e2e/checkout-speed-seed.ts")).requests;
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(APP)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  app.stdout.on("data", (chunk) => (log = (log + chunk).slice(-4000)));
  app.stderr.on("data", (chunk) => (log = (log + chunk).slice(-4000)));
  for (let attempt = 0; ; attempt++) {
    if (attempt > 240) throw new Error(`the app did not start:\n${log}`);
    const up = await fetch(`${LOCAL}/@localshop`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.status === 200).catch(() => false);
    if (up) break;
    await new Promise((wait) => setTimeout(wait, 500));
  }
  const product = ids["Pantry Checklist"];
  // Asked once outside any measurement, so no path pays for the server's first compile of a route.
  for (const path of [`/@localshop/p/${product}`, `/embed/localshop/${product}`, `/@localshop/pay/${directRequests[0]}`]) await fetch(LOCAL + path);

  browser = await chromium.launch();
  const checkConsent = async (page) => {
    for (const label of await page.locator('#buy label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
  };
  checkConsent.button = "#buy form[data-checkout] button[type=submit]";
  const noPrep = async () => {};
  noPrep.button = 'form[action="/api/store/pay-request"] button[type=submit]';
  const paths = [
    { name: "product page → Buy", url: () => `${LOCAL}/@localshop/p/${product}`, press: checkConsent },
    { name: "payment request (/pay) → Pay", url: (run) => `${LOCAL}/@localshop/pay/${requests[run]}`, press: noPrep },
    { name: "embedded card (/embed) load", url: () => `${LOCAL}/embed/localshop/${product}`, press: null },
  ];
  const results = [];
  for (const path of paths) {
    const runs = [];
    for (let run = 0; run < RUNS; run++) {
      const one = await once(browser, path.url(run), path.press);
      runs.push(one);
      console.error(`${path.name} ${run + 1}/${RUNS}: LCP ${Math.round(one.lcp)} ms, JS ${Math.round(one.jsBytes / 1024)} KiB${one.clickToHandoff ? `, click→hand-off ${Math.round(one.clickToHandoff)} ms, ${one.redisCalls} db + ${one.stripeCalls} Stripe calls` : ""}`);
    }
    const keys = Object.keys(runs[0]).filter((key) => typeof runs[0][key] === "number");
    results.push({ path: path.name, median: Object.fromEntries(keys.map((key) => [key, median(runs.map((r) => r[key]))])), runs });
  }

  // The server's own time for each press, three times each, unthrottled.
  const server = { checkout: [], payRequest: [] };
  for (let n = 0; n < 3; n++) {
    server.checkout.push(await serverOnly("/api/store/checkout", { handle: "localshop", product, dc: "yes", dc_v: await consentVersion() }));
    server.payRequest.push(await serverOnly("/api/store/pay-request", { handle: "localshop", request: directRequests[n] }));
  }
  const report = {
    measuredAt: new Date().toISOString(),
    chromium: browser.version(),
    net: NET,
    cpu: CPU,
    device: DEVICE,
    runsPerPath: RUNS,
    results,
    server: {
      checkout: { medianMs: median(server.checkout.map((s) => s.ms)), runs: server.checkout },
      payRequest: { medianMs: median(server.payRequest.map((s) => s.ms)), runs: server.payRequest },
    },
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`written: ${out}`);
} finally {
  await browser?.close().catch(() => {});
  if (app?.pid) {
    try {
      process.kill(-app.pid, "SIGTERM");
    } catch {}
  }
  relay.close();
  await services.close();
}

/** The version of the "start access at once" sentence this build shows, read from its own module. */
async function consentVersion() {
  const dir = mkdtempSync(join(tmpdir(), "checkout-speed-consent-"));
  const file = join(dir, "consent.mjs");
  await build({ stdin: { contents: 'export { EU_WITHDRAWAL_CONSENT_VERSION } from "@/lib/digital-consent";', resolveDir: root, loader: "ts" }, bundle: true, platform: "node", format: "esm", outfile: file, logLevel: "error", alias: { "@": root } });
  return (await import(file)).EU_WITHDRAWAL_CONSENT_VERSION;
}
