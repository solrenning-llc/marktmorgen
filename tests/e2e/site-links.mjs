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
 *   - every <img> has an alt attribute (alt="" for decoration), and every same-origin image answers below 400;
 *   - no link is empty, a bare "#" or "javascript:", since each of those leads nowhere;
 *   - every #link names an element that is there: on the same page, or on the page it leads to (a hash that holds
 *     settings, "#starter=…", is not a place; two studio sections drawn only in a state this store is not in are
 *     named in CONDITIONAL_PLACES);
 *   - every same-origin link on it answers below 400. Redirects are followed only inside the site, as the browser
 *     here is never let off it; a redirect that leaves the site counts as an answer and is not followed.
 * The studio pages are read from app/studio/**\/page.tsx (fixed addresses only), so a new page is swept without
 * anyone adding it here. The ports are E2E_SERVICES_PORT and E2E_APP_PORT, as in the other browser files.
 * What it does not check: buttons' behavior, how a page looks, accessibility rules (the accessibility matrices).
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

const SERVICES = Number(process.env.E2E_SERVICES_PORT || 4496);
const PORT = Number(process.env.E2E_APP_PORT || 3196);
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
/**
 * Every studio page with a fixed address, read from the app itself (app/studio/**\/page.tsx), so the sweep never
 * falls behind a new page. A route group "(name)" adds nothing to the address; a page under a [segment] needs an
 * id and is left out (a course or a podcast of one product).
 */
function studioPaths(dir = join(root, "app/studio")) {
  const out = [];
  const walk = (folder, address) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === "page.tsx") out.push(address);
      if (!entry.isDirectory() || entry.name.startsWith("[") || entry.name.startsWith("_") || entry.name.startsWith("@")) continue;
      walk(join(folder, entry.name), /^\(.*\)$/.test(entry.name) ? address : `${address}/${entry.name}`);
    }
  };
  walk(dir, "");
  return out.sort();
}
const STUDIO = studioPaths();
if (!STUDIO.includes("") || STUDIO.length < 40) {
  console.error(`Read only ${STUDIO.length} studio pages from app/studio; nothing was run.`);
  process.exit(2);
}
const MISSING = "/this-address-is-not-a-page-0f3c";
/**
 * Places on another page that page draws only in a state this synthetic store is not in, so a link to them is
 * checked against nothing here. Each is named with why; any other missing place fails.
 */
const CONDITIONAL_PLACES = new Map([
  // app/studio/page.tsx draws the plan section only where billing is configured (isBillingConfigured), which the
  // stand-in services here are not; /studio/invoices links "Back to your plan" to it.
  ["/studio#billing", "drawn only where billing is configured"],
  // app/studio/page.tsx draws the closing section only while the store is closing; /studio/closing-refunds links back to it.
  ["/studio#closing", "drawn only while the store is closing"],
]);
/** A hash that holds settings for the page's script ("#starter=guide-signup"), not the id of a place on it. */
const isState = (hash) => hash.includes("=");

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
  publicPaths.splice(publicPaths.indexOf("/demo"), 1);
  const studioAddresses = STUDIO.map((p) => `/studio${p}?store=${fixture.sid}`);

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
  /** Links to a #place on another page: "address#place" with the page it was seen on. */
  const anchored = new Map();
  /** Same-origin images, each with the first page it was seen on. */
  const images = new Map();
  const visited = new Set();
  /** The ids (and a[name]s) of each page opened, by address. */
  const idsOf = new Map();
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
      const found = await page.evaluate(() => {
        const ids = new Set([...document.querySelectorAll("[id]")].map((node) => node.id));
        for (const node of document.querySelectorAll("a[name]")) ids.add(node.getAttribute("name"));
        const titles = [...document.querySelectorAll("head title")].map((node) => (node.textContent ?? "").trim());
        const links = [...document.querySelectorAll("a[href]")].map((a) => ({ raw: a.getAttribute("href") ?? "", href: a.href, text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 60) }));
        // "", "#" and "javascript:" lead nowhere, whatever a script does on the press (VR Part A, item 2).
        const nowhere = links.filter((l) => { const raw = l.raw.trim(); return raw === "" || raw === "#" || /^javascript:/i.test(raw); });
        const here = location.origin + location.pathname;
        const missing = links.filter((l) => {
          const u = new URL(l.href);
          if (u.origin + u.pathname !== here || u.hash.length < 2 || u.hash.includes("=")) return false;
          const id = decodeURIComponent(u.hash.slice(1));
          return id !== "top" && !ids.has(id);
        });
        const noAlt = [...document.querySelectorAll("img:not([alt])")].map((img) => img.outerHTML.slice(0, 160));
        const sources = [...document.querySelectorAll("img")].flatMap((img) => [img.currentSrc, img.src]).filter(Boolean);
        return {
          ids: [...ids],
          titles,
          links: links.map((l) => l.href),
          missing: missing.map((l) => `${new URL(l.href).hash} ("${l.text}")`),
          nowhere: nowhere.map((l) => `href="${l.raw.slice(0, 60)}" ("${l.text}")`),
          noAlt,
          sources,
        };
      });
      const address = landed.pathname + landed.search;
      visited.add(address);
      idsOf.set(address, new Set(found.ids));
      if (found.titles.length !== 1 || !found.titles[0]) fail(where, `has ${found.titles.length} titles: ${JSON.stringify(found.titles)}`);
      for (const anchor of found.missing) fail(where, `links to ${anchor}, which is not on the page`);
      for (const link of found.nowhere) fail(where, `has a link that leads nowhere: ${link}`);
      for (const img of found.noAlt) fail(where, `image without alt: ${img}`);
      for (const src of found.sources) {
        const u = new URL(src, origin);
        if (u.origin !== origin) continue;
        const key = u.pathname + u.search;
        if (!images.has(key)) images.set(key, { kind, from: path });
      }
      for (const href of found.links) {
        const u = new URL(href);
        if (u.origin !== origin || u.pathname.startsWith("/_next/") || /\/(signout|logout)\b/.test(u.pathname)) continue;
        const key = u.pathname + u.search;
        if (!linked.has(key)) linked.set(key, { kind, from: path });
        const here = landed.pathname + landed.search;
        if (key !== here && u.hash.length >= 2 && !isState(u.hash)) {
          const place = decodeURIComponent(u.hash.slice(1));
          if (place !== "top" && !CONDITIONAL_PLACES.has(`${u.pathname}#${place}`) && !anchored.has(`${key}#${place}`)) anchored.set(`${key}#${place}`, { kind, from: path, key, place });
        }
      }
    } catch (error) {
      fail(where, String(error).slice(0, 300));
    } finally {
      for (const error of errors) fail(where, `uncaught error in the browser: ${error}`);
      await page.close();
    }
  }

  const queue = [...publicPaths.map((p) => ["public", p]), ...studioAddresses.map((p) => ["studio", p])];
  async function worker() {
    while (queue.length) {
      const [kind, path] = queue.shift();
      await visit(kind, path);
    }
  }
  // The demo store is made on its first visit (lib/demo-seed.ts), so /demo is opened alone, before anything that
  // links into it.
  await visit("public", "/demo");
  await Promise.all([worker(), worker(), worker()]);

  // A made-up address answers 404 with the site's own page, never an error.
  const missing = await contexts.public.request.get(origin + MISSING, { maxRedirects: 0 });
  if (missing.status() !== 404) fail(MISSING, `answered ${missing.status()}, not 404`);

  /**
   * One address as the same visitor: redirects followed only while they stay on this site (at most 5), as the
   * browser above is never let off it; a redirect elsewhere is an answer and is not followed.
   */
  async function answer(kind, key) {
    let at = origin + key;
    for (let hop = 0; hop <= 5; hop++) {
      const response = await contexts[kind].request.get(at, { maxRedirects: 0, timeout: 60_000 });
      const status = response.status();
      const location = response.headers()["location"];
      if (status < 300 || status >= 400 || !location) return { status, at, body: status < 300 ? response : null };
      const next = new URL(location, at);
      if (next.origin !== origin) return { status, at, body: null };
      at = next.href;
    }
    return { status: 310, at, body: null };
  }

  // Every same-origin link seen on those pages answers below 400, as the same visitor.
  let checked = 0;
  for (const [key, { kind, from }] of linked) {
    if (visited.has(key)) continue;
    checked += 1;
    try {
      const { status } = await answer(kind, key);
      if (status >= 400) fail(`${kind} ${from}`, `links to ${key}, which answered ${status === 310 ? "with more than 5 redirects" : status}`);
    } catch (error) {
      fail(`${kind} ${from}`, `links to ${key}, which did not answer: ${String(error).slice(0, 200)}`);
    }
  }

  // Every #place on another page names an element there: from the page as opened above, else from its HTML.
  for (const { kind, from, key, place } of anchored.values()) {
    try {
      let ids = idsOf.get(key);
      if (!ids) {
        const { status, body } = await answer(kind, key);
        if (status >= 400 || !body) continue; // the link itself is reported above
        const html = await body.text();
        // "&amp;" last, so "&amp;quot;" reads as the text "&quot;", never as a quotation mark (CodeQL, double unescaping).
        ids = new Set([...html.matchAll(/\s(?:id|name)="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
        idsOf.set(key, ids);
      }
      if (!ids.has(place)) fail(`${kind} ${from}`, `links to ${key}#${place}, which is not on that page`);
    } catch (error) {
      fail(`${kind} ${from}`, `links to ${key}#${place}, which could not be read: ${String(error).slice(0, 200)}`);
    }
  }

  // Every same-origin image seen on those pages answers below 400.
  for (const [key, { kind, from }] of images) {
    try {
      const { status } = await answer(kind, key);
      if (status >= 400) fail(`${kind} ${from}`, `shows the image ${key}, which answered ${status}`);
    } catch (error) {
      fail(`${kind} ${from}`, `shows the image ${key}, which did not answer: ${String(error).slice(0, 200)}`);
    }
  }
  console.log(`SITE_LINKS: ${visited.size} pages opened (${publicPaths.length + 1} public, ${studioAddresses.length} studio), ${checked} further links requested, ${anchored.size} #places on other pages and ${images.size} images checked, ${failed} failures`);
} finally {
  await browser?.close();
  try { process.kill(-app.pid, "SIGTERM"); } catch {}
  await services.close();
}
for (const line of failures) console.log(`  FAIL  ${line}`);
process.exit(failed ? 1 : 0);
