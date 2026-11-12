/**
 * Nothing make-believe in front of the customer (AGENTS.md, VR Part A, item 2): every page a visitor or a creator
 * can reach answers, every link on it leads somewhere that answers, and every link to a place on the same page
 * names an element that is there.
 *
 *   node tests/e2e/site-links.mjs --no-build     (after scripts/ci-build.mjs; product-checks.yml)
 *
 * Why it exists (VR site sweep, 12 November 2026): a crawl of the whole site found /studio/card answering 500
 * for every creator (a function passed to a client component) and the studio's "Review checkout recovery
 * settings" link pointing at #recovery, which no element had. Unit tests rendered each piece alone and passed.
 *
 * What runs: the production build, against the stand-in database, Stripe and email sender of services.mjs,
 * seeded through the studio's own functions (store-copy-seed.ts). No real service is reached; every request
 * that would write is refused in the browser, so nothing is changed by looking.
 *
 * What is checked, per page: the public pages in the sitemap, the demo store, the help center, the legal and
 * error pages, and every studio page signed in as a synthetic creator:
 *   - the page answers 200 (the made-up address answers 404, never 500);
 *   - exactly one non-empty <title>;
 *   - no uncaught error in the browser;
 *   - every <img> has an alt attribute (alt="" for decoration);
 *   - every same-page #link names an element on the page;
 *   - every same-origin link on it answers below 400 (redirects allowed).
 * What it does not check: buttons' behavior, how a page looks, accessibility rules (the accessibility matrices).
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { startServices } from "./services.mjs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(join(root, "package.json"));
let chromium;
for (const name of ["playwright", "playwright-core"]) {
  try {
    ({ chromium } = require(name));
    break;
  } catch {}
}
if (!chromium) {
  console.error("This needs Playwright or playwright-core on the machine. Nothing was run.");
  process.exit(2);
}
if (!process.argv.includes("--no-build")) {
  console.error("Build first (scripts/ci-build.mjs or npm run build), then run with --no-build.");
  process.exit(2);
}

const SERVICES = 4496;
const PORT = 3196;
const origin = `http://localhost:${PORT}`;
const FAKE = `http://127.0.0.1:${SERVICES}`;
const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_" + "x".repeat(30),
  ANTHROPIC_API_BASE: FAKE,
  STRIPE_DEMO_SECRET_KEY: "sk_test_local_only_a_stand_in",
  STRIPE_CONNECT_API_BASE: FAKE,
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  NEXT_TELEMETRY_DISABLED: "1",
};

/** Public pages that are not in the sitemap but a visitor reaches: sign-in, the buyer's library, help and legal leaves. */
const PUBLIC_EXTRA = [
  "/demo", "/help/zoom", "/accessibility", "/affiliate", "/affiliate-programs", "/copyright", "/creators",
  "/developers/checkout-script", "/library", "/platform/path", "/privacy/delete", "/products", "/report",
  "/signin", "/signin/code", "/signin/join", "/signin/lost", "/status", "/transparency", "/unsubscribe", "/l/ended",
];
/** Every studio page with a fixed address (app/studio/<name>/page.tsx). */
const STUDIO = [
  "", "/add", "/affiliates", "/agent", "/agreements", "/blog", "/bundles", "/calendar", "/card", "/checkup",
  "/closing-refunds", "/community", "/copy", "/deals", "/discord", "/disputes", "/email", "/forms", "/funnels",
  "/growth", "/import", "/inbox", "/integrations", "/invite", "/invoices", "/labels", "/meetings", "/memberships",
  "/new", "/outreach", "/pages", "/path", "/path/privacy", "/paused", "/people", "/phone", "/refund", "/requests",
  "/reviews", "/site", "/tax", "/team", "/totals",
];
const MISSING = "/this-address-is-not-a-page-0f3c";

let failed = 0;
const failures = [];
function fail(where, what) {
  failed += 1;
  failures.push(`${where}: ${what}`);
}

const services = await startServices(SERVICES);
const folder = mkdtempSync(join(tmpdir(), "mm-site-links-"));
let fixture;
try {
  const seedFile = join(folder, "seed.cjs");
  await build({ entryPoints: [join(here, "store-copy-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
  const seeded = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [seedFile], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let data = "";
    child.stdout.on("data", (chunk) => (data += chunk));
    child.stderr.on("data", (chunk) => (data += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? accept(data) : reject(new Error("Synthetic seed failed\n" + data))));
  });
  fixture = JSON.parse(seeded.trim().split("\n").at(-1)).homeDemo;
  if (!fixture?.session || !fixture?.sid) throw new Error("Incomplete synthetic fixture");
} catch (error) {
  await services.close();
  throw error;
} finally {
  rmSync(folder, { recursive: true, force: true });
}

const app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let output = "";
for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-8000); });

let browser;
try {
  let up = false;
  for (let n = 0; n < 240 && !up; n++) {
    if (app.exitCode !== null) throw new Error(output);
    try { up = (await fetch(origin)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error("Local app unavailable\n" + output);
  // As store-copy.mjs: a named Chromium, else Playwright's own, else the runner's Chrome (nothing is downloaded).
  if (process.env.CHROMIUM) browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
  else {
    try {
      browser = await chromium.launch();
    } catch (first) {
      try { browser = await chromium.launch({ channel: "chrome" }); } catch { throw first; }
    }
  }

  const sitemap = await (await fetch(origin + "/sitemap.xml")).text();
  const sitemapPaths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => { const u = new URL(m[1]); return u.pathname + u.search; });
  if (sitemapPaths.length < 20) fail("/sitemap.xml", `only ${sitemapPaths.length} pages listed`);
  // The demo store is made on its first visit (lib/demo-seed.ts): /demo first, so its address answers.
  const publicPaths = [...new Set(["/demo", ...sitemapPaths, ...PUBLIC_EXTRA])];
  const studioPaths = STUDIO.map((p) => `/studio${p}?store=${fixture.sid}`);

  const contexts = {};
  for (const kind of ["public", "studio"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    if (kind === "studio") await context.addCookies([{ name: "nl_session", value: fixture.session, url: origin }]);
    // Look, never change: a write is refused before it leaves the browser; nothing off this computer is reached.
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!["GET", "HEAD"].includes(request.method())) return route.abort();
      return route.continue();
    });
    contexts[kind] = context;
  }

  /** Same-origin links found on pages, each with the first page it was seen on. */
  const linked = new Map();
  const visited = new Set();
  async function visit(kind, path) {
    const page = await contexts[kind].newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    const where = `${kind} ${path}`;
    try {
      const response = await page.goto(origin + path, { waitUntil: "networkidle", timeout: 60_000 });
      const status = response?.status() ?? 0;
      if (status !== 200) return fail(where, `answered ${status}`);
      const landed = new URL(page.url());
      if (kind === "studio" && landed.pathname.startsWith("/signin")) return fail(where, "sent the signed-in creator to sign in");
      visited.add(landed.pathname + landed.search);
      const found = await page.evaluate(() => {
        const ids = new Set([...document.querySelectorAll("[id]")].map((node) => node.id));
        for (const node of document.querySelectorAll("a[name]")) ids.add(node.getAttribute("name"));
        const titles = [...document.querySelectorAll("head title")].map((node) => (node.textContent ?? "").trim());
        const links = [...document.querySelectorAll("a[href]")].map((a) => ({ href: a.href, text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 60) }));
        const here = location.origin + location.pathname;
        const missing = links.filter((l) => {
          const u = new URL(l.href);
          if (u.origin + u.pathname !== here || u.hash.length < 2) return false;
          const id = decodeURIComponent(u.hash.slice(1));
          return id !== "top" && !ids.has(id);
        });
        const noAlt = [...document.querySelectorAll("img:not([alt])")].map((img) => img.outerHTML.slice(0, 160));
        return { titles, links: links.map((l) => l.href), missing: missing.map((l) => `${new URL(l.href).hash} ("${l.text}")`), noAlt };
      });
      if (found.titles.length !== 1 || !found.titles[0]) fail(where, `has ${found.titles.length} titles: ${JSON.stringify(found.titles)}`);
      for (const anchor of found.missing) fail(where, `links to ${anchor}, which is not on the page`);
      for (const img of found.noAlt) fail(where, `image without alt: ${img}`);
      for (const href of found.links) {
        const u = new URL(href);
        if (u.origin !== origin || u.pathname.startsWith("/_next/") || /\/(signout|logout)\b/.test(u.pathname)) continue;
        const key = u.pathname + u.search;
        if (!linked.has(key)) linked.set(key, { kind, from: path });
      }
    } catch (error) {
      fail(where, String(error).slice(0, 300));
    } finally {
      for (const error of errors) fail(where, `uncaught error in the browser: ${error}`);
      await page.close();
    }
  }

  const queue = [...publicPaths.map((p) => ["public", p]), ...studioPaths.map((p) => ["studio", p])];
  async function worker() {
    while (queue.length) {
      const [kind, path] = queue.shift();
      await visit(kind, path);
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  // A made-up address answers 404 with the site's own page, never an error.
  const missing = await contexts.public.request.get(origin + MISSING, { maxRedirects: 0 });
  if (missing.status() !== 404) fail(MISSING, `answered ${missing.status()}, not 404`);

  // Every same-origin link seen on those pages answers below 400, as the same visitor.
  let checked = 0;
  for (const [key, { kind, from }] of linked) {
    if (visited.has(key)) continue;
    checked += 1;
    try {
      const response = await contexts[kind].request.get(origin + key, { maxRedirects: 5, timeout: 60_000 });
      if (response.status() >= 400) fail(`${kind} ${from}`, `links to ${key}, which answered ${response.status()}`);
    } catch (error) {
      fail(`${kind} ${from}`, `links to ${key}, which did not answer: ${String(error).slice(0, 200)}`);
    }
  }
  console.log(`SITE_LINKS: ${visited.size} pages opened (${publicPaths.length} public, ${studioPaths.length} studio), ${checked} further links requested, ${failed} failures`);
} finally {
  await browser?.close();
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await services.close();
}
for (const line of failures) console.log(`  FAIL  ${line}`);
process.exit(failed ? 1 : 0);
