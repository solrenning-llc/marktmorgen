/**
 * Accessibility audit of a buyer's store front (app/[handle]/page.tsx,
 * 274 [AX1]), in a real browser: the matrix reported in PR #2987, kept so it
 * can be run again. It is not part of `npm test`, tests/run.mjs or CI.
 *
 *   node tests/e2e/store-front-audit.mjs                 builds the app, then audits
 *   node tests/e2e/store-front-audit.mjs --no-build      uses the build already in .next
 *   node tests/e2e/store-front-audit.mjs --no-build edge long   only these states
 *
 * Environment: CHROMIUM=<path> names a browser executable when playwright's own
 * is not installed (for example CHROMIUM=/opt/pw-browsers/chromium);
 * PLAYWRIGHT_CORE=<folder> names a driver; E2E_SERVICES_PORT and E2E_APP_PORT
 * move the stand-in and the app (defaults 5193 and 3893); AUDIT_OUT=<file>
 * writes every case's full readings as JSON; SHOT=<folder> saves a full-page
 * screenshot of each baseline case.
 *
 * The real app (`next start`) against the stand-in database, Stripe and email
 * of tests/e2e/services.mjs, as tests/e2e/store-copy.mjs runs it; the stores
 * are written by tests/e2e/store-front-seed.ts. Synthetic data only, the keys
 * below are local stand-ins, and every request to another origin is aborted.
 *
 * States (STATES below): a full store, an empty store, a long store, its
 * second page, a search, and "edge" (the two cases asked for in the review of
 * PR #2987: a one-letter product title without details, and narrow-letter
 * text at full length). The first five times nine modes are the 45 cases of
 * the PR; "edge" adds nine. "collection" (a collection's page) can be named,
 * but is not in the default run: its "Everything from" link is a known open
 * item of the PR (18 px tall, in a file other open PRs change).
 *
 * Modes: baseline at 320, 390 and 1280 px; reduced motion at 390; forced
 * colors at 1280; text spacing (1.4.12) at 320 and 1280; 200% zoom (640 CSS
 * px at DPR 2); 400% zoom (320 CSS px at DPR 4).
 *
 * What each case measures:
 *   - axe-core (this project's copy) with the wcag2a…wcag22aaa and
 *     best-practice tags: violations, and the items axe leaves to review
 *     (identical-links-same-purpose is counted on its own);
 *   - targets under 44 × 44 px (2.5.5), a link inline in a sentence excepted;
 *   - line length (1.4.8) two ways: the widest line divided by the average
 *     width of a sample sentence (the PR's method), and the characters
 *     actually on each rendered line, which catches narrow letters the
 *     average misses; and justified text;
 *   - one h1, no skipped heading level, exactly one main#content, a skip link;
 *   - horizontal overflow;
 *   - in baseline cases, real Tab presses: every stop :focus-visible, in view,
 *     with an outline of at least 2 px (or a box shadow), and the first stop
 *     the skip link; the stops are counted;
 *   - under reduced motion, no animation or transition still running;
 *   - page errors.
 *
 * First run (7 November 2026, build of 06bca7d8d, Chromium 153, --no-build):
 * the PR's 45 cases gave its numbers again (540 focus stops, no axe
 * violation, no target under 44 px, no line over 80 by the estimate). The
 * counted method found two lines of 81 characters in the full store at 200%
 * (a card and the waitlist note). "edge" found the one-letter title link
 * 13 px wide in all nine modes, and narrow-letter paragraphs of up to 126
 * characters a line at 1280 and 95–107 at 200%. Those are findings for a
 * fix, not settled by this file.
 *
 * After the fix (min-w-11 on the title link, the cap at 34ch, the FAQ's
 * questions under it; laid over that same build as a style sheet, not
 * rebuilt), full and edge: no target under 44 px, real sentences at most 51
 * characters a line, narrow-letter words at most 75. One count stays over 80:
 * a card's row at 200%, a 79-character title beside its price badge, two
 * boxes, not a block of text (docs/accessibility-programme.md).
 *
 * It exits 1 when any case is flagged and 0 when none is. Automation in one
 * engine: no screen reader, no Firefox or WebKit, no real zoom or device, no
 * people. Passing it is not conformance.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startServices } from "./services.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const require = createRequire(join(root, "package.json"));
const nextCli = join(root, "node_modules/next/dist/bin/next");
const SERVICES = Number(process.env.E2E_SERVICES_PORT || 5193);
const APP = Number(process.env.E2E_APP_PORT || 3893);
const LOCAL = `http://localhost:${APP}`;
const FAKE = `http://127.0.0.1:${SERVICES}`;
const BUILD = !process.argv.includes("--no-build");
const chosen = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  STRIPE_SECRET_KEY: "sk_test_local_only_a_stand_in_0000",
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

let chromium;
for (const name of ["playwright", "playwright-core", process.env.PLAYWRIGHT_CORE].filter(Boolean)) {
  try {
    chromium = require(name).chromium;
    break;
  } catch {}
}
if (!chromium) {
  console.error("This needs Playwright or playwright-core on the machine (PLAYWRIGHT_CORE=<its folder> to name one). Nothing was run.");
  process.exit(2);
}
const axe = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

async function launch() {
  if (process.env.CHROMIUM) return chromium.launch({ executablePath: process.env.CHROMIUM });
  try {
    return await chromium.launch();
  } catch (first) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw first;
    }
  }
}

const MODES = [
  ["baseline", 320], ["baseline", 390], ["baseline", 1280],
  ["reduced-motion", 390], ["forced-colors", 1280], ["text-spacing", 320], ["text-spacing", 1280],
  ["zoom200", 640], ["zoom400", 320],
];
const DEFAULT_STATES = ["full", "empty", "long", "long2", "search", "edge"];
const TEXT_SPACING = "*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";

const run = (cmd, args) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (chunk) => (said += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("close", (status) => done({ status, said }));
  });

/** Everything measured inside the page, after axe is loaded. */
async function readPage() {
  const tags = ["wcag2a", "wcag2aa", "wcag2aaa", "wcag21a", "wcag21aa", "wcag21aaa", "wcag22a", "wcag22aa", "wcag22aaa", "best-practice"];
  const res = await window.axe.run(document, { runOnly: { type: "tag", values: tags } });
  const pick = (list) => list.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, nodes: v.nodes.slice(0, 6).map((n) => ({ t: n.target.join(" "), html: n.html.slice(0, 160), why: (n.any[0]?.message || n.all[0]?.message || n.none[0]?.message || "").slice(0, 200) })) }));
  const html = document.documentElement;
  const mains = [...document.querySelectorAll("main")].map((m) => m.id);
  const heads = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter((h) => h.getClientRects().length).map((h) => ({ l: +h.tagName[1], t: h.textContent.trim().slice(0, 50) }));
  const skips = [];
  for (let i = 1; i < heads.length; i++) if (heads[i].l > heads[i - 1].l + 1) skips.push([heads[i - 1], heads[i]]);
  // 2.5.5: every visible control at least 44 x 44, a link inline in a sentence excepted.
  const small = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[tabindex]:not([tabindex='-1'])")].filter((el) => {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return false;
    if (getComputedStyle(el).visibility === "hidden") return false;
    const t = (el.type === "checkbox" || el.type === "radio") && el.labels?.[0] ? el.labels[0] : el;
    const tb = t.getBoundingClientRect();
    if (tb.width >= 44 && tb.height >= 44) return false;
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
      const txt = (el.parentElement?.textContent || "").trim();
      if (txt.length > (el.textContent || "").trim().length + 10) return false;
    }
    if (el.classList.contains("sr-only") || el.closest(".sr-only")) return false;
    return true;
  }).map((el) => {
    const b = (el.labels?.[0] && (el.type === "checkbox" || el.type === "radio") ? el.labels[0] : el).getBoundingClientRect();
    return { tag: el.tagName, cls: String(el.className).slice(0, 80), text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40), w: Math.round(b.width), h: Math.round(b.height), display: getComputedStyle(el).display };
  });
  // 1.4.8: characters per line in main text, and justified text.
  const canvas = document.createElement("canvas").getContext("2d");
  const sample = "The quick brown fox jumps over the lazy dog and keeps on running far away ";
  const long = [], longActual = [], justified = [];
  for (const el of document.querySelectorAll("main p, main li, main dd, main blockquote, main summary, main figcaption, main h1, main h2, main h3")) {
    if (!el.getClientRects().length || !(el.textContent || "").trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.textAlign === "justify") justified.push(el.textContent.trim().slice(0, 40));
    const textLen = el.textContent.trim().length;
    if (textLen <= 80) continue;
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const avg = canvas.measureText(sample).width / sample.length + (parseFloat(cs.letterSpacing) || 0);
    // Text nodes only: a range over the element would also return the boxes of the elements inside it (a <figure>).
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let widest = 0, most = 0, line = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(".sr-only")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const x of range.getClientRects()) widest = Math.max(widest, x.width);
      // Each character's own box, in reading order; a box that starts below the current line starts the next one.
      // Collapsed white space has no box.
      for (let i = 0; i < node.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const box = range.getClientRects()[0];
        if (!box || !box.width) continue;
        if (!line || box.top >= line.bottom - 1) line = { bottom: box.bottom, count: 0 };
        line.bottom = Math.max(line.bottom, box.bottom);
        most = Math.max(most, ++line.count);
      }
    }
    const chars = Math.round(widest / avg);
    if (chars > 80) long.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), chars, text: el.textContent.trim().slice(0, 40) });
    if (most > 80) longActual.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), chars: most, text: el.textContent.trim().slice(0, 40) });
  }
  // 2.3.3: animations and transitions still running.
  const moving = [...document.querySelectorAll("*")].filter((el) => {
    const cs = getComputedStyle(el);
    return (cs.animationName !== "none" && parseFloat(cs.animationDuration) > 0.01) || (cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0.01) && cs.transitionProperty !== "none");
  }).slice(0, 10).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 80), anim: getComputedStyle(el).animationName, tr: getComputedStyle(el).transitionDuration + " " + getComputedStyle(el).transitionProperty.slice(0, 40) }));
  const imgs = [...document.querySelectorAll("img")].map((i) => ({ alt: i.getAttribute("alt"), src: i.getAttribute("src")?.slice(0, 60), visible: i.getClientRects().length > 0 }));
  const links = [...document.querySelectorAll("a[href]")].filter((a) => a.getClientRects().length).map((a) => ({ name: (a.getAttribute("aria-label") || a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 70), href: a.getAttribute("href")?.slice(0, 80) }));
  return {
    violations: pick(res.violations),
    incomplete: pick(res.incomplete).map((v) => ({ id: v.id, n: v.count, first: v.nodes[0] })),
    scroll: html.scrollWidth, client: html.clientWidth, mains, heads, skips, h1: heads.filter((h) => h.l === 1).length,
    small, long, longActual, justified, moving, imgs, links,
    skipLink: Boolean(document.querySelector("a[href='#content']")), lang: html.lang, title: document.title,
  };
}

/** Real Tab presses until focus comes back round; each stop's focus indicator. */
async function tabStops(page) {
  const focus = [];
  for (let n = 0; n < 160; n++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return { tag: el.tagName, text: (el.innerText || el.getAttribute("aria-label") || el.value || "").trim().slice(0, 50), href: el.getAttribute("href"), visible: el.matches(":focus-visible"), ow: cs.outlineWidth, os: cs.outlineStyle, bs: cs.boxShadow, w: Math.round(b.width), h: Math.round(b.height), inView: b.bottom > 0 && b.top < innerHeight && b.width > 0 };
    });
    if (!f) break;
    if (focus.length && focus[0].tag === f.tag && focus[0].text === f.text && focus[0].href === f.href && n > 2) break;
    focus.push(f);
  }
  return focus;
}

const services = await startServices(SERVICES);
let app = null, browser = null, appLog = "";
const results = [];
let flagged = 0;
try {
  const folder = mkdtempSync(join(tmpdir(), "mm-store-front-seed-"));
  const seedFile = join(folder, "seed.cjs");
  await build({ entryPoints: [join(here, "store-front-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
  // Not spawnSync: the stand-in database it writes to is served by this very process.
  const seeded = await run(process.execPath, [seedFile]);
  rmSync(folder, { recursive: true, force: true });
  if (seeded.status !== 0) throw new Error(`the stores could not be made:\n${seeded.said}`);
  const fixture = JSON.parse(seeded.said.trim().split("\n").at(-1));
  const STATES = {
    full: "/@a11yfront",
    empty: "/@a11yempty",
    long: "/@a11ylong",
    long2: "/@a11ylong?page=2",
    search: "/@a11ylong?q=recipe+7",
    edge: "/@a11yedge",
    collection: `/@a11yfront/shop/${fixture.coll}`,
  };
  const names = chosen.length ? chosen : DEFAULT_STATES;
  for (const name of names) if (!STATES[name]) throw new Error(`unknown state ${name}; known: ${Object.keys(STATES).join(", ")}`);

  if (BUILD) {
    const built = await run(process.execPath, [nextCli, "build"]);
    if (built.status !== 0) throw new Error(`the app did not build:\n${built.said.slice(-3000)}`);
  }
  app = spawn(process.execPath, [nextCli, "start", "-p", String(APP)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [app.stdout, app.stderr]) stream.on("data", (chunk) => (appLog = (appLog + chunk).slice(-8000)));
  const started = Date.now();
  while (!(await fetch(`${LOCAL}/@a11yfront`).then((r) => r.status === 200).catch(() => false))) {
    if (Date.now() - started > 120_000) throw new Error(`the app did not start:\n${appLog.slice(-2000)}`);
    await new Promise((wait) => setTimeout(wait, 1000));
  }

  browser = await launch();
  console.log(`Chromium ${browser.version()}`);
  for (const state of names) {
    const path = STATES[state];
    for (const [mode, width] of MODES) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        deviceScaleFactor: mode === "zoom200" ? 2 : mode === "zoom400" ? 4 : 1,
        serviceWorkers: "block",
        reducedMotion: mode === "reduced-motion" ? "reduce" : "no-preference",
        forcedColors: mode === "forced-colors" ? "active" : "none",
      });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== LOCAL && url.origin !== FAKE) return route.abort();
        if (!["GET", "HEAD"].includes(route.request().method())) return route.fulfill({ status: 204, body: "" });
        return route.continue();
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      const response = await page.goto(LOCAL + path, { waitUntil: "networkidle", timeout: 60000 });
      if (mode === "text-spacing") await page.addStyleTag({ content: TEXT_SPACING });
      if (process.env.SHOT && mode === "baseline") {
        mkdirSync(process.env.SHOT, { recursive: true });
        await page.screenshot({ path: join(process.env.SHOT, `store-front-${state}-${width}.png`), fullPage: true });
      }
      await page.waitForTimeout(300);
      const r = { state, mode, width, status: response.status(), errors };
      if (mode === "baseline") {
        r.focus = await tabStops(page);
        r.focusProblems = r.focus.filter((f) => !f.visible || !f.inView || ((f.os === "none" || parseFloat(f.ow) < 2) && (!f.bs || f.bs === "none")));
        r.firstFocus = r.focus[0] ?? null;
        await page.goto("about:blank");
        await page.goto(LOCAL + path, { waitUntil: "networkidle", timeout: 60000 });
      }
      await page.addScriptTag({ content: axe });
      Object.assign(r, await page.evaluate(readPage));
      const flags = [
        r.status !== 200 && "status:" + r.status,
        r.violations.length && "axe:" + r.violations.map((v) => v.id).join("|"),
        r.incomplete.some((v) => v.id === "identical-links-same-purpose") && "identical-links",
        r.scroll > r.client && "overflow",
        r.mains.length !== 1 && "mains:" + r.mains.join(","),
        r.mains[0] !== "content" && "main-id",
        r.h1 !== 1 && "h1=" + r.h1,
        r.skips.length && "heading-skip",
        r.small.length && "small:" + r.small.length,
        r.long.length && "long:" + r.long.length,
        r.longActual.length && "long-actual:" + r.longActual.length,
        r.justified.length && "justify",
        r.focusProblems?.length && "focus:" + r.focusProblems.length,
        r.firstFocus && r.firstFocus.href !== "#content" && "first-focus-not-skip",
        !r.skipLink && "no-skip",
        mode === "reduced-motion" && r.moving.length && "motion:" + r.moving.length,
        errors.length && "pageerror",
      ].filter(Boolean);
      r.flags = flags;
      if (flags.length) flagged++;
      results.push(r);
      console.log("CASE", state, mode, width, r.status, flags.join(" ") || "ok");
      for (const s of r.small) console.log(`       small ${s.tag} ${s.w}x${s.h} ${JSON.stringify(s.text)}`);
      for (const l of [...r.long, ...r.longActual]) console.log(`       long ${l.tag}.${l.cls.replace(/\s+/g, ".")} ${l.chars} ${JSON.stringify(l.text)}`);
      await context.close();
    }
  }
  const sum = (pick) => results.reduce((n, r) => n + pick(r), 0);
  console.log("\nSummary");
  console.log(`  cases                                  ${results.length}`);
  console.log(`  cases flagged                          ${flagged}`);
  console.log(`  axe violation nodes                    ${sum((r) => r.violations.reduce((n, v) => n + v.count, 0))}`);
  console.log(`  cases with identical-links to review   ${sum((r) => (r.incomplete.some((v) => v.id === "identical-links-same-purpose") ? 1 : 0))}`);
  console.log(`  controls under 44 x 44 px              ${sum((r) => r.small.length)}`);
  console.log(`  lines over 80 (average-width estimate) ${sum((r) => r.long.length)}`);
  console.log(`  lines over 80 (characters counted)     ${sum((r) => r.longActual.length)}`);
  console.log(`  justified text                         ${sum((r) => r.justified.length)}`);
  console.log(`  focus stops (baseline cases)           ${sum((r) => r.focus?.length ?? 0)}`);
  console.log(`  focus problems                         ${sum((r) => r.focusProblems?.length ?? 0)}`);
  console.log(`  page errors                            ${sum((r) => r.errors.length)}`);
} catch (error) {
  console.error(error);
  flagged = Math.max(flagged, 1);
} finally {
  if (process.env.AUDIT_OUT) writeFileSync(process.env.AUDIT_OUT, JSON.stringify(results, null, 1));
  await browser?.close();
  app?.kill("SIGTERM");
  await services.close();
}
process.exit(flagged ? 1 : 0);
