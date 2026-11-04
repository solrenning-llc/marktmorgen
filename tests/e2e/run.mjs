/**
 * The site itself, run on this computer and used in a real browser, from a
 * product's page to the email that opens what was bought.
 *
 *   npm run test:local
 *
 * Why it exists (7 October 2026). The unit tests call the code that hands a
 * purchase over; none of them goes through the door a buyer does. That is how
 * a paid gift went undelivered: every function it was made of was tested and
 * the path between them was not. And two things shipped that week — sections
 * on a store, and a purchase for several people — could only be looked at on
 * a store with products that can sell, which production does not have yet.
 *
 * What runs: the real app, built as the site builds it (`next build`, then
 * `next start`; E2E_DEV=1 runs `next dev` instead), unchanged, pointed at one local
 * stand-in for its database, for Stripe and for the email sender
 * (tests/e2e/services.mjs), through the addresses the code already accepts
 * for exactly this (STRIPE_CONNECT_API_BASE, RESEND_API_BASE, and the
 * database's own). No card is typed and no real service is reached. What it
 * cannot show is Stripe's own page: a checkout that is opened comes back
 * paid.
 *
 * What is checked, in a browser:
 *
 *   - the store page: its sections over the right products, and its line of
 *     news leading to a product;
 *   - a purchase for three people: the price times three, the link on the
 *     page after paying and in the receipt, three people each asking for a
 *     place and opening it from their own email, the product on each one's
 *     list of purchases, and a fourth person told every place is taken;
 *   - a gift: both emails, and the product on the recipient's list as a gift;
 *   - the studio: the sections as saved, a change to them showing on the
 *     store, and the sale named for what it was;
 *   - selling from the creator's own website: the code copied from the
 *     studio, pasted into a page on another address, shows the card; its
 *     button opens a paid checkout in a new tab with the place named on the
 *     sale; the plain button leads to the product's page; and the product's
 *     own page, framed the same way, is refused.
 *
 * It needs a browser driver (Playwright) on the machine; it is not part of
 * `npm test`, which runs anywhere. It takes about a minute.
 *
 * Checked against itself the day it was written: with the function that
 * finds a gift's product made to find nothing (the defect above), it stops
 * with a failure; put back, it passed four times in a row.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startServices } from "./services.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const SERVICES = 4477;
const APP = 3100;
const LOCAL = `http://localhost:${APP}`;
const FAKE = `http://127.0.0.1:${SERVICES}`;
/** Links in emails and on pages are written for the site's real address; here they are opened on this computer. */
const local = (url) => url.replace("https://marktmorgen.com", LOCAL);
/** A buyer's page in the studio, as it was opened from a sale; audited for accessibility with the rest. */
let buyerPath = "/studio/people";

const env = {
  ...process.env,
  DEMO_STUDIO_ADMIN: "operator@example.test",
  STRIPE_DEMO_ACCOUNT_ID: "acct_fixtureDemo",
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  STRIPE_SECRET_KEY: "sk_test_local_only_a_stand_in_0000",
  STRIPE_CONNECT_API_BASE: FAKE,
  RESEND_API_KEY: "re_local_only_a_stand_in",
  // Google Fonts cannot be reached from here: next/font is answered by a stand-in (google-fonts-mock.cjs).
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  RESEND_API_BASE: FAKE,
  ANTHROPIC_API_KEY: "sk-ant-local_only_a_stand_in_0000",
  ANTHROPIC_API_BASE: FAKE,
  // The ad platforms conversions are sent to from the server (lib/ad-events.ts).
  ADS_API_BASE: FAKE,
  // PayPal, as an approved partner, answered by the stand-in (lib/paypal-sales.ts).
  PAYPAL_API_BASE: FAKE,
  PAYPAL_PARTNER_CLIENT_ID: "AZlocalPartnerClient0123",
  PAYPAL_PARTNER_SECRET: "EPlocalPartnerSecret0123",
  PAYPAL_PARTNER_MERCHANT_ID: "LOCALPARTNER01",
  PAYPAL_BN_CODE: "Marktmorgen_Local",
  // Meta: the app's keys, and its consent page and Graph API answered by the stand-in (lib/meta-ads.ts).
  META_APP_ID: "100000000000001",
  META_APP_SECRET: "local_only_a_stand_in",
  META_GRAPH_BASE: FAKE,
  // Discord: the application's keys, and its page and API answered by the stand-in.
  DISCORD_API_BASE: FAKE,
  DISCORD_CLIENT_ID: "950000000000000001",
  DISCORD_CLIENT_SECRET: "local_only_a_stand_in",
  DISCORD_BOT_TOKEN: "local_only_a_stand_in",
  // The file store: what the server writes goes to the stand-in (services.mjs).
  VERCEL_BLOB_API_URL: `${FAKE}/blob-api`,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_localstore_standinsecret0000",
  NEXT_TELEMETRY_DISABLED: "1",
};

let chromium;
let axePath;
try {
  const require = createRequire(join(root, "package.json"));
  ({ chromium } = require("playwright"));
  // The accessibility rules most audits run (axe-core), from this project's own copy.
  axePath = require.resolve("axe-core/axe.min.js");
} catch {
  console.error("This needs Playwright on the machine (npm i -g playwright). Nothing was run.");
  process.exit(2);
}

/** Stops the app and waits for it to go, so it never leaves its cache half written. */
const stopped = new WeakSet();
async function stop(child) {
  if (!child?.pid || child.exitCode !== null) return;
  stopped.add(child);
  const gone = new Promise((done) => child.once("exit", done));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const late = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 15_000);
  await gone;
  clearTimeout(late);
}

let failed = 0;
function is(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${same ? "ok  " : "FAIL"}  ${name}`);
  if (!same) {
    failed += 1;
    console.log(`        expected ${JSON.stringify(want)}\n        got      ${JSON.stringify(got)}`);
  }
}
const part = (name) => console.log(`\n${name}`);
const words = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();

const services = await startServices(SERVICES);
let app = null;
let browser = null;
/** Starts the app again (set once the app is up). */
let restartApp = async () => {};
/** A published post's address, once the blog part has made one: checked after a restart. */
let postPath = "";
let tipPath = "";
let preorderId = "";
let preorderSession = "";
let pickId = "";
/**
 * Starts the app again when it has grown past what this machine lets it use.
 * A dev server keeps everything it has built in memory, and past about 5 GB
 * the machine stops it in the middle of whatever check is running; asked
 * before each part, this restarts it between checks instead.
 */
const APP_MEMORY_LIMIT_MB = 3_000;
/**
 * The app is built once and served as the site serves it: a fraction of the
 * dev server's memory and none of its faults. E2E_DEV=1 runs the dev server
 * instead, for a quick look at a change without building.
 */
const PRODUCTION = process.env.E2E_DEV !== "1";
async function keepSmall() {
  if (!app?.pid) return;
  const { execFileSync } = await import("node:child_process");
  let mb = 0;
  try {
    const out = execFileSync("ps", ["-o", "rss=", "-g", String(app.pid)], { encoding: "utf8" });
    mb = out.split("\n").reduce((sum, line) => sum + (Number(line.trim()) || 0), 0) / 1024;
  } catch {
    return;
  }
  if (mb > APP_MEMORY_LIMIT_MB) {
    console.log(`(the app had grown to ${Math.round(mb)} MB; it is started again)`);
    await restartApp();
  }
}
/** Everything the app said, kept for E2E_APP_LOG=<file> (written there at the end). */
let appLog = "";
try {
  // The store, written through the studio's own functions.
  const out = mkdtempSync(join(tmpdir(), "nimbus-e2e-seed-"));
  const seedFile = join(out, "seed.cjs");
  await build({ entryPoints: [join(here, "seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
  // Not spawnSync: the stand-in database it writes to is served by this very process.
  const seeded = await new Promise((done) => {
    const child = spawn(process.execPath, [seedFile], { env, stdio: ["ignore", "pipe", "pipe"] });
    const said = { out: "", err: "" };
    child.stdout.on("data", (chunk) => (said.out += chunk));
    child.stderr.on("data", (chunk) => (said.err += chunk));
    child.on("close", (status) => done({ status, ...said }));
  });
  if (seeded.status !== 0) throw new Error(`the store could not be made:\n${seeded.err}`);
  const { ids, reviews: seededReviews, fresh, session, statsId, longSession } = JSON.parse(seeded.out.trim().split("\n").at(-1));

  // Built once, before it is served (see PRODUCTION above).
  if (PRODUCTION) {
    const built = await new Promise((done) => {
      const child = spawn("npx", ["next", "build"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let said = "";
      child.stdout.on("data", (chunk) => (said += chunk));
      child.stderr.on("data", (chunk) => (said += chunk));
      child.on("close", (status) => done({ status, said }));
    });
    if (built.status !== 0) throw new Error(`the app did not build:\n${built.said.slice(-3000)}`);
  }

  // The app. A dev server stopped while writing can leave Turbopack's cache
  // unreadable, and the next one panics on it; it is only a cache, so it is
  // put aside once and the app started again.
  let log = "";
  const start = () => {
    log = "";
    app = spawn("npx", ["next", PRODUCTION ? "start" : "dev", "-p", String(APP)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    app.stdout.on("data", (chunk) => {
      log += chunk;
      appLog += chunk;
    });
    app.stderr.on("data", (chunk) => {
      log += chunk;
      appLog += chunk;
    });
    // Said at once if the app stops on its own, so a failure after it is not a mystery.
    const self = app;
    app.on("exit", (code, signal) => {
      if (!stopped.has(self)) console.error(`\nThe app stopped by itself (code ${code}, signal ${signal}).`);
    });
  };
  start();
  let started = Date.now();
  let retried = false;
  for (;;) {
    if (/panicked/.test(log) && !retried) {
      retried = true;
      await stop(app);
      rmSync(join(root, ".next", "dev", "cache"), { recursive: true, force: true });
      start();
      started = Date.now();
    }
    if (Date.now() - started > 180_000 || /panicked/.test(log)) throw new Error(`the app did not start:\n${log.slice(-2000)}`);
    const up = await fetch(`${LOCAL}/@localshop`).then((r) => r.status === 200).catch(() => false);
    if (up) break;
    await new Promise((wait) => setTimeout(wait, 1500));
  }

  // The dev server builds each route the first time it is asked for; asked
  // once here, so no check below races a route still being built.
  for (const path of [`/@localshop/p/${ids["Meal Planner"]}`, "/api/store/checkout", "/studio", "/@localshop/orders"]) {
    await fetch(`${LOCAL}${path}`).catch(() => {});
  }
  // On a fresh dev server, the store's pages under a product (its page, its
  // booking page) have now and then all answered "not found" for as long as
  // that server ran, without the page's code ever running — never on the
  // site itself, and never on a second server. So the first product page is
  // asked for until it is found, and a server that does not find it within
  // half a minute is started again, its cache put aside, at most twice.
  for (let restarts = 0; ; restarts += 1) {
    let found = false;
    for (let waited = 0; waited < 30_000 && !found; waited += 3_000) {
      const answer = await fetch(`${LOCAL}/@localshop/p/${ids["Meal Planner"]}`, { redirect: "manual" }).catch(() => null);
      found = answer?.status === 200;
      if (!found) await new Promise((wait) => setTimeout(wait, 3_000));
    }
    if (found) break;
    if (restarts >= 2) throw new Error("the product page was not found on three dev servers in a row");
    console.log("the first product page was not found; the dev server is started again");
    await stop(app);
    rmSync(join(root, ".next", "dev", "cache"), { recursive: true, force: true });
    start();
    const again = Date.now();
    while (!(await fetch(`${LOCAL}/@localshop`).then((r) => r.status === 200).catch(() => false))) {
      if (Date.now() - again > 180_000) throw new Error(`the app did not start again:\n${log.slice(-2000)}`);
      await new Promise((wait) => setTimeout(wait, 1500));
    }
    for (const path of [`/@localshop/p/${ids["Meal Planner"]}`, "/api/store/checkout", "/studio", "/@localshop/orders"]) {
      await fetch(`${LOCAL}${path}`).catch(() => {});
    }
  }
  // One dev server keeps everything it has built in memory, and this run opens
  // nearly every page of the site: past about 5 GB the machine stops it. So it
  // is started again partway, which forgets nothing the checks below rely on:
  // what they wrote lives in the stand-in database. The same "not found" fault
  // as above can come with a fresh server (here it answered a published post,
  // a buy button and two studio routes with 404), so its cache is put aside
  // and it is checked the same way, on a page that exists by then too.
  restartApp = async () => {
    for (let restarts = 0; ; restarts += 1) {
      await stop(app);
      rmSync(join(root, ".next", "dev", "cache"), { recursive: true, force: true });
      start();
      const again = Date.now();
      while (!(await fetch(`${LOCAL}/@localshop`).then((r) => r.status === 200).catch(() => false))) {
        if (Date.now() - again > 180_000) throw new Error(`the app did not start again:\n${log.slice(-2000)}`);
        await new Promise((wait) => setTimeout(wait, 1500));
      }
      let found = false;
      for (let waited = 0; waited < 30_000 && !found; waited += 3_000) {
        // A product page, a published post, and a route that takes only POST
        // (which answers a GET with 405 when it is there, 404 when it is not).
        const answers = await Promise.all(
          [`/@localshop/p/${ids["Meal Planner"]}`, postPath || "/@localshop", "/api/store/socials"].map((path) =>
            fetch(`${LOCAL}${path}`, { redirect: "manual" }).then((r) => r.status).catch(() => 0),
          ),
        );
        found = answers[0] === 200 && answers[1] === 200 && answers[2] === 405;
        if (!found) await new Promise((wait) => setTimeout(wait, 3_000));
      }
      if (found) return;
      if (restarts >= 2) throw new Error("the restarted app did not find its pages on three dev servers in a row");
      console.log("the restarted app did not find its pages; it is started again");
    }
  };
  browser = await chromium.launch(process.env.PLAYWRIGHT_BROWSERS_PATH ? { executablePath: join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") } : {}).catch(() => chromium.launch());
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  // What a page's own security headers refused (lib/csp.ts): a script left without leave to run, a feature no browser knows.
  const policyRefusals = [];
  const reactWarnings = [];
  // A screenshot taken while another page is still being drawn hides the
  // text cursor by writing caret-color into the inputs: Playwright's doing,
  // not the page's. A diff that differs in nothing else is not a fault.
  const onlyScreenshotCaret = (text) => {
    // The diff is what follows React's link; the bullet list before it is the same in every warning.
    const diff = text.includes("hydration-mismatch") ? text.slice(text.indexOf("hydration-mismatch")) : "";
    const changed = diff.split("\n").map((line) => line.trim()).filter((line) => /^[+-]\s/.test(line));
    return changed.length > 0 && changed.every((line) => /caret-color:\s*"?transparent/.test(line));
  };
  // A frame refused on purpose (the product page framed by another site, below) is the policy working, not a fault.
  const watchPolicy = (target) => target.on("console", (m) => {
    if (/Content Security Policy|Permissions-Policy/.test(m.text()) && !/frame-ancestors/.test(m.text())) policyRefusals.push(m.text().slice(0, 200));
    // React saying the page the server drew is not the one the browser drew: the "1 Issue" a creator would see in development.
    // With where it happened and the end of React's diff, which names what differed.
    if (/hydrat|did not match|Warning: /.test(m.text()) && !onlyScreenshotCaret(m.text())) reactWarnings.push(`${target.url()} :: ${m.text().slice(0, 160)} … ${m.text().slice(-700)}`);
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  watchPolicy(page);
  const open = (target, url) => target.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
  const sectionsOn = (target) =>
    target.$$eval("main section[aria-label]", (all) => all.map((s) => [s.querySelector("h2")?.textContent ?? "", s.querySelectorAll("ul > li").length]));

  await keepSmall();
  part("The store page");
  await open(page, `${LOCAL}/@localshop`);
  is("its sections, each over its own products", await sectionsOn(page), [["Recipe books", 2], ["Planning", 2], ["Courses", 1]]);
  is("its line of news, leading to the product it names", [await words(page.locator(".st-announce")), await page.locator(".st-announce a").getAttribute("href")], ["New: Knife Skills, ten short lessons →", `/@localshop/p/${ids["Knife Skills"]}`]);
  is("every product can be bought", await page.locator('form[action="/api/store/checkout"]').count(), 5);

  await keepSmall();
  part("A purchase for three people");
  await open(page, `${LOCAL}/@localshop/p/${ids["Meal Planner"]}`);
  // The first product page a fresh dev server builds has, now and then, come
  // back without its buy box; what it showed is said, and it is asked once more.
  for (let tries = 0; tries < 3 && !(await page.locator("#group summary").count()); tries += 1) {
    console.log("the product page came back without its buy box:", page.url(), (await words(page.locator("body"))).slice(0, 200));
    // What the app said meanwhile: why a page it has just built answers "not found" is in there.
    console.log("the app's last words:", log.split("\n").filter((l) => /GET |POST |⨯|rror/.test(l) && !/Error while requesting resource|Failed to download|next\/font/.test(l)).slice(-20).join("\n"));
    await page.waitForTimeout(3_000);
    await open(page, `${LOCAL}/@localshop/p/${ids["Meal Planner"]}`);
  }
  await page.locator("#group summary").click();
  is("offered under the buy box, at the price for each", await words(page.locator("#group button[type=submit]")), "Buy for your team — $27 per person");
  await page.fill('#group input[name="people"]', "3");
  // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
  for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
  await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#group button[type=submit]").click()]);
  await page.waitForLoadState("networkidle");
  is("paid: the price, three times", [await words(page.locator("h1")), (await words(page.locator("main"))).includes("for 3 people, for $81.")], ["Your 3 places are ready", true]);
  const link = await page.locator("#group-link").inputValue();
  is("the link to pass on is on the page", /\/@localshop\/group\/grp_[0-9a-f]{24}$/.test(link), true);
  const receipt = services.emails().at(-1);
  is("and in the buyer's receipt", [[].concat(receipt.to)[0], receipt.subject, receipt.text.includes(link)], ["buyer@example.com", "Your 3 places: Meal Planner", true]);

  const takes = async (address) => {
    const person = await context.newPage();
    await open(person, local(link));
    const left = (await words(person.locator("main"))).match(/(\d of \d places? (?:is|are) still open|All \d places have been taken)/)?.[1] ?? "";
    if ((await person.locator('input[name="email"]').count()) === 0) {
      await person.close();
      return { left, form: false };
    }
    await person.fill('input[name="email"]', address);
    await Promise.all([person.waitForURL(/status=sent/, { timeout: 60_000 }), person.locator("button[type=submit]").click()]);
    const mail = services.emails().filter((email) => [].concat(email.to).includes(address)).at(-1);
    const emailed = mail?.text.match(/https:\/\/\S+\?take=[0-9a-f]{64}/)?.[0] ?? "";
    await open(person, local(emailed));
    const said = await words(person.locator("h1"));
    await open(person, local((await person.locator('a:has-text("Open it")').getAttribute("href")) ?? ""));
    const list = await words(person.locator("main"));
    await person.close();
    return { left, form: true, mail: mail?.subject, said, owns: list.includes("Meal Planner") && list.includes("A place somebody bought for you") };
  };
  const took = { left: "", form: true, mail: "Take your place in Meal Planner", said: "The place is yours", owns: true };
  is("the first person: asks, opens their email, has it", await takes("ana@example.com"), { ...took, left: "3 of 3 places are still open" });
  is("the second", await takes("ben@example.com"), { ...took, left: "2 of 3 places are still open" });
  is("the third", await takes("cy@example.com"), { ...took, left: "1 of 3 places is still open" });
  is("a fourth is told every place is taken, and offered no form", await takes("dee@example.com"), { left: "All 3 places have been taken", form: false });

  await keepSmall();
  part("Two boxes at checkout");
  await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
  const boxes = page.locator('#buy input[name="bump"]');
  const buy = page.locator('#buy form:has(input[name="bump"]) button[type=submit]');
  is("each its own box, never checked for the buyer", [await boxes.count(), await boxes.evaluateAll((all) => all.some((box) => box.checked))], [2, false]);
  is("each says what it adds and for how much", await page.locator("#buy label:has(input[name=bump])").evaluateAll((all) => all.map((l) => l.innerText.split("\n")[0])), ["Add Pantry Checklist for $5", "Add Sunday Baking for $15"]);
  const says = [await words(buy)];
  await boxes.nth(1).check();
  says.push(await words(buy));
  await boxes.nth(0).check();
  says.push(await words(buy));
  await boxes.nth(1).uncheck();
  says.push(await words(buy));
  if (process.env.E2E_SHOTS) await page.locator("#buy").screenshot({ path: join(process.env.E2E_SHOTS, "two-boxes.png") });
  is("the button says the total of what is checked, whichever it is", says, ["Buy for $19", "Buy both for $34", "Buy all three for $39", "Buy both for $24"]);
  await boxes.nth(1).check();
  // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
  for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
  await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), buy.click()]);
  await page.waitForLoadState("networkidle");
  const both = services.checkouts().at(-1);
  is("one payment of all three, each named on the order", [both.amount_total, both.metadata.bump, both.metadata.bump2], [3900, ids["Pantry Checklist"], ids["Sunday Baking"]]);
  const thanks = await words(page.locator("main"));
  is("and the page after paying hands each one over", [thanks.includes("You bought Weeknight Dinners, Pantry Checklist, and Sunday Baking"), await page.locator('p.st-label:text-is("Also yours")').count()], [true, 2]);

  part("A photo on a review, made smaller on the buyer's device");
  {
    const form = page.locator(`#r-${ids["Sunday Baking"]}`);
    // A large picture, as a phone takes one: drawn here, so it is a real PNG.
    const drawn = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 2400;
      canvas.height = 1800;
      const pen = canvas.getContext("2d");
      for (let i = 0; i < 6000; i += 1) {
        pen.fillStyle = `hsl(${(i * 7) % 360} 70% ${30 + (i % 40)}%)`;
        pen.fillRect((i * 37) % 2400, (i * 91) % 1800, 24, 24);
      }
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await form.locator('input[type="file"]').setInputFiles({ name: "loaf.png", mimeType: "image/png", buffer: Buffer.from(drawn, "base64") });
    const preview = form.getByRole("img", { name: "Your photo" });
    await preview.waitFor({ timeout: 15_000 });
    const sent = await form.locator('input[name="photo"]').inputValue();
    const side = await preview.evaluate((img) => Math.max(img.naturalWidth, img.naturalHeight));
    is("it is shown, made 1,200 pixels at most and under 400 KB, ready to go with the form", [/^data:image\/(webp|jpeg);base64,/.test(sent), side, Buffer.from(sent.split(",")[1] ?? "", "base64").length <= 400_000], [true, 1200, true]);
    await form.getByRole("button", { name: "Remove my photo" }).click();
    is("and taken off again before it is sent", [await form.locator('input[name="photo"]').inputValue(), await preview.count()], ["", 0]);
  }

  await keepSmall();
  part("A gift");
  const before = services.emails().length;
  await open(page, `${LOCAL}/@localshop/p/${ids["Sunday Baking"]}`);
  await page.locator("#gift summary").click();
  await page.fill('#gift input[name="gift_to"]', "friend@example.com");
  await page.fill('#gift input[name="gift_from"]', "Ana");
  await page.fill('#gift textarea[name="gift_message"]', "Happy birthday!");
  // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
  for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
  await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#gift button[type=submit]").click()]);
  is("paid, and the page says where it went", await words(page.locator("h1")), "Your gift is on its way");
  // The gift is handed over once the page has been sent: its emails follow by a moment.
  let sent = [];
  for (let i = 0; i < 40 && sent.length < 2; i += 1) {
    await new Promise((wait) => setTimeout(wait, 500));
    sent = services.emails().slice(before);
  }
  is("one email each: the recipient and the buyer", sent.map((email) => [[].concat(email.to)[0], email.subject]), [["friend@example.com", "Ana sent you a gift: Sunday Baking"], ["buyer@example.com", "Your gift is on its way: Sunday Baking"]]);
  const gift = sent.find((email) => [].concat(email.to)[0] === "friend@example.com");
  is("with the buyer's message", gift?.text.includes("Happy birthday!"), true);
  await open(page, local(gift?.text.match(/https:\/\/\S+\/orders\?token=[0-9a-f]+/)?.[0] ?? ""));
  const given = await words(page.locator("main"));
  is("the recipient opens it from their email, as a gift", [given.includes("Sunday Baking"), given.includes("A gift from Ana")], [true, true]);

  await keepSmall();
  part("The studio");
  const wide = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await wide.addCookies([{ name: "nl_session", value: session, url: LOCAL }]);
  const studio = await wide.newPage();
  studio.on("pageerror", (error) => errors.push(String(error)));
  watchPolicy(studio);
  await open(studio, `${LOCAL}/studio`);
  const card = studio.locator(".card", { has: studio.locator('p:text-is("Sections and news on your store")') });
  const headings = card.locator('input[placeholder="For example: Courses"]');
  is("the sections as they were saved", await headings.evaluateAll((all) => all.map((input) => input.value)), ["Recipe books", "Planning", "Courses"]);
  is("the sale is named for what it was", (await studio.locator("body").innerText()).includes("Meal Planner (for 3 people)"), true);
  is("a sale opens its buyer's page", (await studio.getByRole("link", { name: "See this buyer's page" }).count()) > 0, true);
  await headings.first().fill("Cookbooks");
  await card.locator('button:has-text("Add a section")').click();
  await headings.last().fill("Quick lists");
  await card.locator("ul select").last().selectOption({ label: "Pantry Checklist" });
  await card.locator('button:has-text("Save sections")').click();
  await studio.waitForTimeout(2500);
  await open(page, `${LOCAL}/@localshop`);
  is("a change there shows on the store", await sectionsOn(page), [["Cookbooks", 2], ["Planning", 1], ["Quick lists", 1], ["Courses", 1]]);

  await keepSmall();
  part("The numbers: a goal, the call on ads, buyers for ads, Slack and Discord");
  {
    await open(studio, `${LOCAL}/studio`);
    const numbers = studio.locator("#numbers");
    await numbers.getByRole("button", { name: "Set a goal for the month" }).click();
    await numbers.locator('input[placeholder="3000"]').fill("3000");
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/goal") && r.ok(), { timeout: 30_000 }),
      numbers.getByRole("button", { name: "Save", exact: true }).first().click(),
    ]);
    const goalText = await numbers.locator("text=/of \\$3,000/").first().innerText();
    is("a goal is set from the studio and shown with how far along the month is", /of \$3,000, \d+%/.test(goalText), true);
    is("with its bar", await numbers.getByRole("progressbar").count(), 1);
    const today = new Date().toISOString().slice(0, 10);
    const added = await studio.evaluate(async (day) => {
      const r = await fetch("/api/store/spend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", channel: "instagram", campaign: "", cents: 5000, from: day, to: day }) });
      return r.ok;
    }, today);
    is("an ad's cost is added", added, true);
    await open(studio, `${LOCAL}/studio`);
    // textContent, not innerText: the headings are drawn in capitals.
    const heads = (await studio.locator("#numbers table th[scope=col]").allTextContents()).map((t) => t.trim());
    is("each channel with ad spend gets a call and the days it took to pay back", [heads.includes("Call"), heads.includes("Paid back")], [true, true]);
    const row = await studio.locator("#numbers tr", { has: studio.locator('th:text-is("Instagram")') }).first().innerText();
    is("$50 that brought nothing is called cut, and is not paid back", [/Cut/.test(row), /Not yet, 0%/.test(row)], [true, true]);
    is("the buyers' file for ad audiences is offered", await studio.getByRole("button", { name: "Download buyers for ads" }).count(), 1);
    // Beside stores its size (lib/benchmarks.ts): the studio's numbers are this week's sample; a store
    // under 300 visitors in 90 days is set beside nobody, even where its band has ranges.
    {
      const [weeks] = await services.redis([["SCAN", "0", "MATCH", "nl:bench:s:*", "COUNT", "1000"]]);
      const week = (weeks?.[1] ?? [])[0] ?? "";
      const [fields] = week ? await services.redis([["HGETALL", week]]) : [[]];
      is("the studio's numbers are kept as the week's sample, marked as too small to compare", [Boolean(week), (fields ?? []).filter((_, i) => i % 2 === 1).every((v) => v === "{}")], [true, true]);
      const range = { low: 0.01, median: 0.02, high: 0.03, stores: 12 };
      await services.redis([["SET", "nl:bench:ranges", JSON.stringify({ at: 1, stores: 12, ranges: { a: { converted: range, paid: range, refunded: range, returning: range } } })]]);
      await open(studio, `${LOCAL}/studio`);
      is("and with too few visitors of its own, it is set beside nobody", await studio.locator("[data-beside-stores]").count(), 0);
    }
    // What the store's Meta ad account spent, read into the same rows (lib/meta-ads.ts).
    {
      // Meta's page is another site: the form's redirect to it is followed here by hand, as a browser would.
      const toMeta = (await studio.request.post(`${LOCAL}/api/integrations/meta/start`, { form: {}, maxRedirects: 0, headers: { Origin: LOCAL } })).headers().location ?? "";
      is("connecting Meta asks for reading ads and nothing else", new URL(toMeta).searchParams.get("scope"), "ads_read");
      await open(studio, toMeta);
      await studio.locator("[data-meta-ads]").waitFor({ state: "attached", timeout: 30_000 });
      const said = await words(studio.locator("main"));
      is("and comes back connected, read at once", [studio.url().includes("metaads=connected"), /Your Meta ad account is connected/i.test(said)], [true, true]);
      await studio.locator("#numbers details", { has: studio.locator("[data-meta-ads]") }).locator("summary").click();
      const block = await words(studio.locator("[data-meta-ads]"));
      is("the account and what it spent over the last 30 days", [/Local Ads \(USD\)/.test(block), /\$42(\.00)? over the last 30 days, 1 campaign/.test(block)], [true, true]);
      const igRow = await studio.locator("#numbers tr", { has: studio.locator('th:text-is("Instagram")') }).first().innerText();
      is("Instagram's row now counts the $30 Meta read with the $50 typed", /\$80/.test(igRow), true);
      is("the typed line on the same channel and day is pointed out", (await words(studio.locator("#numbers details", { has: studio.locator("[data-meta-ads]") }))).includes("on days Meta was read"), true);
      is("read once, from the account connected", services.meta().filter((c) => c.startsWith("GET /act_555/insights")).length, 1);
      if (process.env.E2E_SHOTS) await studio.locator("[data-meta-ads]").screenshot({ path: join(process.env.E2E_SHOTS, "meta-ads.png") });
      await studio.locator("[data-meta-ads]").getByRole("button", { name: "Disconnect Meta ads" }).click();
      await studio.waitForURL(/metaads=disconnected/, { timeout: 30_000 });
      is("disconnecting gives the permission back and takes Meta's lines away", [services.meta().includes("DELETE /me/permissions"), /\$80/.test(await studio.locator("#numbers tr", { has: studio.locator('th:text-is("Instagram")') }).first().innerText())], [true, false]);
    }
    // The same money three ways (lib/attribution-rules.ts), and the window the creator chooses.
    const three = studio.locator("#numbers [data-attribution]");
    is("each channel's money by its last visit, its first and what buyers said, side by side", [
      (await three.locator("caption").textContent())?.startsWith("Where the money came from, three ways"),
      (await three.locator("th[scope=col]").allTextContents()).map((t) => t.trim()),
    ], [true, ["Channel", "Last visit", "First visit", "Buyers said"]]);
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/attribution") && r.ok(), { timeout: 30_000 }),
      three.getByRole("combobox").selectOption("60"),
    ]);
    await open(studio, `${LOCAL}/studio`);
    is("the window is saved, and the note under the money says it", [
      await studio.locator("#numbers [data-attribution]").getByRole("combobox").inputValue(),
      (await studio.locator("#numbers").innerText()).includes("in the 60 days before"),
    ], ["60", true]);
    await studio.evaluate(() => fetch("/api/store/attribution", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: 30 }) }));
    // Who bought (lib/stats.ts, buyersFrom): the counts, and for the owner the biggest buyers, each opening their page.
    const buyersText = await studio.locator("#numbers").innerText();
    is("who bought: the counts, and the biggest buyers for the owner", [
      /Your buyers/.test(buyersText),
      /average order/i.test(buyersText),
      (await studio.locator('#numbers a[href*="/studio/people"]', { hasText: "buyer@example.com" }).count()) > 0,
    ], [true, true, true]);
    const file = await studio.evaluate(async () => {
      const r = await fetch("/api/store/audience");
      return [r.status, (await r.text()).split("\r\n")[0]];
    });
    is("and comes as a list of addresses", file, [200, "email"]);
    is("the box for Slack or Discord is there", await studio.getByText("Post the numbers to Slack or Discord").count(), 1);
    const refused = await studio.evaluate(async () => (await fetch("/api/store/chat-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://example.com/hook" }) })).status);
    is("and an address of neither is refused", refused, 400);
    // Each sale and each alert in the chat too (lib/sale-events.ts, lib/store-alerts.ts): a setting of its own.
    const chatSales = await studio.evaluate(async () => {
      const post = (on) => fetch("/api/store/chat-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sales: on }) }).then((r) => r.json());
      return [(await post(true)).sales, (await post(false)).sales];
    });
    is("each sale and each alert can be posted to the chat too, and stopped", chatSales, [true, false]);
    if (process.env.E2E_SHOTS) {
      await numbers.screenshot({ path: join(process.env.E2E_SHOTS, "numbers-six.png") });
    }
    // Asking the numbers (lib/numbers-ask.ts): an answer from them, only figures they hold, and the way to them.
    const asking = studio.locator("[data-numbers-ask]");
    await asking.locator("#numbers-question").fill("How many visitors this month?");
    await asking.getByRole("button", { name: "Ask", exact: true }).click();
    await asking.locator("[data-numbers-answer]").waitFor({ timeout: 30_000 });
    const chips = await words(asking.locator("[data-numbers-answer] dl"));
    is("asked in plain words, answered with the figure it rests on, a made-up one left out", [
      /You had \d+ visitors in the last 30 days\./.test(await words(asking.locator("[data-numbers-answer] p").first())),
      /Visitors \d+/.test(chips),
      chips.includes("123,456"),
    ], [true, true, false]);
    await asking.getByRole("button", { name: /Show these numbers, last 30 days/ }).click();
    is("and opens the panel at those days", await studio.getByRole("group", { name: "Period" }).locator("button[aria-pressed=true]").innerText(), "30 days");
    // Any dates (lib/stats.ts, readRange), and when buyers buy (lib/buying-hours.ts).
    await studio.getByRole("button", { name: "Any dates", exact: true }).click();
    const anyDates = studio.locator("[data-custom-range]");
    await anyDates.getByRole("button", { name: "Show these days" }).click();
    await anyDates.locator("[data-range-result]").waitFor({ timeout: 30_000 });
    const rangeWords = await words(anyDates.locator("[data-range-result]"));
    is("any dates are read, set beside the days before", [/Visitors \d/i.test(rangeWords), /Revenue \$/i.test(rangeWords), /14 days/.test(rangeWords), /the days before/.test(rangeWords)], [true, true, true, true]);
    // Inside the days the boxes allow, but the wrong way round.
    await anyDates.locator("#range-from").fill(new Date().toISOString().slice(0, 10));
    await anyDates.locator("#range-to").fill(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10));
    await anyDates.getByRole("button", { name: "Show these days" }).click();
    await anyDates.getByRole("alert").waitFor({ timeout: 15_000 });
    is("and dates out of order are said plainly", await words(anyDates.getByRole("alert")), "The start date comes after the end date. Swap them.");
    const hoursBlock = studio.locator("[data-buying-hours]");
    is("when buyers buy, by day and by hour, in the reader's own time", [await hoursBlock.count(), /in [A-Za-z_/]+ time/.test(await words(hoursBlock))], [1, true]);
    // What customers are saying (lib/customer-voice.ts): read once a month, from the store's own lists.
    const voice = studio.locator("[data-customer-voice]");
    is("what customers are saying is offered under the numbers", await voice.count(), 1);
    await voice.getByRole("button", { name: /Sum up what customers said|Read / }).click();
    await voice.locator("[data-voice-theme], [role=status]").first().waitFor({ timeout: 30_000 });
    const voiceWords = await words(voice);
    is("sorted into themes with the customers' own words, or said plainly that there is not enough yet", [
      /Wants it in another format/.test(voiceWords) || /Not enough yet/.test(voiceWords),
      /Made up from/.test(voiceWords),
    ], [true, false]);
    // "Worth knowing", where it speaks, carries a step for each sentence it can (lib/insights.ts).
    const worth = studio.locator("[role=region][aria-labelledby=numbers-insights]");
    if (await worth.count()) {
      is("each sentence of \u201cWorth knowing\u201d has a step beside it", (await worth.locator("li").count()) <= (await worth.locator("[data-insight-action]").count()) + 1, true);
    }
    await studio.getByText("Today so far").waitFor({ timeout: 40_000 });
    is("today so far is shown beside who is on the store now", await studio.getByText("Today so far").count(), 1);
    const before = await studio.locator("#numbers").getByRole("button", { name: "Don't count this device" }).count();
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/no-count") && r.ok(), { timeout: 30_000 }),
      studio.getByRole("button", { name: "Don't count this device" }).click(),
    ]);
    // The answer arrives before the button is drawn again with its new words.
    await studio.getByRole("button", { name: "Count this device again" }).waitFor({ timeout: 15_000 }).catch(() => {});
    is("this device can be marked not to be counted", [before, await studio.getByRole("button", { name: "Count this device again" }).count()], [1, 1]);
    const marked = (await wide.cookies(LOCAL)).some((c) => c.name === "nl_nc" && /^[0-9a-f]{12}$/.test(c.value));
    is("and carries only a hash of the store", marked, true);
    await open(studio, `${LOCAL}/studio/memberships`);
    is("the memberships page still opens", await studio.getByRole("heading", { name: "How your memberships are doing" }).count(), 1);
    const members = await studio.locator("main").innerText();
    is("why members leave: the two who chose to, each reason, and the failed payment said apart", [
      /2 members canceled and 2 picked a reason/.test(members),
      /It costs too much/.test(members),
      /I don't use it enough/.test(members),
      /1 more membership ended because a payment never went through/.test(members),
    ], [true, true, true, true]);
    const leaveSection = await words(studio.locator("section", { hasText: "Why members leave" }));
    is("their words, without a name or an address", [/Love it, but money is tight this month\./.test(leaveSection), /@example\.com/.test(leaveSection)], [true, false]);
    is("and the next three months, said as an estimate", [/The next three months, if the pace holds/.test(members), /An estimate, not a promise/.test(members)], [true, true]);
    const moves = studio.locator("[data-mrr-movements]");
    is("recurring revenue month by month, the latest month ending on the revenue above", [
      await moves.count(),
      await moves.locator("svg path").count() > 0,
      (await words(moves.locator("tbody tr").first())).endsWith("$140"),
    ], [1, true, true]);
    const health = studio.locator("[data-member-health]");
    is("each running member scored, the reasons beside them, addresses for the owner", [
      await health.count(),
      /doing well 7 70 to 100/i.test(await words(health)),
      (await words(health)).includes("member0001@example.com"),
      await health.locator("tbody tr").count(),
    ], [1, true, true, 7]);
    is("what came back after failing: the renewal paid on Stripe's third try", [/Payments that failed and came back/.test(members), /\$20(\.00)?\s*1 payment paid after failing/.test(members)], [true, true]);
    if (process.env.E2E_SHOTS) await studio.screenshot({ path: join(process.env.E2E_SHOTS, "memberships.png"), fullPage: true });

    // A buyer's page (lib/buyer-profile.ts): opened from the latest buyers, read
    // from Stripe, with a note that stays; and the search, which carries the
    // address in a request's body and opens the page by a token.
    await open(studio, `${LOCAL}/studio/people`);
    is("the buyers page lists the latest buyer", (await studio.getByRole("link", { name: "buyer@example.com" }).count()) > 0, true);
    await Promise.all([studio.waitForURL(/\/studio\/people\?.*sale=cs_/, { timeout: 30_000 }), studio.getByRole("link", { name: "buyer@example.com" }).first().click()]);
    const buyer = await studio.locator("main").innerText();
    is("their page: who, what they bought, and no address in its link", [
      /buyer@example\.com/.test(buyer),
      /What they bought and paid/.test(buyer),
      /Meal Planner/.test(buyer),
      /spent with you/i.test(buyer),
      studio.url().includes("example.com"),
    ], [true, true, true, true, false]);
    await studio.getByLabel("Add a note").fill("Asked about the family plan.");
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/person") && r.ok(), { timeout: 30_000 }),
      studio.getByRole("button", { name: "Save note" }).click(),
    ]);
    await studio.reload();
    is("a note stays on their page", await studio.getByText("Asked about the family plan.").count(), 1);
    buyerPath = new URL(studio.url()).pathname + new URL(studio.url()).search;
    if (process.env.E2E_SHOTS) await studio.screenshot({ path: join(process.env.E2E_SHOTS, "buyer.png"), fullPage: true });
    await open(studio, `${LOCAL}/studio/people`);
    await studio.getByLabel("A buyer's email address").fill("buyer@example.com");
    await Promise.all([studio.waitForURL(/\/studio\/people\?.*p=[0-9a-f]{48}/, { timeout: 30_000 }), studio.getByRole("button", { name: "Open their page" }).click()]);
    is("the search opens the same page, by a token", [await studio.getByText("Asked about the family plan.").count(), studio.url().includes("example.com")], [1, false]);
    // Back where the next part expects the studio to be.
    await open(studio, `${LOCAL}/studio`);
  }

  await keepSmall();
  part("Boxes at checkout, set up in the studio");
  await studio.locator("button[aria-expanded]", { hasText: "Weeknight Dinners" }).first().click();
  is("the two boxes, each on its own line", [await studio.getByText("Offers Pantry Checklist for $5 at checkout").isVisible(), await studio.getByText("Offers Sunday Baking for $15 at checkout").isVisible()], [true, true]);
  await studio.getByRole("button", { name: "Offer one more at checkout (3 of 3)" }).click();
  const third = studio.locator("form", { has: studio.getByRole("button", { name: "Save the offer" }) });
  is("a product already in a box is not offered again", await third.locator("select option").evaluateAll((all) => all.map((o) => o.textContent)).then((names) => names.some((n) => n.startsWith("Pantry Checklist") || n.startsWith("Sunday Baking"))), false);
  await third.locator("select").selectOption({ label: "Meal Planner ($27)" });
  await third.locator('input[inputmode="decimal"]').fill("10");
  await third.getByRole("button", { name: "Save the offer" }).click();
  await studio.getByText("Offers Meal Planner for $10 at checkout").waitFor({ timeout: 30_000 });
  is("a third saved, and no room for a fourth", await studio.getByRole("button", { name: /Offer one more at checkout/ }).count(), 0);
  await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
  const three = page.locator('#buy input[name="bump"]');
  for (let i = 0; i < 3; i += 1) await three.nth(i).check();
  is("on the product's page, three boxes, and the total of all four", [await three.count(), await words(page.locator('#buy form:has(input[name="bump"]) button[type=submit]'))], [3, "Buy all four for $49"]);

  await keepSmall();
  part("Selling from the creator's own website");
  const tool = studio.locator("#buy-button");
  await tool.locator("select").first().selectOption({ label: "Pantry Checklist" });
  await tool.locator('input[maxlength="30"]').fill("blog");
  const cardCode = await tool.locator("textarea").inputValue();
  is("the studio gives the code for a card, tagged with the place", /^<iframe src="https:\/\/marktmorgen\.com\/embed\/localshop\/[^"?]+\?utm_source=blog&amp;utm_medium=buy-button"/.test(cardCode), true);
  is("and shows the card as it will look", await words(tool.frameLocator("iframe").locator("h1")), "Pantry Checklist");
  const asked = async (title) => {
    await tool.locator("select").first().selectOption({ label: title });
    await tool.frameLocator("iframe").locator("h1", { hasText: title }).waitFor();
    await studio.waitForTimeout(300);
    return (await tool.locator("textarea").inputValue()).match(/ height="(\d+)"/)?.[1];
  };
  const withPicture = await asked("Knife Skills");
  if (process.env.E2E_SHOTS) await tool.locator("iframe").screenshot({ path: join(process.env.E2E_SHOTS, "card-picture.png") });
  is("at the height the card asks for: taller with a picture across the top", [withPicture, await asked("Pantry Checklist")], ["420", "260"]);
  const cardAddress = `${LOCAL}/embed/localshop/${ids["Pantry Checklist"]}`;
  const framing = async (url) => {
    const response = await fetch(url);
    return [response.headers.get("x-frame-options"), (response.headers.get("content-security-policy") ?? "").match(/frame-ancestors [^;]+/)?.[0] ?? ""];
  };
  is("the card may be framed by any site", await framing(cardAddress), [null, "frame-ancestors *"]);
  is("the product's own page still only by this one", await framing(`${LOCAL}/@localshop/p/${ids["Pantry Checklist"]}`), ["SAMEORIGIN", "frame-ancestors 'self'"]);

  // The creator's blog: another address, holding the code exactly as copied.
  const site = await context.newPage();
  site.on("pageerror", (error) => errors.push(String(error)));
  watchPolicy(site);
  await open(site, `${FAKE}/site?code=${encodeURIComponent(local(cardCode))}`);
  const framed = site.frameLocator("iframe");
  is("there, the card shows the product, its price and its button", [await words(framed.locator("h1")), await words(framed.locator(".st-price")), await words(framed.locator("a.btn"))], ["Pantry Checklist", "$9", "Buy for $9"]);
  // Read the same way as the refused frame below, so that check can fail.
  const readsCard = (frame) => frame?.evaluate(() => document.body?.innerText.includes("Pantry Checklist")).catch(() => false);
  is("the browser drew it inside the blog's page", await readsCard(site.frames().find((frame) => frame !== site.mainFrame())), true);
  if (process.env.E2E_SHOTS) {
    await site.screenshot({ path: join(process.env.E2E_SHOTS, "site-card.png"), fullPage: true });
    await tool.screenshot({ path: join(process.env.E2E_SHOTS, "studio-card.png") });
  }
  // Something handed over digitally is paid for from its buy box, where the box to start access at once is (lib/digital-consent.ts).
  const [tab] = await Promise.all([context.waitForEvent("page"), framed.locator("a.btn").click()]);
  // Whatever the frame's height, the summary shows whole lines only and the
  // button is inside the frame.
  const knife = ids["Knife Skills"];
  const frames = [260, 420, 300, 520].map((height) => `<iframe src="${LOCAL}/embed/localshop/${knife}" style="width:400px;height:${height}px;border:0"></iframe>`);
  const fits = await context.newPage();
  await open(fits, `${FAKE}/site?code=${encodeURIComponent(frames.join(""))}`);
  const shapes = [];
  for (const frame of fits.frames().filter((one) => one !== fits.mainFrame())) {
    await frame.locator(".em-sum").waitFor();
    shapes.push(
      await frame.evaluate(() => {
        const summary = document.querySelector(".em-sum");
        const button = document.querySelector("a.btn, button[type=submit]");
        const line = parseFloat(getComputedStyle(summary).lineHeight);
        const shown = summary.getBoundingClientRect().height;
        return {
          wholeLines: Math.abs(shown / line - Math.round(shown / line)) < 0.05 && Math.round(shown / line) >= 1,
          notCut: summary.getBoundingClientRect().bottom <= summary.parentElement.getBoundingClientRect().bottom + 0.5,
          buttonInside: button.getBoundingClientRect().bottom <= window.innerHeight,
        };
      }),
    );
  }
  if (process.env.E2E_SHOTS) await fits.screenshot({ path: join(process.env.E2E_SHOTS, "card-heights.png"), fullPage: true });
  await fits.close();
  is("in a frame of any height, the summary keeps whole lines and the button stays in view", shapes, Array(4).fill({ wholeLines: true, notCut: true, buttonInside: true }));
  tab.on("pageerror", (error) => errors.push(String(error)));
  watchPolicy(tab);
  await tab.waitForLoadState("networkidle");
  // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
  for (const label of await tab.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
  await Promise.all([tab.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), tab.locator("#buy form[data-checkout] button[type=submit]").first().click()]);
  is("the button opens the product's buy box in a new tab, paid there with the box checked, and the blog stays as it was", [site.url().startsWith(FAKE), /\/@localshop\/thanks\?session_id=/.test(tab.url())], [true, true]);
  const sale = services.checkouts().at(-1);
  is("for that product at its price, and the sale names the place", [sale.metadata.product, sale.amount_total, sale.metadata.utm_source, sale.metadata.utm_medium], [ids["Pantry Checklist"], 900, "blog", "buy-button"]);
  await tab.close();

  await open(site, `${FAKE}/site?code=${encodeURIComponent(`<iframe src="${LOCAL}/@localshop/p/${ids["Pantry Checklist"]}" width="400" height="300"></iframe>`)}`);
  const refused = site.frames().find((frame) => frame !== site.mainFrame());
  is("while the product's own page, framed there, is refused by the browser", [Boolean(refused), await readsCard(refused)], [true, false]);

  await tool.locator('input[value="button"]').check();
  await tool.locator('input[maxlength="60"]').fill("Get the checklist");
  const button = await tool.locator("textarea").inputValue();
  await open(site, `${FAKE}/site?code=${encodeURIComponent(local(button))}`);
  is("the plain button says what was typed", await words(site.locator("body a")), "Get the checklist");
  if (process.env.E2E_SHOTS) await site.screenshot({ path: join(process.env.E2E_SHOTS, "site-button.png") });
  await Promise.all([site.waitForURL(/\/@localshop\/p\//, { timeout: 120_000 }), site.locator("body a").click()]);
  is("and leads to the product's page, tagged with the place", [new URL(site.url()).searchParams.get("utm_source"), await words(site.locator("main h1").first())], ["blog", "Pantry Checklist"]);
  await site.close();

  await keepSmall();
  part("Fair prices by country, switched on by the creator");
  const fairCard = studio.locator("#fair-prices");
  const asBuyerFrom = async (country) => {
    const visit = await browser.newContext({ viewport: { width: 430, height: 900 }, extraHTTPHeaders: { "x-vercel-ip-country": country } });
    const there = await visit.newPage();
    there.on("pageerror", (error) => errors.push(String(error)));
    watchPolicy(there);
    await open(there, `${LOCAL}/@localshop/p/${ids["Pantry Checklist"]}`);
    return { visit, there };
  };
  {
    const { visit, there } = await asBuyerFrom("IN");
    is("off until switched on: a buyer in India sees the normal price", await words(there.locator("main .st-price").first()), "$9");
    await visit.close();
  }
  await fairCard.getByLabel("Show fair prices on my store").check();
  await fairCard.getByLabel("Add a country").selectOption({ label: "Brazil" });
  await fairCard.getByLabel("Level for Brazil").selectOption({ label: "20% off" });
  await fairCard.getByRole("button", { name: "Save" }).click();
  await studio.getByRole("status").getByText("Saved. Fair prices are on.").waitFor({ timeout: 30_000 });
  for (const [country, price, note] of [["IN", "Was $9 now $4.50", "A fair price for India: 50% off"], ["BR", "Was $9 now $7.20", "A fair price for Brazil: 20% off"], ["US", "$9", ""]]) {
    const { visit, there } = await asBuyerFrom(country);
    const shown = [await words(there.locator("main .st-price").first()), (await words(there.locator("#buy"))).includes(note || "A fair price")];
    is(`a buyer in ${country} sees ${note ? "the fair price, and why" : "the normal price"}`, shown, [price, Boolean(note)]);
    if (country === "IN") {
      if (process.env.E2E_SHOTS) {
        await there.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "fair-india.png") });
        await fairCard.screenshot({ path: join(process.env.E2E_SHOTS, "fair-studio.png") });
      }
      // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
      for (const label of await there.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
      await Promise.all([there.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), there.locator('#buy form[action="/api/store/checkout"] button[type=submit]').first().click()]);
      const paid = services.checkouts().at(-1);
      is("and pays it: the creator's own coupon at the same percentage, written on the order", [paid.discount_coupon, paid.metadata.fair], ["mm_fair_50", "IN:50"]);
      is("made on their account once", services.coupons().map((c) => [c.id, c.percent_off]), [["mm_fair_50", "50"]]);
    }
    await visit.close();
  }

  await keepSmall();
  part("Fair prices only on the products the creator picks");
  const products = fairCard.getByRole("group", { name: "Which products" });
  await products.getByLabel("Only the ones I pick").check();
  await products.getByLabel("Meal Planner").check();
  // Waited on by the answer itself: the same words from the save before may still be on screen.
  await Promise.all([
    studio.waitForResponse((r) => r.url().endsWith("/api/store/fair") && r.request().method() === "POST" && r.ok(), { timeout: 30_000 }),
    fairCard.getByRole("button", { name: "Save" }).click(),
  ]);
  {
    const { visit, there } = await asBuyerFrom("IN");
    is("a product not picked: a buyer in India sees the normal price", await words(there.locator("main .st-price").first()), "$9");
    await visit.close();
  }
  await studio.reload();
  is("the choice is kept", [await products.getByLabel("Only the ones I pick").isChecked(), await products.getByLabel("Meal Planner").isChecked(), await products.getByLabel("Pantry Checklist").isChecked()], [true, true, false]);
  await products.getByLabel("Pantry Checklist").check();
  await Promise.all([
    studio.waitForResponse((r) => r.url().endsWith("/api/store/fair") && r.request().method() === "POST" && r.ok(), { timeout: 30_000 }),
    fairCard.getByRole("button", { name: "Save" }).click(),
  ]);
  {
    const { visit, there } = await asBuyerFrom("IN");
    is("picked: the fair price again", await words(there.locator("main .st-price").first()), "Was $9 now $4.50");
    if (process.env.E2E_SHOTS) await fairCard.screenshot({ path: join(process.env.E2E_SHOTS, "fair-products.png") });
    await visit.close();
  }

  await keepSmall();
  part("The store in Spanish");
  const setLanguage = (language) =>
    studio.evaluate(async (language) => {
      const response = await fetch("/api/store/language", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ language }) });
      return response.status;
    }, language);
  is("a language there is not is refused", await setLanguage("tlh"), 400);
  is("Spanish is taken", await setLanguage("es"), 200);
  {
    const { visit, there } = await asBuyerFrom("US");
    is("the page says it is Spanish", await there.locator(".st-page[lang]").first().getAttribute("lang"), "es-ES");
    const box = await words(there.locator("#buy"));
    is("the buy button is in Spanish, with the price written the Spanish way", box.includes("Comprar por 9\u00a0US$") || box.includes("Comprar por 9 US$"), true);
    is("and nothing in the box is left in English", /\b(Buy|Pay|Subscribe|Choose)\b/.test(box), false);
    if (process.env.E2E_SHOTS) await there.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "spanish-product.png") });
    await open(there, `${LOCAL}/@localshop`);
    const front = await words(there.locator("main"));
    is("the store page too", front.includes("Hecho con Marktmorgen") || front.includes("Comprar por"), true);
    if (process.env.E2E_SHOTS) await there.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "spanish-store.png") });
    await open(there, `${LOCAL}/@localshop/p/${ids["Pantry Checklist"]}`);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await there.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([there.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), there.locator('#buy form[action="/api/store/checkout"] button[type=submit]').first().click()]);
    is("Stripe's page is asked to speak Spanish", services.checkouts().at(-1).locale, "es");
    const thanks = await words(there.locator("main"));
    is("the page after paying is in Spanish", /Gracias|Pagado|Este pedido|Volver a/.test(thanks), true);
    is("with nothing on it left in English", /\b(Thank you|You bought|Back to|Download it|This order)\b/.test(thanks), false);
    if (process.env.E2E_SHOTS) await there.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "spanish-thanks.png") });
    await open(there, `${LOCAL}/@localshop/orders`);
    is("the list of purchases speaks Spanish", await there.locator(".st-page[lang]").first().getAttribute("lang"), "es-ES");
    await visit.close();
  }
  is("and back to English", await setLanguage("en"), 200);
  await open(studio, `${LOCAL}/studio`);
  is("the studio has the card that picks it", await studio.locator("select#store-language").count(), 1);
  is("showing the language the store speaks", await studio.locator("select#store-language").inputValue(), "en");

  await keepSmall();
  part("A sales page with the newer blocks");
  {
    const saved = await studio.evaluate(async (id) => {
      const blocks = [
        { id: "hero0001", kind: "hero", headline: "Cut faster, safely", sub: "Ten short lessons.", media: "picture", video: null, layout: "cover", button: true },
        { id: "fact0001", kind: "facts", heading: "By the numbers", show: ["lessons", "buyers", "rating"] },
        { id: "fit00001", kind: "fit", heading: "Is it for you?", yesLabel: "", noLabel: "", yes: ["You cook every day", "You fear the knife"], no: ["You are a trained chef"] },
        { id: "step0001", kind: "steps", heading: "How it works", items: [{ title: "Pay", detail: "" }, { title: "Watch a lesson a day", detail: "Ten minutes each." }, { title: "Cook with confidence", detail: "" }] },
        { id: "comp0001", kind: "compare", heading: "Why a course", columnA: "Knife Skills", columnB: "", rows: [{ label: "Feedback on your grip", a: "\u2713", b: "\u2717" }, { label: "Time it takes", a: "Ten days", b: "Years" }] },
        { id: "bonu0001", kind: "bonuses", heading: "Also included", items: [{ title: "A sharpening chart", detail: "One page to keep by the board." }] },
        { id: "feat0001", kind: "feature", heading: "Why it works", body: "Short lessons you can follow at the board.", picture: null, side: "right", screens: "phone" },
        { id: "comp0002", kind: "compare", heading: "Side by side", columnA: "Knife Skills", columnB: "A video online", rows: [{ label: "A plan to follow", a: "\u2713", b: "\u2717" }], screens: "computer" },
        { id: "cta00001", kind: "cta", label: "", note: "" },
      ];
      const response = await fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: { blocks, seoTitle: "", seoDescription: "", next: null, test: null, style: "bands" } }) });
      return (await response.json()).ok === true;
    }, ids["Knife Skills"]);
    is("saved from the studio", saved, true);
    await open(page, `${LOCAL}/@localshop/p/${ids["Knife Skills"]}`);
    const main = await words(page.locator("main"));
    const hero = page.locator("header.sp-hero");
    is("the product's picture behind the words, with a button under them", [
      await hero.evaluate((el) => el.classList.contains("sp-hero-cover")),
      await hero.locator("h1").innerText(),
      await hero.locator("img.sp-hero-cover-img").count(),
      // Leads to the buy box, where the box to start access at once is (lib/digital-consent.ts).
      await hero.locator('a[href="#buy"]').count(),
      await hero.locator("h1").evaluate((el) => getComputedStyle(el).color),
    ], [true, "Cut faster, safely", 1, 1, "rgb(255, 255, 255)"]);
    is("who it is for, with the heading written for the creator", [main.includes("This is for you if"), main.includes("You fear the knife"), main.includes("This is not for you if")], [true, true, true]);
    is("the steps, numbered", await page.locator(".sp-step").count(), 3);
    is("the comparison, its other column named for the creator", [await page.locator('[data-block="comp0001"] .sp-compare tbody tr').count(), main.includes("Another way")], [2, true]);
    is("checks and crosses spoken as yes and no", [await page.locator('[data-block="comp0001"] .sp-compare [role="img"][aria-label="Yes"]').count(), await page.locator('[data-block="comp0001"] .sp-compare [role="img"][aria-label="No"]').count()], [1, 1]);
    is("the bonus on its card, numbered", [await page.locator(".sp-bonus").count(), /bonus 1/i.test(main)], [1, true]);
    is("no number is shown that the store has not counted", await page.locator(".sp-facts").count(), 0);
    // Six sections show on a phone (the numbers block has none to show yet), so three bands.
    is("set in bands: every other section shown, from the first", [await page.locator(".sp-style-bands").count(), await page.locator(".sp-band-phone").count()], [1, 3]);
    is("a band is painted, not see-through", await page.locator(".sp-band-phone > .sp-section").first().evaluate((el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)"), true);
    is("words beside a picture, with no picture yet: the words alone", [await page.locator(".sp-feature").count(), await page.locator(".sp-feature-picture").count(), main.includes("Short lessons you can follow at the board.")], [1, 0, true]);
    // This browser is phone-wide; the same page is then read at a computer's width.
    is("on a phone: the block kept to phones shows, the wide table does not", [await page.locator(".sp-only-phone").isVisible(), await page.locator(".sp-only-computer").isVisible()], [true, false]);
    if (process.env.E2E_SHOTS) await page.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "new-blocks.png") });
    const narrow = page.viewportSize();
    await page.setViewportSize({ width: 1200, height: 900 });
    is("on a computer: the other way round", [await page.locator(".sp-only-phone").isVisible(), await page.locator(".sp-only-computer").isVisible()], [false, true]);
    // Six sections on each screen: the bands alternate on what each one shows.
    is("bands counted apart for each screen, each painted on its own", [
      await page.locator(".sp-band-phone").count(),
      await page.locator(".sp-band-computer").count(),
      await page.locator(".sp-band-computer > .sp-section").last().evaluate((el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)"),
    ], [3, 3, true]);
    if (process.env.E2E_SHOTS) await page.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "new-blocks-wide.png") });
    await page.setViewportSize(narrow);
  }

  await keepSmall();
  part("The page coach in the studio");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    const title = studio.locator("#coach-title");
    const said = await words(title);
    const score = Number(said.match(/(\d+) out of 100/)?.[1] ?? -1);
    is("a score out of 100, for the page as it stands", score > 0 && score < 100, true);
    await studio.getByRole("button", { name: "See what to improve" }).click();
    const before = await studio.locator("ol > li").count();
    await studio.getByRole("button", { name: "Add benefits" }).click();
    is("a missing part is added with one press", await studio.locator("ol > li").count(), before + 1);
    if (process.env.E2E_SHOTS) await studio.locator("#coach-title").locator("xpath=ancestor::section[1]").screenshot({ path: join(process.env.E2E_SHOTS, "page-coach.png") });
  }

  await keepSmall();
  part("The page's style, chosen in the studio");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    const picker = studio.getByRole("group", { name: "Page style" });
    is("the saved style is the one pressed", await picker.getByRole("button", { name: /^Bands/ }).getAttribute("aria-pressed"), "true");
    await studio.getByRole("button", { name: "Preview", exact: true }).click();
    await studio.getByRole("group", { name: "Page style" }).getByRole("button", { name: "Cards", exact: true }).click();
    is("the preview redraws in cards, before anything is saved", [await studio.locator(".sp-style-cards").count(), await studio.locator("[class*='sp-band-']").count()], [1, 0]);
    is("and the change waits to be saved", await studio.getByRole("button", { name: "Save the page" }).isEnabled(), true);
    await studio.getByRole("button", { name: "Save the page" }).click();
    await studio.getByText("Page saved.").first().waitFor({ timeout: 15_000 });
    await studio.getByRole("button", { name: "Build", exact: true }).click();
    const before = await studio.locator("ol > li").count();
    await studio.getByRole("button", { name: /^Duplicate block 2,/ }).click();
    is("a block is copied right under itself", await studio.locator("ol > li").count(), before + 1);
    await studio.getByText("Earlier versions").click();
    const load = studio.getByRole("button", { name: /^Load the version from / }).first();
    await load.waitFor({ timeout: 15_000 });
    await load.click();
    await studio.getByText(/^Loaded the version from /).first().waitFor({ timeout: 15_000 });
    is("the page as it was before the save comes back, in bands, waiting to be saved", [
      await studio.getByRole("group", { name: "Page style" }).getByRole("button", { name: /^Bands/ }).getAttribute("aria-pressed"),
      await studio.locator("ol > li").count(),
      await studio.getByRole("button", { name: "Save the page" }).isEnabled(),
    ], ["true", before, true]);
  }

  await keepSmall();
  part("A product's address in words");
  {
    await open(page, `${LOCAL}/@localshop`);
    const href = await page.locator(`a[href*="/p/knife-skills-${ids["Knife Skills"]}"]`).first().getAttribute("href");
    is("the store links each product by its title's words and id", href, `/@localshop/p/knife-skills-${ids["Knife Skills"]}`);
    const response = await page.goto(`${LOCAL}${href}`, { waitUntil: "networkidle" });
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    is("that address opens the page, and names itself as the one to keep", [response.status(), canonical.endsWith(`/@localshop/p/knife-skills-${ids["Knife Skills"]}`)], [200, true]);
    const old = await page.goto(`${LOCAL}/@localshop/p/${ids["Knife Skills"]}`, { waitUntil: "networkidle" });
    is("an address shared before still opens the page, pointing search engines to the new one", [old.status(), (await page.locator('link[rel="canonical"]').getAttribute("href")).endsWith(`/p/knife-skills-${ids["Knife Skills"]}`)], [200, true]);
    const renamed = await page.goto(`${LOCAL}/@localshop/p/knife-basics-${ids["Knife Skills"]}`, { waitUntil: "networkidle" });
    is("and so does one with the words of an older title", [renamed.status(), (await words(page.locator("h1"))).length > 0], [200, true]);
  }

  await keepSmall();
  part("Sharing a page and the store");
  {
    // The step "Test a second headline" leads to (lib/insights.ts): the page's editor with the test switched on.
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}&test=headline`);
    const test = studio.locator("#headline-test");
    await test.waitFor({ timeout: 30_000 }).catch(() => {});
    const seen = (await test.count()) ? await test.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; }) : false;
    is("a headline test opens ready to write, in sight", [await test.count(), (await test.count()) ? await test.locator("input[type=checkbox]").first().isChecked() : false, seen], [1, true, true]);
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    await studio.getByRole("button", { name: "Share", exact: true }).click();
    const panel = studio.getByRole("region", { name: "Share Knife Skills" });
    const link = await panel.locator("#share-url").inputValue();
    is("the page's address in words, to copy", link.endsWith(`/@localshop/p/knife-skills-${ids["Knife Skills"]}`), true);
    const x = await panel.getByRole("link", { name: "X", exact: true }).getAttribute("href");
    is("a post opens the network's own page, tagged with where it went", x.startsWith("https://x.com/intent/post") && decodeURIComponent(x).includes("utm_source=x&utm_medium=share"), true);
    is("a QR code drawn", await panel.getByRole("img", { name: "QR code that opens Knife Skills" }).count(), 1);
    const [svg] = await Promise.all([studio.waitForEvent("download"), panel.getByRole("button", { name: "SVG" }).click()]);
    const [png] = await Promise.all([studio.waitForEvent("download"), panel.getByRole("button", { name: "PNG" }).click()]);
    is("and downloaded for print and for slides", [svg.suggestedFilename(), png.suggestedFilename()], ["knife-skills-qr.svg", "knife-skills-qr.png"]);
    await panel.getByRole("button", { name: "Write three posts" }).click();
    await panel.locator("#post-x").waitFor({ timeout: 30_000 });
    is("posts written with AI, each with the link tagged for where it goes", [
      (await panel.locator("#post-x").inputValue()).endsWith(`/@localshop/p/knife-skills-${ids["Knife Skills"]}?utm_source=x&utm_medium=share`),
      (await panel.locator("#post-linkedin").inputValue()).includes("utm_source=linkedin"),
      (await panel.locator("#post-instagram").inputValue()).includes("http"),
    ], [true, true, false]);
    if (process.env.E2E_SHOTS) await panel.screenshot({ path: join(process.env.E2E_SHOTS, "share-panel.png") });
    await open(studio, `${LOCAL}/studio`);
    await studio.getByText("Share the store: link, QR code, posts").click();
    is("the store's own address, to share the same way", (await studio.locator("#share-url").inputValue()).endsWith("/@localshop"), true);
    await studio.getByRole("button", { name: "Write three posts" }).click();
    await studio.locator("#post-x").waitFor({ timeout: 30_000 });
    is("and posts about the whole store, with its address tagged", (await studio.locator("#post-x").inputValue()).endsWith("/@localshop?utm_source=x&utm_medium=share"), true);
  }

  await keepSmall();
  part("Blocks added where they go, from a gallery");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    const blocks = studio.locator("ol > li");
    const before = await blocks.count();
    await studio.getByRole("button", { name: "Add a block after block 2", exact: true }).click();
    const gallery = studio.getByRole("region", { name: "Add a block after block 2", exact: true });
    is("a gallery opens there, with a box to find one", [await gallery.count(), await gallery.getByRole("searchbox").evaluate((el) => el === document.activeElement)], [1, true]);
    await gallery.getByRole("searchbox").fill("questions");
    is("finding narrows it", await gallery.getByRole("button", { name: /^Questions/ }).count(), 1);
    await gallery.getByRole("button", { name: /^Questions/ }).click();
    is("the block goes third, open to fill in", [await blocks.count(), (await words(blocks.nth(2))).startsWith("3. Questions"), await studio.locator("#block-find").count()], [before + 1, true, 0]);
    await studio.getByRole("group", { name: "Shows on" }).getByRole("button", { name: "Phones only" }).click();
    is("a block can be kept to phones, and its row says so", (await words(blocks.nth(2))).includes("Phones only · "), true);
    // A pause, so adding the next block is a step of its own for Undo.
    await studio.waitForTimeout(700);
    await studio.getByRole("button", { name: /^Add a block \(/ }).click();
    await studio.getByRole("region", { name: "Add a block at the end" }).getByRole("button", { name: /^Button/ }).click();
    is("and one at the end goes last", (await words(blocks.last())).includes(`${before + 2}. Button`), true);
    await studio.waitForTimeout(700);
    await studio.getByRole("button", { name: "Undo the last change" }).click();
    is("Undo takes the last change back, and only it", await blocks.count(), before + 1);
    await studio.getByRole("button", { name: "Redo" }).click();
    is("Redo puts it back", await blocks.count(), before + 2);
    await studio.locator("body").press("Control+z");
    is("and so do the keys: Ctrl+Z", await blocks.count(), before + 1);
    await studio.locator("body").press("Control+Shift+z");
    is("and Ctrl+Shift+Z", await blocks.count(), before + 2);
    // Unsaved: a link elsewhere in the studio asks first, and staying keeps everything.
    let asked = "";
    studio.once("dialog", (dialog) => {
      asked = dialog.message();
      void dialog.dismiss();
    });
    await studio.getByRole("navigation", { name: "Products" }).getByRole("link", { name: /Sunday Baking/ }).click();
    await studio.waitForTimeout(300);
    is("leaving unsaved changes is asked about, and staying keeps them", [asked.startsWith("You have changes that are not saved"), studio.url().includes(`product=${ids["Knife Skills"]}`), await blocks.count()], [true, true, before + 2]);
    if (process.env.E2E_SHOTS) {
      await studio.locator("ol").first().screenshot({ path: join(process.env.E2E_SHOTS, "block-list.png") });
      await studio.getByRole("button", { name: "Add a block after block 1", exact: true }).click();
      await studio.getByRole("region", { name: "Add a block after block 1", exact: true }).screenshot({ path: join(process.env.E2E_SHOTS, "block-gallery.png") });
    }
  }

  await keepSmall();
  part("A page kept from visitors while it is worked on");
  {
    const save = (hidden, showFrom = 0) => studio.evaluate(async ([id, hidden, showFrom]) => {
      const blocks = [{ id: "hero0009", kind: "hero", headline: "Dinner in thirty minutes, every night", sub: "", media: "none", video: null }];
      const response = await fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: { blocks, seoTitle: "", seoDescription: "", next: null, test: null, style: "plain", hidden, showFrom } }) });
      return (await response.json()).ok === true;
    }, [ids["Weeknight Dinners"], hidden, showFrom]);
    is("saved, kept from visitors", await save(true), true);
    await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
    is("visitors see the product's plain page meanwhile", await words(page.locator("h1")), "Weeknight Dinners");
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Weeknight Dinners"]}`);
    is("the studio says so, and the switch is off, with a moment to show it offered", [
      await studio.getByText("Hidden", { exact: true }).count() > 0,
      await studio.getByRole("checkbox", { name: /^Visitors see this page/ }).isChecked(),
      await studio.getByLabel("Show it by itself at (optional)").count(),
    ], [true, false, 1]);
    const now = Math.floor(Date.now() / 1000);
    await save(true, now + 3600);
    await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
    is("set to show in an hour: still the plain page", await words(page.locator("h1")), "Weeknight Dinners");
    await save(true, now - 60);
    await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
    is("its moment come: shown, with nobody switching it on", await words(page.locator("h1")), "Dinner in thirty minutes, every night");
    is("shown once switched on and saved", await save(false), true);
    await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
    is("and then it is the product's page", await words(page.locator("h1")), "Dinner in thirty minutes, every night");
    // Put back as it was, a plain page, for what follows.
    await studio.evaluate(async (id) => fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: null }) }), ids["Weeknight Dinners"]);
  }

  await keepSmall();
  part("A second version of the whole page, tested against the first");
  {
    const product = ids["Weeknight Dinners"];
    const first = "Dinner in thirty minutes, every night";
    const second = "Forty dinners, one shopping list";
    await studio.evaluate(async ([id, headline]) => {
      const blocks = [
        { id: "hero0021", kind: "hero", headline, sub: "", media: "none", video: null },
        { id: "text0021", kind: "text", heading: "What it is", body: "Forty weeknight dinners." },
      ];
      await fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: { blocks, seoTitle: "", seoDescription: "", next: null, test: null, style: "plain" } }) });
    }, [product, first]);
    await open(studio, `${LOCAL}/studio/pages?product=${product}`);
    await studio.getByRole("button", { name: "Make version B" }).click();
    is("version B starts as a copy, and is the one being edited", [
      await studio.getByRole("button", { name: "Version B", exact: true }).getAttribute("aria-pressed"),
      await studio.getByText(/^You are editing version B/).count(),
      await studio.locator("ol > li").count(),
    ], ["true", 1, 2]);
    await studio.getByRole("button", { name: /^1\. Hero/ }).click();
    await studio.getByLabel("Headline", { exact: true }).fill(second);
    await studio.getByRole("button", { name: /^2\. Text/ }).click();
    await studio.getByRole("button", { name: /^Remove block 2/ }).click();
    await studio.getByRole("button", { name: "Version A", exact: true }).click();
    is("version A waits as it was", [await studio.locator("ol > li").count(), await studio.getByText(/^You are editing version A/).count()], [2, 1]);
    is("and only one test runs at a time: no second headline beside it", await studio.getByRole("button", { name: /^1\. Hero/ }).click().then(() => studio.getByRole("checkbox", { name: /^Test a second headline/ }).isDisabled()), true);
    await studio.getByRole("button", { name: "Save the page" }).click();
    await studio.getByText(/^Page saved/).first().waitFor({ timeout: 30_000 });
    // A product sold for money: each version is read by the money it brings (lib/headline-test-rules.ts).
    await studio.getByText("Version A: seen 0 times, 0 sales paid, $0 in all, $0 per visitor.").waitFor({ timeout: 30_000 });
    is("saved, with nothing counted yet", await studio.getByText("Version B: seen 0 times, 0 sales paid, $0 in all, $0 per visitor.").count(), 1);

    // Visitors, each kept in a group by the cookie the store's pages set.
    const seen = {};
    for (let group = 0; group < 40 && !(seen.a && seen.b); group += 1) {
      await page.context().addCookies([{ name: "nl_ab", value: String(group), url: LOCAL }]);
      await open(page, `${LOCAL}/@localshop/p/${product}`);
      const headline = await words(page.locator("h1"));
      const version = headline === second ? "b" : headline === first ? "a" : "?";
      seen[version] ??= { group, blocks: await page.locator("[data-block]").count() };
    }
    is("half the visitors read version A, half version B, each as it was made", [seen.a?.blocks, seen.b?.blocks, seen["?"]], [2, 1, undefined]);
    await page.context().addCookies([{ name: "nl_ab", value: String(seen.b.group), url: LOCAL }]);
    await open(page, `${LOCAL}/@localshop/p/${product}`);
    is("and a visitor keeps reading the same one", await words(page.locator("h1")), second);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#buy form[data-checkout] button[type=submit]").first().click()]);
    const counts = async () => {
      for (let i = 0; i < 20; i += 1) {
        const data = await studio.evaluate((id) => fetch(`/api/store/ab?id=${id}`).then((r) => r.json()), product);
        if (data.counts?.cb >= 1) return data.counts;
        await studio.waitForTimeout(250);
      }
      return null;
    };
    const counted = await counts();
    is("each view is counted for its version, and the checkout for B", [counted?.va >= 1, counted?.vb >= 2, counted?.ca, counted?.cb], [true, true, 0, 1]);
    is("and the checkout carries the version to Stripe, so the paid sale counts for B", /^[a-z0-9]{4,12}:b$/.test(services.checkouts().at(-1)?.metadata?.ab ?? ""), true);
    is("how far down the page is read is not given while two pages are read", await studio.evaluate((id) => fetch(`/api/store/depth?id=${id}`).then((r) => r.json()).then((d) => d.visitors), product), 0);

    await open(studio, `${LOCAL}/studio/pages?product=${product}`);
    is("the studio shows each version's numbers", (await words(studio.locator("section", { hasText: "Test a second version of the whole page" }).last())).includes("Version B: seen"), true);
    if (process.env.E2E_SHOTS) await studio.locator("section", { hasText: "Test a second version of the whole page" }).last().screenshot({ path: join(process.env.E2E_SHOTS, "page-test.png") });
    await studio.getByRole("button", { name: "Keep version B, end the test" }).click();
    await studio.getByRole("button", { name: "Save the page" }).click();
    await studio.getByText(/^Page saved/).first().waitFor({ timeout: 30_000 });
    await page.context().addCookies([{ name: "nl_ab", value: String(seen.a.group), url: LOCAL }]);
    await open(page, `${LOCAL}/@localshop/p/${product}`);
    is("version B kept: it is the page for everybody, and the test is over", [await words(page.locator("h1")), await studio.evaluate((id) => fetch(`/api/store/ab?id=${id}`).then((r) => r.status), product)], [second, 404]);
    await studio.evaluate(async (id) => fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: null }) }), product);
  }

  part("Sales sent to the creator's ad platforms from the server");
  {
    // The platforms' own scripts cannot be fetched from here: each is answered with an empty one.
    await page.context().route(/^https:\/\/(connect\.facebook\.net|www\.googletagmanager\.com)\//, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
    await studio.evaluate(() => fetch("/api/store/pixels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pixels: { meta: "123456789012345", google: "AW-123456789" } }) }));
    await open(studio, `${LOCAL}/studio`);
    const server = studio.locator("#server-events");
    is("under the pixels, a token for each platform the store has", [
      await server.getByRole("heading", { name: "Send conversions from our server too" }).count(),
      await server.getByLabel("Meta access token").count(),
      (await words(server)).includes("Put your Google Analytics tag ID (it starts with G-)"),
    ], [1, 1, true]);
    await server.getByLabel("Meta access token").fill("EAAB" + "e".repeat(60));
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/ads-server") && r.ok(), { timeout: 30_000 }),
      server.getByRole("button", { name: "Save token" }).first().click(),
    ]);
    await server.getByText("On: a token is saved").waitFor({ timeout: 30_000 });
    is("saved, and never shown again", [await server.getByText("On: a token is saved").count(), await server.getByLabel("Meta access token").inputValue()], [1, ""]);

    // A visitor from an ad says yes on the store, and buys.
    const product = ids["Weeknight Dinners"];
    await open(page, `${LOCAL}/@localshop/p/${product}?fbclid=IwAR0e2etest`);
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.getByRole("button", { name: "Turn off ad measurement" }).waitFor();
    const yes = (await page.context().cookies()).find((c) => c.name === "nl_ads_localshop");
    is("the yes is kept where the server can read it, with the ad click", /^y&fbclid=IwAR0e2etest&at=\d+$/.test(yes?.value ?? ""), true);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#buy form[data-checkout] button[type=submit]").first().click()]);
    const bought = services.checkouts().at(-1);
    is("the checkout carries it to Stripe", /^[0-9a-f]{24}$/.test(bought.metadata?.ads ?? ""), true);
    const sent = async () => {
      for (let i = 0; i < 40; i += 1) {
        const found = services.adEvents().find((e) => e.host === "graph.facebook.com" && e.body.data?.[0]?.event_id === bought.id);
        if (found) return found;
        await page.waitForTimeout(250);
      }
      return null;
    };
    const meta = await sent();
    // The stand-in's buyer has paid this store earlier in this run, so is a returning customer.
    is("the purchase reaches Meta from the server, with the order's id, the click and a returning customer", [
      meta?.path,
      meta?.body.data[0].event_name,
      meta?.body.data[0].action_source,
      /^fb\.1\.\d+\.IwAR0e2etest$/.test(meta?.body.data[0].user_data.fbc ?? ""),
      meta?.body.data[0].custom_data.customer_type,
      meta?.query.access_token === "EAAB" + "e".repeat(60),
    ], ["/v25.0/123456789012345/events", "Purchase", "website", true, "returning", true]);
    is("once, and not to Google, whose tag here is an Ads one", services.adEvents().filter((e) => e.body.data?.[0]?.event_id === bought.id || JSON.stringify(e.body).includes(bought.id)).length, 1);
    await open(studio, `${LOCAL}/studio`);
    is("the studio shows Meta's answer", (await words(studio.locator("[data-server-last]"))).includes("Meta: Received"), true);

    // Saying no takes the yes away at once.
    await open(page, `${LOCAL}/@localshop`);
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Turn off ad measurement" }).click()]);
    await page.getByRole("button", { name: "Ad measurement settings" }).waitFor();
    is("turned off, the cookie is gone", (await page.context().cookies()).some((c) => c.name === "nl_ads_localshop"), false);

    // As it was, for the parts after this one.
    await studio.evaluate(() => fetch("/api/store/ads-server", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: "meta", token: "" }) }));
    await studio.evaluate(() => fetch("/api/store/pixels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pixels: {} }) }));
    await page.context().unroute(/^https:\/\/(connect\.facebook\.net|www\.googletagmanager\.com)\//);
  }

  await keepSmall();
  part("Things said elsewhere, each with a link to where");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Weeknight Dinners"]}`);
    await studio.getByRole("button", { name: "Use the Ebook, guide or templates template" }).click();
    await studio.getByRole("button", { name: /^Add a block \(/ }).click();
    await studio.getByRole("region", { name: "Add a block at the end" }).getByRole("button", { name: /^Said elsewhere/ }).click();
    await studio.getByRole("button", { name: "Add one (0 of 6)" }).click();
    await studio.getByLabel("Their words, as they said them").fill("Cooked three of these this week. The kids ate everything.");
    await studio.getByLabel("Who said it (optional)").fill("@maria");
    await studio.getByLabel("Where it was said").fill("not a link");
    is("an address that is not one is said at once", await studio.getByText("That is not a full https address of a public page.").count(), 1);
    await studio.getByLabel("Where it was said").fill("https://x.com/maria/status/123");
    await studio.getByRole("button", { name: "Save the page" }).click();
    await studio.getByText(/^Page saved/).first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop/p/${ids["Weeknight Dinners"]}`);
    const quote = page.locator(".sp-quote");
    is("on the page, their words with who said them", [(await words(quote)).includes("Cooked three of these this week."), (await words(quote)).includes("@maria")], [true, true]);
    is("and a link to the original a visitor can check", [await quote.getByRole("link", { name: /See it on x\.com/ }).getAttribute("href"), await quote.locator("blockquote").getAttribute("cite")], ["https://x.com/maria/status/123", "https://x.com/maria/status/123"]);
    if (process.env.E2E_SHOTS) await quote.screenshot({ path: join(process.env.E2E_SHOTS, "said-elsewhere.png") });
    await studio.evaluate(async (id) => fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: null }) }), ids["Weeknight Dinners"]);
  }

  await keepSmall();
  part("Pictures seen large, without leaving the page");
  {
    await open(page, `${LOCAL}/@localshop/p/${ids["Sunday Baking"]}`);
    const viewer = page.locator("dialog.pv-dialog");
    await page.getByRole("link", { name: "The rye loaf, sliced, full size" }).click();
    is("a click opens the picture on the page, with where it is among them", [await viewer.evaluate((d) => d.open), await words(viewer.locator(".pv-count")), (await words(viewer)).includes("Week one: rye")], [true, "1 of 3", true]);
    await page.keyboard.press("ArrowRight");
    is("the arrow keys go through them", [await words(viewer.locator(".pv-count")), await viewer.locator(".pv-image").getAttribute("alt")], ["2 of 3", "A lemon cake"]);
    await viewer.getByRole("button", { name: "Previous picture" }).click();
    await viewer.getByRole("button", { name: "Previous picture" }).click();
    is("and round, from the first back to the last", await words(viewer.locator(".pv-count")), "3 of 3");
    await page.keyboard.press("Escape");
    is("Escape closes it, back where the reader was", [await viewer.evaluate((d) => d.open), page.url().includes(`/p/${ids["Sunday Baking"]}`)], [false, true]);
    await page.getByRole("link", { name: "A lemon cake, full size" }).click();
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "picture-viewer.png") });
    await viewer.getByRole("button", { name: "Close" }).click();
    is("and so does Close", await viewer.evaluate((d) => d.open), false);
  }

  await keepSmall();
  part("Reviews picked to show first");
  {
    const saved = await studio.evaluate(async ([id, first, knife]) => {
      const blocks = [
        { id: "hero0002", kind: "hero", headline: "Bake on Sundays", sub: "", media: "none", video: null },
        { id: "revw0002", kind: "reviews", heading: "What bakers say", first: [first] },
        { id: "faq00002", kind: "faq", heading: "Questions", items: [{ q: "Do I need a stand mixer?", a: "No: every recipe is kneaded by hand." }] },
        { id: "prod0002", kind: "product", heading: "Goes well with it", product: knife, note: "Sharp knives make quicker bread." },
      ];
      const response = await fetch("/api/store/page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, page: { blocks, seoTitle: "", seoDescription: "", next: null, test: null, style: "plain" } }) });
      return (await response.json()).ok === true;
    }, [ids["Sunday Baking"], seededReviews[0], ids["Knife Skills"]]);
    is("saved with the oldest review picked", saved, true);
    await open(page, `${LOCAL}/@localshop/p/${ids["Sunday Baking"]}`);
    const items = page.locator(".rv-item");
    is("the picked one first, marked as picked, then the newest", [
      await items.count(),
      (await words(items.nth(0))).includes("The rye loaf alone was worth it."),
      (await words(items.nth(0))).includes("Picked by the creator"),
      (await words(items.nth(1))).includes("My Sunday mornings smell like bread now."),
      (await words(items.nth(1))).includes("Picked by the creator"),
    ], [3, true, true, true, false]);
    const card = page.locator("a.sp-product");
    if (process.env.E2E_SHOTS) await page.locator('[data-block="prod0002"]').screenshot({ path: join(process.env.E2E_SHOTS, "product-card.png") });
    is("another product as a card: today's name and price, linking to its own page", [await card.count(), (await card.getAttribute("href"))?.endsWith(`/p/knife-skills-${ids["Knife Skills"]}`), (await words(card)).includes("Knife Skills"), (await words(card)).includes("$49")], [1, true, true, true]);
    const marked = await page.locator('script[type="application/ld+json"]').evaluateAll((all) => all.map((el) => JSON.parse(el.textContent)["@type"]));
    const faq = await page.locator('script[type="application/ld+json"]').evaluateAll((all) => all.map((el) => JSON.parse(el.textContent)).find((d) => d["@type"] === "FAQPage"));
    is("search engines are told the product, where it sits, and its answered questions", [marked.includes("Product"), marked.includes("BreadcrumbList"), faq?.mainEntity?.[0]?.name], [true, true, "Do I need a stand mixer?"]);
    if (process.env.E2E_SHOTS) await page.locator("#reviews").screenshot({ path: join(process.env.E2E_SHOTS, "picked-reviews.png") });
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Sunday Baking"]}`);
    await studio.getByRole("button", { name: /^2\. Reviews/ }).click();
    const boxes = studio.getByRole("group", { name: /^Show first/ }).getByRole("checkbox");
    is("the studio offers each review, with the picked one checked", [await boxes.count(), await boxes.nth(0).isChecked()], [3, true]);
    await studio.getByRole("button", { name: /^4\. Another product/ }).click();
    is("and the card's product is chosen in a list of the store's others", await studio.locator("select[id$='-p']").inputValue(), ids["Knife Skills"]);
  }

  await keepSmall();
  part("On a wide screen, the page beside its blocks as they are edited");
  {
    const was = studio.viewportSize();
    await studio.setViewportSize({ width: 1440, height: 900 });
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    const beside = studio.getByRole("complementary", { name: "The page as visitors see it" });
    is("drawn beside the blocks", await beside.isVisible(), true);
    await studio.getByRole("button", { name: /^1\. Hero/ }).click();
    await studio.getByLabel("Headline", { exact: true }).fill("Sharper knives, faster dinners");
    is("and redrawn as the words are typed", await words(beside.locator("h1")), "Sharper knives, faster dinners");
    await beside.locator('[data-block="step0001"]').click();
    is("a press on a part of the page opens its block, outlined", [
      await studio.locator("#row-step0001 button[aria-expanded]").first().getAttribute("aria-expanded"),
      await beside.locator('[data-block="step0001"]').evaluate((el) => el.classList.contains("sp-editing")),
    ], ["true", true]);
    if (process.env.E2E_SHOTS) await studio.screenshot({ path: join(process.env.E2E_SHOTS, "side-by-side.png") });
    await studio.setViewportSize(was);
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    is("on a narrower one, drawn once, under Preview", await beside.count(), 0);
  }

  await keepSmall();
  part("A page started from a template, chosen by what it holds");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Meal Planner"]}`);
    const course = studio.getByRole("list", { name: "The blocks of the Course template, in order" });
    is("each template shows its blocks in order", [(await course.locator("li").count()) >= 4, (await words(course)).includes("Questions")], [true, true]);
    if (process.env.E2E_SHOTS) await course.locator("xpath=ancestor::ul[1]").screenshot({ path: join(process.env.E2E_SHOTS, "template-gallery.png") });
    await studio.getByRole("button", { name: "Use the Course template" }).click();
    const blocks = studio.locator("ol > li");
    is("one press lays it out, under the product's own headline", [(await blocks.count()) >= 5, (await words(blocks.first())).startsWith("1. Hero")], [true, true]);
  }

  await keepSmall();
  part("A page started from another product's page");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Pantry Checklist"]}`);
    await studio.locator("#page-copy").selectOption({ label: "Knife Skills" });
    await studio.getByRole("button", { name: "Copy its blocks" }).click();
    await studio.locator("#coach-title").waitFor({ timeout: 30_000 });
    is("its blocks are here, ready to change, and nothing saved yet", [await studio.locator("ol > li").count() >= 8, await studio.getByRole("button", { name: "Save the page" }).isEnabled()], [true, true]);
  }

  await keepSmall();
  part("A whole page translated with AI");
  {
    await open(studio, `${LOCAL}/studio/pages?product=${ids["Knife Skills"]}`);
    await studio.getByText("Translate the whole page with AI").click();
    is("says first how many of the month's jobs the page takes", /This page takes 1 of your writing job/.test(await words(studio.locator("details", { hasText: "Translate the whole page with AI" }))), true);
    await studio.getByLabel("Into").selectOption("es");
    await studio.getByRole("button", { name: "Translate", exact: true }).click();
    await studio.getByText(/^Translated into Spanish/).waitFor({ timeout: 30_000 });
    const asked = services.writing().filter((w) => String(w.system).startsWith("You translate the words"));
    is("asks once, in the language picked", [asked.length, String(asked[0]?.system).includes("into Spanish")], [1, true]);
    is("nothing saved until Save is pressed", await studio.getByRole("button", { name: "Save the page" }).isEnabled(), true);
    await studio.getByRole("button", { name: /^1\. Hero/ }).click();
    const headline = await studio.getByLabel("Headline", { exact: true }).inputValue();
    is("every word of them", headline.length > 0 && headline === headline.toUpperCase(), true);
    await studio.waitForTimeout(700);
    await studio.locator("#undo-step").click();
    const undone = await studio.getByLabel("Headline", { exact: true }).inputValue();
    is("and Undo puts them back", undone !== headline && undone !== undone.toUpperCase(), true);
  }

  await keepSmall();
  part("Each product's page views, in the studio's numbers");
  {
    await open(studio, `${LOCAL}/studio`);
    const table = studio.locator("table", { has: studio.locator('caption:text-is("What you sell, best first")') });
    is("a column for its page's views, beside its checkouts", await table.locator('th:text-is("Page views")').count(), 1);
    // The counting itself is held by tests/product-views.test.ts: this browser
    // calls itself headless, and a store's numbers leave out what robots open.
  }

  await keepSmall();
  part("A reminder asked for on a product's page");
  {
    const remind = (enabled) => studio.evaluate(async (enabled) => (await (await fetch("/api/store/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, address: "1 Harbor Road, Portland, ME 04101" }) })).json()).ok === true, enabled);
    is("with reminders switched on", await remind(true), true);
    await open(page, `${LOCAL}/@localshop/p/${ids["Meal Planner"]}`);
    const box = page.locator("#remind");
    await box.locator("summary").click();
    await box.getByLabel("Your email").fill("later@example.com");
    await box.getByLabel("When").selectOption("day");
    await Promise.all([page.waitForURL(/asked=asked/), box.getByRole("button", { name: "Remind me once" }).click()]);
    is("back on the product's page, saying when, with no address in its link", [
      (await words(page.locator("#remind"))).includes("with the link to Meal Planner, tomorrow."),
      page.url().includes("later%40example.com") || page.url().includes("later@example.com"),
    ], [true, false]);
    if (process.env.E2E_SHOTS) await page.locator("#remind").screenshot({ path: join(process.env.E2E_SHOTS, "remind-asked.png") });
    is("and off again, the page offers none", await remind(false).then(() => open(page, `${LOCAL}/@localshop/p/${ids["Meal Planner"]}`)).then(() => page.locator("#remind").count()), 0);
  }

  await keepSmall();
  part("A blog on the store's address");
  {
    await open(studio, `${LOCAL}/studio/blog`);
    await studio.getByRole("link", { name: "New post" }).first().click();
    await studio.locator("#post-title").waitFor();
    await studio.locator("#post-title").fill("Sharpen a knife in five minutes");
    await studio.locator("#post-body").fill("A dull knife slips; a sharp one does what you mean.\n\n## What you need\n- A whetstone\n- Water\n\nHold the blade at about 15 degrees.");
    await studio.locator("#post-product").selectOption({ label: "Knife Skills" });
    await studio.getByRole("button", { name: "Publish", exact: true }).click();
    await studio.getByText("Published on your blog.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    const link = page.getByRole("link", { name: /blog$/i });
    is("the store page links to its blog once a post is published", await link.count(), 1);
    await link.click();
    await page.waitForURL(/\/blog$/);
    is("the blog lists the post", (await words(page.locator("main"))).includes("Sharpen a knife in five minutes"), true);
    await page.getByRole("link", { name: /Sharpen a knife in five minutes/ }).click();
    await page.waitForURL(/\/blog\/sharpen-a-knife-in-five-minutes-[0-9a-f]{10}$/);
    postPath = new URL(page.url()).pathname;
    is("the post, with its heading, its list and the product it ends on", [
      await words(page.locator("h1")),
      await page.getByRole("heading", { name: "What you need" }).count(),
      await page.locator(".st-post li").count(),
      (await page.locator(".sp-product").getAttribute("href"))?.includes(`/p/knife-skills-${ids["Knife Skills"]}`),
    ], ["Sharpen a knife in five minutes", 1, 2, true]);
    const feed = await fetch(`${LOCAL}/@localshop/blog/feed.xml`);
    const xml = await feed.text();
    is("and a feed readers can follow", [feed.status, feed.headers.get("content-type")?.startsWith("application/rss+xml"), xml.includes("<title>Sharpen a knife in five minutes</title>")], [200, true, true]);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "blog-post.png"), fullPage: true });
  }

  await keepSmall();
  part("The creator's profiles elsewhere, under the store's name");
  {
    await open(studio, `${LOCAL}/studio`);
    const coach = studio.getByRole("region", { name: "Set up your store" });
    is("the studio coaches a store that is set up: a score, and what to do next, each with where", [
      await coach.count(),
      /\d+\/100/.test(await words(coach)),
      (await coach.getByRole("link", { name: "Do it" }).count()) > 0,
    ], [1, true, true]);
    await studio.getByRole("button", { name: "Add your profiles" }).click();
    const first = studio.locator('input[id^="social-"][id$="-value"]').first();
    await first.fill("@localshop.cooks");
    is("a handle says where it will go before saving", await studio.getByText("Opens instagram.com/localshop.cooks").count(), 1);
    await studio.getByRole("button", { name: "Add a profile" }).click();
    const second = studio.locator('input[id^="social-"][id$="-value"]').nth(1);
    await second.fill("https://www.youtube.com/@localshop");
    is("a pasted address picks its own network", await studio.locator('select[id^="social-"]').nth(1).inputValue(), "youtube");
    await studio.getByRole("button", { name: "Add a profile" }).click();
    const third = studio.locator('input[id^="social-"][id$="-value"]').nth(2);
    await third.fill("https://evil.example/");
    await studio.locator('select[id^="social-"]').nth(2).selectOption("instagram");
    is("an address off the network is marked, not linked", await third.getAttribute("aria-invalid"), "true");
    await studio.getByRole("button", { name: "Remove Instagram" }).nth(1).click();
    await studio.getByRole("button", { name: "Save profiles" }).click();
    await studio.getByText("Profiles saved. They show under your store's name.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    const row = page.getByRole("navigation", { name: "Elsewhere" });
    is("the store page shows them under its name, in order, opening the right profiles", [
      await row.getByRole("link").count(),
      await row.getByRole("link").nth(0).getAttribute("href"),
      await row.getByRole("link").nth(1).getAttribute("href"),
      await row.getByRole("link").nth(0).getAttribute("rel"),
      await row.getByRole("link").nth(0).getAttribute("aria-label"),
    ], [2, "https://www.instagram.com/localshop.cooks", "https://www.youtube.com/@localshop", "me noopener", `${await words(page.locator("h1").first())} on Instagram`]);
    const refused = await studio.evaluate(async () => {
      const response = await fetch("/api/store/socials", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ socials: [{ network: "x", url: "javascript:alert(1)" }] }) });
      return [response.status, (await response.json()).bad];
    });
    is("an address that is not one for its network is refused by name", refused, [400, [0]]);
    is("under the name, the store's stars from every product's reviews, and a way to share it", [
      await page.getByText("across every product").count(),
      await page.getByRole("button", { name: "Share this store" }).count(),
    ], [1, 1]);
    const quotes = page.getByRole("region", { name: "What buyers say" });
    is("and what buyers said, the newest with words, each about its product", [
      await quotes.locator("blockquote").count(),
      (await words(quotes.locator("blockquote").first())).includes("Sunday mornings smell like bread"),
      await quotes.getByRole("link", { name: "About Sunday Baking" }).count(),
    ], [3, true, 3]);
    if (process.env.E2E_SHOTS) await page.locator("section").first().screenshot({ path: join(process.env.E2E_SHOTS, "store-socials.png") });
  }

  await keepSmall();
  part("Links that stand out, play on the page, and come and go on time");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("button", { name: "Add a link" }).click();
    await studio.locator("#link-title").fill("Watch the trailer");
    await studio.locator("#link-url").fill("https://youtu.be/dQw4w9WgXcQ");
    await studio.getByRole("checkbox", { name: /Spotlight it/ }).check();
    await studio.getByRole("checkbox", { name: /Play it on your page/ }).check();
    await studio.getByRole("button", { name: "Add it" }).click();
    await studio.getByText("Link added.").first().waitFor({ timeout: 30_000 });
    await studio.getByRole("button", { name: "Add a link" }).click();
    await studio.locator("#link-title").fill("Launch week offer");
    await studio.locator("#link-url").fill("https://example.com/launch");
    await studio.locator("#link-from").fill("2099-01-01T09:00");
    await studio.getByRole("button", { name: "Add it" }).click();
    await studio.getByText("Shows from Jan 1, 9:00 AM").first().waitFor({ timeout: 30_000 });
    await studio.getByRole("button", { name: "Add a link" }).click();
    await studio.locator("#link-title").fill("Our kitchen playlist");
    await studio.locator("#link-url").fill("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M");
    await studio.getByRole("checkbox", { name: /Play it on your page/ }).check();
    await studio.getByRole("button", { name: "Add it" }).click();
    await studio.getByText("Plays on your page (Spotify)").first().waitFor({ timeout: 30_000 });
    await studio.getByRole("button", { name: "Add a heading" }).click();
    await studio.locator("#link-title").fill("Watch first");
    is("a heading asks for no address", await studio.locator("#link-url").count(), 0);
    await studio.getByRole("button", { name: "Add it" }).click();
    await studio.getByText("Link added.").first().waitFor({ timeout: 30_000 });
    const headingRow = studio.locator("li:not([data-mark])", { hasText: "Watch first" }).filter({ hasText: "Heading" });
    for (let n = 0; n < 2; n++) {
      await headingRow.getByRole("button", { name: "Move up" }).click();
      await studio.waitForTimeout(1500);
    }
    is("a link may have its own picture; a heading or a video played on the page has none", [
      await studio.locator("li:not([data-mark])", { hasText: "Launch week offer" }).getByRole("button", { name: "Add a picture" }).count(),
      await studio.locator("li:not([data-mark])", { hasText: "Watch the trailer" }).getByRole("button", { name: "Add a picture" }).count(),
      await headingRow.getByRole("button", { name: "Add a picture" }).count(),
    ], [1, 0, 0]);
    is("the studio says what each link does", [
      await studio.getByText("Spotlight", { exact: true }).count(),
      await studio.getByText("Plays on your page (YouTube)").count(),
    ], [1, 1]);
    await open(page, `${LOCAL}/@localshop`);
    const video = page.locator(".st-link-video");
    is("the video link plays on the store page, in the spotlight, and its own site is still a counted link", [
      await video.count(),
      await video.evaluate((el) => el.classList.contains("st-spotlight")),
      await video.getByRole("button", { name: /Play the video: Watch the trailer/ }).count(),
      await video.locator("a[data-link]").getAttribute("href"),
    ], [1, true, 1, "https://youtu.be/dQw4w9WgXcQ"]);
    const music = page.locator(".st-link-audio");
    is("music plays on the page too, loading nothing until pressed", [await music.count(), await music.locator("iframe").count(), await music.locator("a[data-link]").getAttribute("href")], [1, 0, "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"]);
    await music.getByRole("button", { name: /Play: Our kitchen playlist\. It loads from Spotify\./ }).click();
    is("pressed, Spotify's own player, built here, at its height", [await music.locator("iframe").getAttribute("src"), await music.locator("iframe").getAttribute("height")], ["https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M?autoplay=1", "352"]);
    is("a link scheduled for later is not on the page yet", await page.getByText("Launch week offer").count(), 0);
    is("the heading stands over the links after it", await page.getByRole("heading", { name: "Watch first" }).count(), 1);
    await video.getByRole("button", { name: /Play the video/ }).click();
    is("pressed, the player loads from YouTube's private address only", (await video.locator("iframe").getAttribute("src"))?.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), true);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "store-links.png"), fullPage: true });
  }

  await keepSmall();
  part("The creator chooses the order of the page");
  {
    await open(studio, `${LOCAL}/studio`);
    const order = studio.locator("section#order");
    for (let n = 0; n < 2; n++) await order.getByRole("button", { name: "Move Your links up" }).click();
    is("the list shows the new order before it is saved", (await words(order.locator("li").first())).includes("Your links"), true);
    await order.getByRole("button", { name: "Save the order" }).click();
    await studio.getByText("Saved. Your page shows its parts in this order.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("the store page draws the links first, then the products", await page.locator(".st-part").evaluateAll((parts) => parts.slice(0, 2).map((p) => p.getAttribute("data-part"))), ["links", "products"]);
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("section#order").getByRole("button", { name: "Back to the usual order" }).click();
    await studio.getByText("Your page is back in the usual order.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("and back in the usual order in one press", await page.locator(".st-part").first().getAttribute("data-part"), "products");
  }

  await keepSmall();
  part("An email sign-up box on the store page, confirmed by email");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("checkbox", { name: "Show the sign-up box on my store page" }).check();
    await studio.locator("#join-heading-field").fill("Sunday recipes");
    is("the studio previews it as buyers will see it", await studio.getByLabel("Preview").getByText("Sunday recipes").count(), 1);
    await studio.locator("form", { hasText: "Email sign-up box" }).getByRole("button", { name: "Save", exact: true }).click();
    await studio.getByText("The sign-up box is on your store page.").first().waitFor({ timeout: 30_000 });
    const person = await context.newPage();
    await open(person, `${LOCAL}/@localshop`);
    const box = person.getByRole("region", { name: "Sunday recipes" });
    is("the store page shows it, with the creator's heading", await box.count(), 1);
    await box.getByLabel("Your email").fill("reader@example.com");
    await Promise.all([person.waitForURL(/\/join\?status=sent/, { timeout: 60_000 }), box.getByRole("button", { name: "Join" }).click()]);
    is("then says to check the inbox, without the address in the link", [await words(person.locator("h1")), person.url().includes("reader")], ["Check your inbox", false]);
    const mail = services.emails().filter((email) => [].concat(email.to).includes("reader@example.com")).at(-1);
    is("the confirmation comes from the store", mail?.subject, "Confirm: emails from Harbor Kitchen Local");
    const link = mail?.text.match(/https?:\/\/\S+\/join\?token=[0-9a-f]{48}/)?.[0] ?? "";
    await open(person, local(link));
    is("the link only shows the button: opening it confirms nothing", await words(person.locator("h1")), "Get emails from Harbor Kitchen Local?");
    await Promise.all([person.waitForURL(/status=joined/), person.getByRole("button", { name: "Yes, join the list" }).click()]);
    is("pressed, they are on the list", await words(person.locator("h1")), "Welcome to Harbor Kitchen Local's list");
    await open(person, local(link));
    is("and the link is used up", await words(person.locator("h1")), "This link has expired");
    await person.close();
  }

  await keepSmall();
  part("A contact form on the store page, to the creator's own inbox");
  {
    await open(studio, `${LOCAL}/studio`);
    const box = studio.locator("form#contact");
    await box.getByRole("checkbox", { name: "Show the contact form on my store page" }).check();
    await box.getByRole("button", { name: "Save", exact: true }).click();
    await studio.getByText("The contact form is on your store page.").first().waitFor({ timeout: 30_000 });
    const person = await context.newPage();
    await open(person, `${LOCAL}/@localshop`);
    const form = person.getByRole("region", { name: "Get in touch" });
    await form.getByLabel("Your name").fill("Dana Writer");
    await form.getByLabel("Your email").fill("dana.writer@example.com");
    await form.getByLabel("Your message").fill("Could we work together on a recipe series for our magazine?");
    const before = services.emails().length;
    await Promise.all([person.waitForURL(/\/contact\?status=sent/, { timeout: 60_000 }), form.getByRole("button", { name: "Send the message" }).click()]);
    is("the visitor is told it is on its way", await words(person.locator("h1")), "Your message is on its way");
    const mail = services.emails().slice(before).find((email) => /via your store/.test(email.subject));
    is("it reaches the creator, with Reply to the visitor, and nothing goes to the visitor", [
      [].concat(mail?.to)[0],
      mail?.reply_to,
      services.emails().slice(before).some((email) => [].concat(email.to).includes("dana.writer@example.com")),
    ], ["owner@example.com", "dana.writer@example.com", false]);
    await person.close();
  }

  part("The store's own questions, drafted with AI, on the page and for search engines");
  {
    await open(studio, `${LOCAL}/studio`);
    const faq = studio.getByRole("region", { name: "Questions on your store page" });
    await faq.getByRole("button", { name: "Draft them with AI" }).click();
    await faq.getByLabel("Question 2").waitFor({ timeout: 30_000 });
    await faq.getByLabel("Its answer").first().fill("As a download right after paying, on the thank-you page and by email.");
    await faq.getByRole("button", { name: "Save questions" }).click();
    await studio.getByText("Questions saved. They show on your store page.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    const section = page.getByRole("region", { name: "Questions, answered" });
    await section.getByText("How do the files arrive?").click();
    is("on the store page, opened by a tap, in the creator's words", [
      await section.locator("details").count(),
      (await words(section.locator("details").first())).includes("on the thank-you page and by email"),
    ], [2, true]);
    const data = await page.locator('script[type="application/ld+json"]').allTextContents();
    is("and for search engines, an FAQ page", data.some((json) => json.includes('"FAQPage"') && json.includes("How do I pay?")), true);
  }

  part("Help to choose on the store page, picked by AI from the catalog");
  {
    await open(studio, `${LOCAL}/studio`);
    const answers = studio.locator(".card", { hasText: "Answer buyers' questions with AI" });
    await answers.getByRole("checkbox", { name: /help visitors choose on my store page/ }).check();
    await answers.getByRole("button", { name: "Save", exact: true }).click();
    await studio.getByText("Saved. The box is on your product pages.").first().waitFor({ timeout: 30_000 });
    const person = await context.newPage();
    await open(person, `${LOCAL}/@localshop`);
    const guide = person.getByRole("region", { name: "Not sure which one is for you?" });
    // ME1: catalog first in both the DOM/read order and the painted layout.
    // Exercise the actual hydrated guide; the existing questions below still
    // prove that its catalog picks and no-match response work after the move.
    await guide.waitFor({ state: "visible" });
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
      await person.setViewportSize(viewport);
      await person.evaluate(() => document.fonts.ready);
      const placement = await guide.evaluate((node) => {
        const products = [...document.querySelectorAll('[data-part="products"] li[data-item^="p:"]')];
        const last = products.at(-1);
        return {
          catalogPresent: products.length > 0,
          readingOrder: Boolean(last && (last.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)),
          visualOrder: Boolean(last && node.getBoundingClientRect().top >= last.getBoundingClientRect().bottom),
        };
      });
      is("ME1 guide follows the catalog in reading and visual order " + viewport.width, placement, {
        catalogPresent: true, readingOrder: true, visualOrder: true,
      });
    }
    await guide.getByLabel("What are you looking for?").fill("dinners for a busy family");
    await guide.getByRole("button", { name: "Help me choose" }).click();
    await guide.getByText("These fit best").waitFor({ timeout: 30_000 });
    const picks = guide.locator(".st-guide-pick");
    is("two picks, each with why, leading to its own page", [
      await picks.count(),
      (await words(picks.first())).includes("It fits a busy week at home."),
      /^\/@localshop\/p\//.test((await picks.first().getAttribute("href")) ?? ""),
    ], [2, true, true]);
    await guide.getByLabel("What are you looking for?").fill("a trip to the moon");
    await guide.getByRole("button", { name: "Help me choose" }).click();
    await guide.getByText(/nothing Harbor Kitchen Local sells fits that yet/).waitFor({ timeout: 30_000 });
    if (process.env.E2E_SHOTS) await guide.screenshot({ path: join(process.env.E2E_SHOTS, "store-guide.png") });
    await person.close();
    await open(studio, `${LOCAL}/studio`);
    is("what was looked for and not found reaches the creator", await studio.getByText("a trip to the moon").count() > 0, true);
  }

  await keepSmall();
  part("Searching a long store");
  {
    const person = await context.newPage();
    await open(person, `${LOCAL}/@longshop`);
    const pod = person.locator("a.st-link-card", { hasText: "The pantry podcast" });
    is("a link with its own picture shows it small in place of the icon, saying nothing twice", [
      await pod.locator("img.st-link-thumb").getAttribute("src"),
      await pod.locator("img.st-link-thumb").getAttribute("alt"),
      await pod.locator(".st-link-icon").count(),
    ], [`/api/image/${"a".repeat(24)}/${"e".repeat(32)}.webp`, "", 0]);
    const search = person.getByRole("search", { name: "Search this store" });
    is("a store past one page offers a search; a short one does not", [await search.count(), await page.goto(`${LOCAL}/@localshop`).then(() => page.getByRole("search").count())], [1, 0]);
    await search.getByLabel("Search this store").fill("tomato creme");
    await Promise.all([person.waitForURL(/[?&]q=tomato\+creme/), search.getByRole("button", { name: "Search" }).click()]);
    is("every word, in a title or a summary, whatever the accents", [await person.locator("main h3, main .st-card h2, main li h2").filter({ hasText: /recipe/ }).count() >= 1, (await words(search)).includes("1 product for “tomato creme”")], [true, true]);
    await search.getByLabel("Search this store").fill("bread");
    await Promise.all([person.waitForURL(/[?&]q=bread/), search.getByRole("button", { name: "Search" }).click()]);
    is("ten breads in all, in the store's order, on one list", (await words(search)).includes("10 products for “bread”"), true);
    is("and a way back to every product", await search.getByRole("link", { name: "Show every product" }).count(), 1);
    is("a search's results are kept from search engines", await person.locator('meta[name="robots"]').getAttribute("content").then((c) => /noindex/.test(c ?? "")), true);
    await person.close();
  }

  part("A sale paid with PayPal, counted like any other");
  {
    const buyerContext = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const buyer = await buyerContext.newPage();
    await buyer.goto(`${LOCAL}/@longshop?utm_source=instagram`, { waitUntil: "networkidle", timeout: 120_000 });
    const href = await buyer.locator("a[href*='/@longshop/p/']").first().getAttribute("href");
    // Tagged as the creator's link in a bio would be: the page's own tags credit the sale.
    await buyer.goto(`${LOCAL}${href}?utm_source=instagram`, { waitUntil: "networkidle", timeout: 120_000 });
    const paypalForm = buyer.locator("form[action='/api/store/paypal/checkout']").first();
    is("the product page offers PayPal", (await paypalForm.count()) > 0, true);
    // PayPal's own page cannot be reached from here: the button's request goes to the store as the
    // browser sends it, cookies and all, and where its answer sends the buyer is read off it.
    let approve = "";
    await buyer.route("**/api/store/paypal/checkout", async (route) => {
      const answer = await route.fetch({ maxRedirects: 0 });
      approve = answer.headers().location ?? "";
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Off to PayPal</title><main>Off to PayPal</main>" });
    });
    await Promise.all([buyer.waitForURL(/\/api\/store\/paypal\/checkout/, { timeout: 60_000 }), paypalForm.locator("button[type=submit]").click()]);
    is("the buyer is sent to PayPal's own page", /^https:\/\/www\.paypal\.com\/checkoutnow\?token=/.test(approve), true);
    const order = approve ? new URL(approve).searchParams.get("token") : "";
    await buyer.goto(`${LOCAL}/api/store/paypal/return?store=longshop&token=${order}`, { waitUntil: "networkidle", timeout: 120_000 });
    is("back from PayPal, on the thanks page", /\/thanks\?paypal=/.test(buyer.url()), true);
    const ownerContext = await browser.newContext();
    await ownerContext.addCookies([{ name: "nl_session", value: longSession, url: LOCAL }]);
    const today = new Date().toISOString().slice(0, 10);
    const range = await (await ownerContext.request.get(`${LOCAL}/api/store/stats/range?from=${today}&to=${today}`)).json();
    is("in the owner's numbers, with the channel the visit came from", [range.range?.totals?.sales, range.range?.totals?.cents, range.range?.channels?.find((c) => c.source === "instagram")?.sales], [1, 300, 1]);
    const file = await (await ownerContext.request.get(`${LOCAL}/api/store/export?what=sales&range=30`)).text();
    is("and in the sales file, said to be paid with PayPal", file.split("\r\n").some((line) => line.includes(`paypal:${order}`) && line.endsWith('"paypal"')), true);
    await buyerContext.close();
    await ownerContext.close();
  }

  part("A reply to a review, drafted with AI");
  {
    await open(studio, `${LOCAL}/studio/reviews?view=all`);
    // The first review, found by what stays on it while it is answered: its order.
    const row = studio.locator("li:not([data-mark])", { hasText: /Order (cs|pi)_/ }).first();
    await row.getByRole("button", { name: /^(Reply|Edit your reply)$/ }).click();
    await row.getByRole("button", { name: /Draft (it|another) with AI/ }).click();
    await row.getByText("Drafted. Read it, make it yours, then post it.").waitFor({ timeout: 30_000 });
    is("the draft is in the box, not yet posted", [await row.locator("textarea").inputValue(), await row.getByText("Your public reply").count()], ["Thank you for baking along, and for saying so.", 0]);
  }

  await keepSmall();
  part("The line under the store's name, written with AI");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("#details summary").filter({ hasText: "Edit name and description" }).click();
    await studio.getByRole("button", { name: "Suggest three lines" }).click();
    const lines = studio.getByRole("list", { name: "Suggested lines" });
    await lines.waitFor({ timeout: 30_000 });
    is("three lines to choose from", await lines.locator("li").count(), 3);
    await lines.getByRole("button", { name: "Use this line: Cook once, eat all week." }).click();
    is("one press puts it in the box, nothing saved yet", await studio.locator("#store-bio").inputValue(), "Cook once, eat all week.");
  }

  await keepSmall();
  part("The letters of the page, picked in the studio");
  {
    await open(studio, `${LOCAL}/studio`);
    const letters = studio.getByRole("group", { name: "Letters" });
    await letters.getByText("Editorial", { exact: true }).click();
    await studio.getByRole("button", { name: "Save the look" }).click();
    await studio.getByText("Look saved.").first().waitFor({ timeout: 15_000 });
    await open(page, `${LOCAL}/@localshop`);
    const painted = await page.locator(".st-page").first().evaluate((el) => [el.style.getPropertyValue("--st-font-head"), getComputedStyle(el.querySelector(".font-display") ?? el).fontFamily]);
    is("the store page's headings take them", [painted[0], /Fraunces|font-st-editorial/i.test(painted[1]) || painted[1].includes("__")], ["var(--font-st-editorial)", true]);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "letters-editorial.png") });
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("group", { name: "Letters" }).getByText("Modern", { exact: true }).click();
    await studio.getByRole("button", { name: "Save the look" }).click();
    await studio.getByText("Look saved.").first().waitFor({ timeout: 15_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("and back to Modern, nothing more is painted", await page.locator(".st-page").first().evaluate((el) => el.style.getPropertyValue("--st-font-head")), "");
  }

  await keepSmall();
  part("A background behind the cards, picked in the studio");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("group", { name: "Background" }).getByText("Glow", { exact: true }).click();
    await studio.getByRole("button", { name: "Save the look" }).click();
    await studio.getByText("Look saved.").first().waitFor({ timeout: 15_000 });
    await open(page, `${LOCAL}/@localshop`);
    const drawn = await page.locator(".st-page").first().evaluate((el) => [el.style.getPropertyValue("--st-backdrop"), getComputedStyle(el).backgroundImage]);
    is("the store page draws it, from its own colors", [/radial-gradient/.test(drawn[0]), drawn[1] !== "none"], [true, true]);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "backdrop-glow.png") });
  }

  await keepSmall();
  part("A welcome video under the store's name");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("#intro-url").fill("not a video");
    is("an address that is no video is said so before saving", await studio.locator("#intro-url").getAttribute("aria-invalid"), "true");
    await studio.locator("#intro-url").fill("https://vimeo.com/123456789");
    await studio.getByRole("button", { name: "Save the video" }).click();
    await studio.getByText("Welcome video saved. It plays under your store's name.").first().waitFor({ timeout: 15_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("under the store's name, loaded only when played", [
      await page.getByRole("button", { name: /Play the video: Harbor Kitchen Local\. It loads from Vimeo\./ }).count(),
      await page.locator('iframe[src*="vimeo"]').count(),
    ], [1, 0]);
  }

  await keepSmall();
  part("Support my work: a fan gives with nothing bought");
  {
    await open(studio, `${LOCAL}/studio`);
    const box = studio.locator("form#support");
    await box.getByRole("checkbox", { name: "Show Support my work on my store page" }).check();
    await box.locator("#tip-amount-0").fill("4");
    await box.getByRole("button", { name: "Save", exact: true }).click();
    await studio.getByText("Support my work is on your store page.").first().waitFor({ timeout: 30_000 });
    const fan = await context.newPage();
    await open(fan, `${LOCAL}/@localshop`);
    const support = fan.getByRole("region", { name: "Support my work" });
    is("the store page offers the creator's amounts, the cheapest first", await support.getByRole("button").evaluateAll((all) => all.map((b) => b.textContent)), ["$4", "$5", "$10", "Send my support"]);
    await Promise.all([fan.waitForURL(/\/@localshop\/tip\?session_id=/, { timeout: 60_000 }), support.getByRole("button", { name: "$5" }).click()]);
    const gift = services.checkouts().at(-1);
    is("one payment of that amount, marked as support, with no product", [gift.amount_total, gift.metadata.kind, gift.metadata.product ?? null, gift.metadata.title], [500, "tip", null, "Support"]);
    is("and the fan is thanked for what Stripe took", [await words(fan.locator("h1")), (await words(fan.locator("main"))).includes("Your $5 has reached Harbor Kitchen Local.")], ["Thank you for your support", true]);
    tipPath = `${new URL(fan.url()).pathname}${new URL(fan.url()).search}`;
    await open(fan, `${LOCAL}/@localshop`);
    await support.getByLabel("Another amount").fill("0.20");
    await Promise.all([fan.waitForURL(/[?&]tip=amount/), support.getByRole("button", { name: "Send my support" }).click()]);
    is("an amount under the least is refused on the page, and nothing is opened", [await support.getByRole("alert").count(), services.checkouts().at(-1).id === gift.id], [1, true]);
    await support.getByLabel("Another amount").fill("7,50");
    await Promise.all([fan.waitForURL(/\/tip\?session_id=/, { timeout: 60_000 }), support.getByLabel("Another amount").press("Enter")]);
    is("one typed the European way, sent with Enter, is that amount", services.checkouts().at(-1).amount_total, 750);
    await fan.close();
    await open(studio, `${LOCAL}/studio`);
    const listed = studio.locator("li:not([data-mark])", { hasText: "Support from your store page" }).first();
    is("the creator sees it with the sales, as support with nothing to send", [await listed.count(), (await words(listed)).includes("Given by"), await listed.getByRole("button").count()], [1, true, 0]);
  }

  await keepSmall();
  part("A media kit for brands, with a PDF to save");
  {
    await open(studio, `${LOCAL}/studio`);
    const kit = studio.locator("section#media-kit");
    await kit.getByRole("checkbox", { name: /Publish my media kit/ }).check();
    await kit.getByRole("button", { name: "Add a platform" }).click();
    await kit.getByLabel("Where").selectOption("instagram");
    await kit.getByLabel("How many").fill("12.4k");
    await kit.getByLabel("Average views (optional)").fill("3,100");
    await kit.getByRole("button", { name: "Add a platform" }).click();
    await kit.getByLabel("Where").nth(1).selectOption("email");
    await kit.getByLabel("How many").nth(1).fill("2600");
    await kit.getByRole("button", { name: "Draft it with AI" }).click();
    await kit.getByRole("button", { name: "Use this one" }).first().click();
    is("the introduction drafted with AI goes into the box", await kit.locator("#kit-pitch").inputValue(), "I cook weeknight dinners for busy families, and they cook along.");
    is("asked with the numbers typed, not yet saved", services.writing().at(-1).messages[0].content.includes("Instagram: 12.4k, 3,100 average views"), true);
    await kit.locator("#kit-facts").fill("68% in the US\nMost are 25 to 34");
    await kit.getByRole("button", { name: "Add an offer" }).click();
    await kit.getByLabel("What", { exact: true }).fill("One Instagram Reel");
    await kit.getByLabel(/^Price/).fill("800");
    await kit.getByRole("button", { name: "Add an offer" }).click();
    await kit.getByLabel("What", { exact: true }).nth(1).fill("A newsletter mention");
    await kit.locator("#kit-brands").fill("Acme Pans, Green Grocer");
    // Numbers this site counted, picked to be shown (lib/verified-numbers.ts).
    await kit.getByRole("checkbox", { name: /^Visitors to my store/ }).check();
    await kit.getByRole("checkbox", { name: /^Sales, last 30 days/ }).check();
    await kit.getByRole("button", { name: "Save the media kit" }).click();
    await studio.getByText("Media kit saved.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("the store page links to it at its foot", await page.getByRole("link", { name: "Media kit" }).getAttribute("href"), "/@localshop/media-kit");
    await open(page, `${LOCAL}/@localshop/media-kit`);
    const main = await words(page.locator("main"));
    is("the kit says who, to whom, and how many, compactly", [await words(page.locator("h1")), main.includes("12.4K followers"), main.includes("3.1K average views"), main.includes("2.6K subscribers"), main.includes("Combined reach 15K")], ["Harbor Kitchen Local", true, true, true, true]);
    is("the numbers are said to be the creator's, with the day", /Numbers as stated by Harbor Kitchen Local, last updated [A-Z][a-z]+ \d{1,2}, \d{4}\./.test(main), true);
    is("what this site counted is set apart", [main.includes("Counted by Marktmorgen"), main.includes("Products in the store")], [true, true]);
    is("with the visitors and sales it counted itself, dated, where the creator picked them", [
      await page.locator("[data-kit-counted=visitors]").count(),
      await page.locator("[data-kit-counted=sales]").count(),
      await page.locator("[data-kit-counted=countries]").count(),
      /Visitors counted on this store's own pages; sales and buyers' countries from the payments on its Stripe account\. Read on [A-Z][a-z]+ \d{1,2}, \d{4}\./.test(main),
    ], [1, 1, 0, true]);
    is("what a collaboration costs, or on request, and who they worked with", [main.includes("One Instagram Reel $800"), main.includes("A newsletter mention Price on request"), main.includes("Acme Pans"), main.includes("Green Grocer")], [true, true, true, true]);
    is("a brand can write, or save it as a PDF", [await page.getByRole("link", { name: "Get in touch" }).getAttribute("href"), await page.getByRole("button", { name: "Save as PDF" }).count()], ["/@localshop#contact", 1]);
    await page.emulateMedia({ media: "print" });
    is("printed, the buttons are left out", await page.getByRole("button", { name: "Save as PDF" }).isVisible(), false);
    await page.emulateMedia({ media: "screen" });
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "media-kit.png"), fullPage: true });
    await open(page, `${LOCAL}/@longshop/media-kit`);
    is("a store without one has no such page, said in the store's own look", await words(page.locator("h1")), "This page isn't here");
  }

  part("The numbers shared with a link, a password and an end");
  {
    await open(studio, `${LOCAL}/studio`);
    const links = studio.locator("[data-numbers-links]");
    await links.locator("#numbers-link-label").fill("Acme sponsorship");
    await links.locator("#numbers-link-password").fill("short");
    await links.getByRole("button", { name: "Make the link" }).click();
    await links.getByRole("alert").waitFor({ timeout: 15_000 });
    is("a short password is refused", await words(links.getByRole("alert")), "Use a password of 8 characters or more. Send it apart from the link.");
    await links.locator("#numbers-link-password").fill("harbor-local-2026");
    await links.getByRole("button", { name: "Make the link" }).click();
    await links.locator("[data-numbers-link-made]").waitFor({ timeout: 30_000 });
    const url = await links.locator("[data-numbers-link-made] a").getAttribute("href");
    is("a link is made, at its own address", /\/numbers\/[a-z0-9]{20}$/.test(url ?? ""), true);
    const reader = await browser.newContext({ viewport: { width: 430, height: 900 } });
    const partner = await reader.newPage();
    await partner.goto(local(url ?? ""), { waitUntil: "networkidle", timeout: 120_000 });
    is("it asks for the password first, and shows nothing before", [await partner.locator("#numbers-password").count(), await partner.locator("[data-numbers-link]").count()], [1, 0]);
    await partner.fill("#numbers-password", "wrong-password");
    await Promise.all([partner.waitForURL(/wrong=1/), partner.getByRole("button", { name: "Open the numbers" }).click()]);
    is("a wrong one says so", await words(partner.locator("main").getByRole("alert")), "That password does not open these numbers.");
    await partner.fill("#numbers-password", "harbor-local-2026");
    await Promise.all([partner.waitForURL((u) => !u.search.includes("wrong")), partner.getByRole("button", { name: "Open the numbers" }).click()]);
    await partner.locator("[data-numbers-link]").waitFor({ timeout: 30_000 });
    const shown = await words(partner.locator("main"));
    is("the right one shows the counted numbers, read-only, dated, without revenue unless chosen", [/Counted by Marktmorgen, not typed/.test(shown), /Read on [A-Z][a-z]+ \d{1,2}, \d{4}/.test(shown), /Products sold, last 30 days/.test(shown), /Revenue/i.test(shown)], [true, true, true, false]);
    if (process.env.E2E_SHOTS) await partner.screenshot({ path: join(process.env.E2E_SHOTS, "numbers-link.png"), fullPage: true });
    await links.getByRole("button", { name: "Take it back" }).first().click();
    await studio.getByText("Taken back. The link no longer opens.").first().waitFor({ timeout: 30_000 });
    await partner.reload({ waitUntil: "networkidle" });
    is("taken back, it no longer opens", await words(partner.locator("h1")), "This link has ended");
    await reader.close();
  }

  await keepSmall();
  part("How do I…? answered in the studio from the help center");
  {
    await open(studio, `${LOCAL}/studio`);
    const help = studio.getByRole("region", { name: "How do I…?" });
    await help.getByLabel("Your question").fill("What files can I sell, and how big?");
    await help.getByRole("button", { name: "Ask" }).click();
    await help.getByText("Up to 5 GB, in the formats the help center lists.").waitFor({ timeout: 30_000 });
    is("answered, with the help center's own answer to read in full", await help.getByRole("link", { name: "What file can I sell, and how big?" }).getAttribute("href"), "/help#what-file-can-i-sell-and-how-big");
    const before = services.writing().length;
    await help.getByLabel("Your question").fill("zzz qqq");
    await help.getByRole("button", { name: "Ask" }).click();
    await help.getByText(/does not cover that yet/).waitFor({ timeout: 30_000 });
    is("a question the help center does not cover is said so, without asking the model", services.writing().length, before);
    await help.getByLabel("Your question").fill("Que arquivos posso vender?");
    await help.getByRole("button", { name: "Ask" }).click();
    // The store's AI requests share one limit a minute with the parts before this one:
    // when it is reached, the creator is told so and asks again a minute later.
    const answered = help.getByRole("link", { name: "What file can I sell, and how big?" });
    const slow = help.getByText("A few questions a minute at most. Ask again in a moment.");
    await answered.or(slow).first().waitFor({ timeout: 30_000 });
    if (await slow.count()) {
      await studio.waitForTimeout(61_000);
      await help.getByRole("button", { name: "Ask" }).click();
    }
    await answered.waitFor({ timeout: 30_000 });
    is("one asked in another language is put into English first, and answered from what that finds", services.writing().slice(before).map((w) => String(w.system).slice(0, 30)), ["Put the user's question into p", "You answer a creator's questio"]);
  }

  await keepSmall();
  part("A new store drafted with AI from a few sentences");
  {
    await open(studio, `${LOCAL}/studio?store=${fresh}`);
    const setup = studio.locator("section#setup-ai");
    is("a store with nothing on it is offered a first draft", await setup.count(), 1);
    await setup.getByLabel("What you do, and for whom").fill("I teach busy parents to cook a week of dinners in two hours on Sunday. My planner is $12 and the club is $7 a month.");
    await setup.getByRole("button", { name: "Draft my store" }).click();
    await setup.getByRole("radio", { name: "Cook once, eat all week." }).check();
    is("it shows the products to keep, each editable", [await setup.locator("#setup-title-0").inputValue(), await setup.locator("#setup-price-1").inputValue()], ["Sunday Meal Planner", "7"]);
    await setup.locator("#setup-price-0").fill("14");
    await setup.getByRole("button", { name: "Keep what I chose" }).click();
    await studio.getByText("Kept: the line under your name, 2 draft products, each with its sales page, your questions and answers.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@freshshop`);
    const front = await words(page.locator("main"));
    is("the line is under the name, the questions are on the page, and the drafts are not for sale", [front.includes("Cook once, eat all week."), front.includes("How do I get the planner?"), front.includes("Sunday Meal Planner")], [true, true, false]);
    await open(studio, `${LOCAL}/studio?store=${fresh}`);
    is("in the studio, the drafts wait, at the price chosen", [(await words(studio.locator("main"))).includes("Sunday Meal Planner"), (await words(studio.locator("main"))).includes("$14"), await studio.locator("section#setup-ai").count()], [true, true, 0]);
  }

  await keepSmall();
  part("A notice about a store's content, and taking it down");
  {
    const rights = await context.newPage();
    await open(rights, `${LOCAL}/@localshop`);
    await Promise.all([rights.waitForURL(/\/report\?url=/), rights.getByRole("link", { name: "Report a problem with this page" }).click()]);
    is("the store page leads to the form with its address filled in", await rights.locator("#report-url").inputValue(), "https://marktmorgen.com/@localshop");
    await rights.locator("#report-work").fill("My recording 'Kitchen Nights' is in the playlist this page plays, uploaded without my permission.");
    await rights.locator("#report-name").fill("Rita Owner");
    await rights.locator("#report-email").fill("rita@example.com");
    await rights.getByRole("button", { name: "Send the notice" }).click();
    is("a notice with something missing says what", await words(rights.locator("form [role=alert]")), "A copyright notice needs a postal address or a telephone number as well.");
    await rights.locator("#report-contact").fill(("+" + "1 555 0100"));
    await rights.getByRole("checkbox", { name: /I believe in good faith/ }).check();
    await rights.getByRole("checkbox", { name: /under penalty of perjury/ }).check();
    await rights.locator("#report-signature").fill("Rita Owner");
    await rights.getByRole("button", { name: "Send the notice" }).click();
    await rights.getByText("Your notice was sent").waitFor({ timeout: 30_000 });
    const notice = services.emails().filter((email) => [].concat(email.to).includes("support@marktmorgen.com") && /Copyright notice/.test(email.subject)).at(-1);
    is("it reaches the support inbox only, with Reply to the sender", [notice?.subject, notice?.reply_to, services.emails().some((email) => [].concat(email.to).includes("rita@example.com"))], ["Copyright notice about @localshop", "rita@example.com", false]);
    const takedown = notice?.text.match(/https?:\/\/\S+\/takedown\/[0-9a-f]{48}/)?.[0] ?? "";
    await open(rights, local(takedown));
    const row = rights.locator("li", { hasText: "Our kitchen playlist" });
    await row.getByRole("button", { name: "Remove this link" }).click();
    await rights.getByText(/^Done: The link "Our kitchen playlist"/).waitFor({ timeout: 30_000 });
    const told = services.emails().filter((email) => [].concat(email.to).includes("owner@example.com") && /Content taken down/.test(email.subject)).at(-1);
    is("the creator is told what was taken down and how to answer", [Boolean(told), told?.text.includes("counter-notice")], [true, true]);
    await open(page, `${LOCAL}/@localshop`);
    is("and it is gone from the page", await page.getByText("Our kitchen playlist").count(), 0);
    await rights.getByRole("button", { name: "Switch off its pages and sales" }).click();
    await rights.getByText(/^Done: Your store's pages and sales/).waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("a store switched off shows that it is unavailable, and that buyers keep what they bought", [await words(page.locator(".st-note p").first()), (await words(page.locator(".st-note"))).includes("is still yours")], ["This page is unavailable", true]);
    await open(studio, `${LOCAL}/studio`);
    is("its creator sees why in the studio", await studio.getByText("Your store's pages and sales are switched off after notices about its content.").count(), 1);
    await open(rights, local(takedown));
    await rights.getByRole("button", { name: "Switch the store back on" }).click();
    await rights.getByText("Done: The store's pages and sales are back on.").waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop`);
    is("and back on in one press", await page.locator("h1").count() > 0 && (await page.locator(".st-part").count()) > 0, true);
    await rights.close();
  }

  await keepSmall();
  await keepSmall();
  part("Selling something before it is ready: a pre-order");
  {
    const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const expected = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    await open(studio, `${LOCAL}/studio`);
    const made = await studio.evaluate(async ([day, today]) => {
      const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      const added = await post("/api/store/product", { action: "add", title: "The Bread Book", summary: "Forty loaves, from the first starter to a crusty rye.", price: "25" });
      const id = added.product?.id ?? "";
      const notSoon = await post("/api/store/preorder", { id, day, agree: true });
      const soon = await post("/api/store/waitlist", { action: "soon", id, on: true });
      const tooSoon = await post("/api/store/preorder", { id, day: today, agree: true });
      const unsaid = await post("/api/store/preorder", { id, day, agree: false });
      const taken = await post("/api/store/preorder", { id, day, agree: true });
      return { id, notSoon: notSoon.error, soon: soon.ok, tooSoon: tooSoon.error, unsaid: unsaid.error, day: taken.view?.day };
    }, [day, new Date().toISOString().slice(0, 10)]);
    preorderId = made.id;
    is("taken only for something coming soon, from tomorrow, with the refund agreed to", [made.notSoon, made.soon, made.tooSoon, made.unsaid, made.day], ["soon", true, "day", "agree", day]);
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("button[aria-expanded]", { hasText: "The Bread Book" }).first().click();
    const said = studio.getByText(`Taking pre-orders: paid today, expected on ${expected}.`, { exact: false });
    await said.first().waitFor({ timeout: 15_000 }).catch(() => {});
    is("the studio says it is taking them", await said.count() > 0, true);
    if (process.env.E2E_SHOTS) await studio.locator("div:has(> label > input[type=checkbox]):has-text('Coming soon, with a waitlist')").first().screenshot({ path: join(process.env.E2E_SHOTS, "preorder-studio.png") }).catch(() => {});

    await open(page, `${LOCAL}/@localshop/p/${preorderId}`);
    const box = page.locator("#preorder");
    is("its page sells it with the day it is expected, and what happens if it does not come out", [
      await words(box.locator("button[type=submit]")),
      (await words(box)).includes(`Expected on ${expected}`),
      (await words(box)).includes("If it does not come out, Harbor Kitchen Local refunds you in full."),
    ], ["Pre-order for $25", true, true]);
    is("the waitlist is still there for whoever would rather wait", await page.locator("details:has(#waitlist) summary").count(), 1);
    const data = await page.locator('script[type="application/ld+json"]').allTextContents();
    is("and search engines are told it is a pre-order", data.some((text) => text.includes("https://schema.org/PreOrder")), true);
    if (process.env.E2E_SHOTS) await page.locator("#buy").screenshot({ path: join(process.env.E2E_SHOTS, "preorder.png") });

    const before = services.emails().length;
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), box.locator("button[type=submit]").click()]);
    const paid = services.checkouts().at(-1);
    is("one payment, marked a pre-order, with nothing added and no offer after it", [paid.amount_total, paid.metadata.preorder, paid.metadata.bump ?? null, paid.metadata.upsell_key ?? null, paid.metadata.buyer_key ?? null], [2500, "yes", null, null, null]);
    preorderSession = paid.id;
    is("the page after paying says when it comes", [await words(page.locator("h1")), (await words(page.locator("main"))).includes(`It is expected on ${expected}.`)], ["Pre-ordered", true]);
    let receipt = null;
    for (let i = 0; i < 40 && !receipt; i += 1) {
      await new Promise((wait) => setTimeout(wait, 500));
      receipt = services.emails().slice(before).find((email) => email.subject === "Your pre-order: The Bread Book") ?? null;
    }
    is("and a receipt comes, with the day", [Boolean(receipt), receipt?.text.includes(`It is expected on ${expected}.`)], [true, true]);
    const download = await page.evaluate(async ([session]) => (await fetch(`/api/store/download?handle=localshop&session_id=${session}`)).status, [preorderSession]);
    is("nothing opens before it comes out", download, 403);
  }

  await keepSmall();
  part("A bundle the buyer builds: any 2 of these 4");
  {
    await open(studio, `${LOCAL}/studio`);
    const items = [ids["Weeknight Dinners"], ids["Pantry Checklist"], ids["Sunday Baking"], ids["Meal Planner"]];
    const made = await studio.evaluate(async ([items]) => {
      const post = (body) => fetch("/api/store/bundle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      const all = await post({ action: "create", title: "Any Two Guides", price: "20", summary: "Choose the two you need.", items, pick: 4 });
      const made = await post({ action: "create", title: "Any Two Guides", price: "20", summary: "Choose the two you need.", items, pick: 2 });
      return { all: all.error, id: made.id ?? "" };
    }, [items]);
    pickId = made.id;
    is("buyers choose fewer than it holds, and it is made", [made.all, Boolean(pickId)], ["pick", true]);

    await open(page, `${LOCAL}/@localshop/p/${pickId}`);
    const box = page.locator("#buy");
    is("its page says how many of how many, and lists them to choose from, with no total for the whole list", [
      (await words(page.locator("main"))).includes("Choose any 2 of these 4 products"),
      await box.locator('input[name="pick"]').count(),
      (await words(page.locator("main"))).includes("$79 of products"),
    ], [true, 4, false]);
    await box.getByLabel(/Pantry Checklist/).check();
    await box.getByLabel(/Meal Planner/).check();
    const button = box.locator("form[data-checkout] button[type=submit]");
    is("two chosen: the rest rest, and the button says what it buys", [
      await box.getByLabel(/Sunday Baking/).isDisabled(),
      await words(button),
      (await words(box)).includes("$36 of products for $20"),
    ], [true, "Buy your 2 for $20", true]);
    if (process.env.E2E_SHOTS) await box.screenshot({ path: join(process.env.E2E_SHOTS, "pick-bundle.png") });
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), button.click()]);
    const paid = services.checkouts().at(-1);
    is("the checkout carries exactly those two, in the bundle's order", [paid.amount_total, paid.metadata.bundle], [2000, `${ids["Pantry Checklist"]},${ids["Meal Planner"]}`]);
    const thanks = await words(page.locator("main"));
    is("and the page after paying hands over those two only", [thanks.includes("Pantry Checklist"), thanks.includes("Meal Planner"), thanks.includes("Sunday Baking")], [true, true, false]);
    const back = await page.evaluate(async ([id, one]) => {
      const form = new URLSearchParams({ handle: "localshop", product: id, pick: one });
      const response = await fetch("/api/store/checkout", { method: "POST", body: form });
      return response.url;
    }, [pickId, ids["Pantry Checklist"]]);
    is("one too few, sent without the page's help, comes back to choose again", /\?pick=count/.test(back), true);
  }

  await keepSmall();
  part("A cart: two products, one payment, 10% off for buying both");
  {
    await open(studio, `${LOCAL}/studio`);
    const dealt = await studio.evaluate(() => fetch("/api/store/cart-deal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true, min: 2, percent: 10 }) }).then((r) => r.json()));
    is("the creator switches on 10% off for 2 or more", dealt.deal, { on: true, min: 2, percent: 10 });
    await open(page, `${LOCAL}/@localshop`);
    const card = (title) => page.locator("li.st-card, li", { hasText: title }).filter({ has: page.getByRole("button", { name: "Add to cart" }) }).first();
    is("every Add to cart says so before anything is chosen", (await words(card("Weeknight Dinners"))).includes("10% off when you buy 2 or more together."), true);
    await card("Weeknight Dinners").getByRole("button", { name: "Add to cart" }).click();
    const opener = page.locator("#cart .st-cart-open");
    await opener.click();
    const panel = page.getByRole("region", { name: "Your cart" });
    await panel.locator("form[data-checkout]").waitFor({ timeout: 15_000 });
    is("with one in it, the cart says how many more it takes", (await words(panel)).includes("Add 1 more to take 10% off everything in your cart."), true);
    await opener.click();
    await card("Pantry Checklist").getByRole("button", { name: "Add to cart" }).click();
    is("the cart says what is in it, at the top of the page", await words(opener), "Cart, 2 products");
    is("something that cannot go in one has no button", await page.locator("li", { hasText: "The Bread Book" }).getByRole("button", { name: "Add to cart" }).count(), 0);
    await opener.click();
    await panel.getByText("10% off for buying more").waitFor({ timeout: 15_000 });
    const shown = await words(panel);
    is("it lists them with their prices now, what the deal takes off, and the total", [shown.includes("Weeknight Dinners"), shown.includes("Pantry Checklist"), /10% off for buying more\s*−\$\d/.test(shown), /Total\s*\$\d/.test(shown)], [true, true, true, true]);
    is("and it reads from the left, whatever the store's header is centered on", await panel.evaluate((el) => getComputedStyle(el).textAlign), "left");
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "cart.png") });
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), panel.locator("form[data-checkout] button[type=submit]").click()]);
    const paid = services.checkouts().at(-1);
    const total = shown.match(/Check out · (\$[\d.,]+)/)?.[1] ?? "";
    is("one payment for both, at the total the cart said, the second named as an added product, with the deal on the order", [
      paid.metadata.cart_deal,
      paid.metadata.cart,
      paid.metadata.product,
      paid.metadata.bump,
      `$${(paid.amount_total / 100).toFixed(2)}`.replace(".00", ""),
    ], ["10", "yes", ids["Weeknight Dinners"], ids["Pantry Checklist"], total]);
    const thanks = await words(page.locator("main"));
    is("and the page after paying hands over both", [thanks.includes("Weeknight Dinners"), thanks.includes("Pantry Checklist")], [true, true]);
    await open(page, `${LOCAL}/@localshop`);
    is("and the cart is empty again", await page.locator("#cart .st-cart-open").count(), 0);
    const off = await studio.evaluate(() => fetch("/api/store/cart-deal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false, min: 2, percent: 10 }) }).then((r) => r.json()));
    is("and the creator can switch it off again", off.deal?.on, false);
  }

  await keepSmall();
  part("A cart left at its checkout: one reminder, and the cart put back");
  {
    const remind = (enabled) => studio.evaluate(async (enabled) => (await (await fetch("/api/store/recovery", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, address: "1 Harbor Road, Portland, ME 04101" }) })).json()).ok === true, enabled);
    is("with reminders switched on", await remind(true), true);
    const cart = `${ids["Weeknight Dinners"]},${ids["Pantry Checklist"]}`;
    await open(page, `${LOCAL}/@localshop/left?cart=${cart}`);
    const card = page.locator("main .st-card");
    is("the way back from a cart's checkout says nothing was charged, and what was in it", [
      await words(page.locator("h1")),
      (await words(card)).includes("Weeknight Dinners"),
      (await words(card)).includes("Pantry Checklist"),
      await card.getByRole("link", { name: "Back to your cart" }).first().getAttribute("href"),
    ], ["You left before paying for your cart", true, true, `/@localshop?restore=${cart}#cart`]);
    await card.getByLabel("Your email").fill("cartleft@example.com");
    await Promise.all([page.waitForURL(/status=asked/), card.getByRole("button", { name: "Remind me once" }).click()]);
    is("one reminder of the cart can be asked for, with no address in the link", [
      (await words(card)).includes("will email you once, with your cart."),
      page.url().includes("cartleft"),
    ], [true, false]);
    await open(page, `${LOCAL}/@localshop`);
    await page.evaluate(() => window.localStorage.clear());
    await open(page, `${LOCAL}/@localshop?restore=${cart}#cart`);
    const panel = page.getByRole("region", { name: "Your cart" });
    await panel.locator("form[data-checkout]").waitFor({ timeout: 15_000 });
    is("the reminder's link puts the cart back as it was, open, and leaves the address clean", [
      (await words(panel)).includes("Weeknight Dinners"),
      (await words(panel)).includes("Pantry Checklist"),
      await words(page.locator("#cart .st-cart-open")),
      page.url().includes("restore="),
    ], [true, true, "Cart, 2 products", false]);
    await page.evaluate(() => window.localStorage.clear());
    is("and off again", await remind(false), true);
  }

  await keepSmall();
  part("A picture in an email, kept on this site");
  {
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    const box = studio.getByRole("textbox", { name: "Email", exact: true }).first();
    await box.fill("Hello,\n\nThe new loaf is out.");
    await studio.getByLabel("What the picture shows (for readers who cannot see it)").first().fill("The loaf on a board");
    const drawn = await studio.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1800;
      canvas.height = 1200;
      const pen = canvas.getContext("2d");
      for (let i = 0; i < 3000; i += 1) {
        pen.fillStyle = `hsl(${(i * 11) % 360} 60% ${35 + (i % 30)}%)`;
        pen.fillRect((i * 53) % 1800, (i * 97) % 1200, 30, 30);
      }
      return canvas.toDataURL("image/jpeg", 0.95).split(",")[1];
    });
    const before = services.blobs().size;
    await studio.locator("label:has-text('Add a picture') input[type=file]").first().setInputFiles({ name: "loaf.jpg", mimeType: "image/jpeg", buffer: Buffer.from(drawn, "base64") });
    let value = "";
    for (let i = 0; i < 40 && !value.includes("](https://marktmorgen.com/api/image/"); i += 1) {
      await new Promise((wait) => setTimeout(wait, 500));
      value = await box.inputValue();
    }
    const kept = [...services.blobs().entries()].slice(before).find(([path]) => path.endsWith(".jpg"));
    is("it goes into the email as a line of its own, with what it shows, and is kept as a JPEG under 300 KB", [
      /The new loaf is out\.\n\n!\[The loaf on a board\]\(https:\/\/marktmorgen\.com\/api\/image\/[0-9a-f]{24}\/[0-9a-f]{32}\.jpg\)$/.test(value),
      Boolean(kept),
      (kept?.[1].length ?? Infinity) <= 300_000,
      kept?.[1][0] === 0xff && kept?.[1][1] === 0xd8,
    ], [true, true, true, true]);
    is("and shows under the box, small, with what it shows", [await studio.getByRole("list", { name: "Pictures in this email" }).locator("li").count(), await studio.getByRole("img", { name: "The loaf on a board" }).count()], [1, 1]);
    if (process.env.E2E_SHOTS) await studio.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "email-picture.png") });
  }

  part("Logging in is not starting a store");
  await open(page, `${LOCAL}/signin?to=login`);
  is("pressed Log in: the page and its tab say log in", [await words(page.locator("h1")), await page.title()], ["Log in to your store", "Log in to your store — Marktmorgen"]);
  await open(page, `${LOCAL}/signin`);
  is("pressed Start your store: they say start", [await words(page.locator("h1")), await page.title()], ["Start your store", "Start your store — Marktmorgen"]);

  // The audit opens some thirty-five pages, on a server already well used: a fresh one.
  await restartApp();
  part("No accessibility errors on what buyers and creators see");
  {
    // A context of its own that lets the rules' script in past the pages'
    // policy; the pages themselves are drawn exactly as for anyone else.
    const audit = await browser.newContext({ viewport: { width: 430, height: 900 }, bypassCSP: true });
    const reader = await audit.newPage();
    const check = async (path, width) => {
      if (width) await reader.setViewportSize({ width, height: 900 });
      await reader.goto(`${LOCAL}${path}`, { waitUntil: "networkidle", timeout: 120_000 });
      // Checked where it was meant to be, not on a page it was sent on to.
      if (new URL(reader.url()).pathname !== path.split("?")[0]) return [`landed on ${new URL(reader.url()).pathname}`];
      await reader.addScriptTag({ path: axePath });
      const found = await reader.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        const said = result.violations.map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")} — ${v.nodes[0]?.failureSummary?.split("\n").slice(1, 2).join(" ").trim()}`);
        // A page the rules found nothing to check on would pass for the wrong reason.
        return result.passes.length >= 10 ? said : [`only ${result.passes.length} rules applied: the check did not run on the page`];
      });
      return found;
    };
    const pages = [
      ["the store", "/@localshop", 0],
      ["a sales page, on a phone", `/@localshop/p/${ids["Knife Skills"]}`, 0],
      ["the same page, on a computer", `/@localshop/p/${ids["Knife Skills"]}`, 1200],
      ["a page with reviews", `/@localshop/p/${ids["Sunday Baking"]}`, 430],
      ["all of a product's reviews", `/@localshop/p/${ids["Sunday Baking"]}/reviews`, 0],
      ["a product page without blocks", `/@localshop/p/${ids["Meal Planner"]}`, 0],
      ["signing in", "/signin", 0],
      // And what a creator works in, signed in as the store's owner.
      ["the studio", "/studio", 1200],
      ["the sales page editor", `/studio/pages?product=${ids["Knife Skills"]}`, 1200],
      ["the studio's reviews", "/studio/reviews?view=all", 1200],
      ["the studio's email", "/studio/email", 1200],
      ["the studio's affiliates", "/studio/affiliates", 1200],
      ["the studio's bundles", "/studio/bundles", 1200],
      ["the studio's funnels", "/studio/funnels", 1200],
      ["the studio's team", "/studio/team", 1200],
      ["the studio's imports", "/studio/import", 1200],
      ["the studio's integrations", "/studio/integrations", 1200],
      ["the studio's memberships", "/studio/memberships", 1200],
      ["a card link that no longer works", `/@localshop/manage/card?t=${"0".repeat(64)}`, 0],
      ["the studio's community", "/studio/community", 1200],
      ["the studio's calls", "/studio/meetings", 1200],
      ["the studio's outreach", "/studio/outreach", 1200],
      ["the studio's phone alerts", "/studio/phone", 1200],
      ["the studio's buyers", "/studio/people", 1200],
      ["a buyer's page in the studio", buyerPath, 1200],
      ["a buyer's page in the studio, on a phone", buyerPath, 430],
      ["the studio, on a phone", "/studio", 430],
      // And the site a creator meets first.
      ["the home page", "/", 0],
      ["the home page, on a computer", "/", 1200],
      ["a feature page", "/platform/sales-pages", 0],
      ["the writing help's page", "/platform/ai-writing", 1200],
      ["the help center", "/help", 1200],
      ["a buyer's orders", "/@localshop/orders", 0],
      ["the store's blog", "/@localshop/blog", 0],
      ["the sign-up box's page", "/@localshop/join?status=sent", 0],
      ["a long store's search", "/@longshop?q=bread", 0],
      ["a message's page", "/@localshop/contact?status=sent", 0],
      ["a supporter's thank-you", tipPath, 0],
      ["a media kit", "/@localshop/media-kit", 0],
      ["a pre-order", `/@localshop/p/${preorderId}`, 0],
      ["a bundle the buyer builds", `/@localshop/p/${pickId}`, 0],
      ["the notice form", "/report", 0],
      ["the copyright policy", "/copyright", 0],
      ["a post on it", postPath, 0],
      ["the studio's blog", "/studio/blog?edit=new", 1200],
    ];
    await audit.addCookies(await wide.cookies());
    for (const [name, path, width] of pages) is(name, await check(path, width), []);
    await audit.close();
  }

  await keepSmall();
  part("A buyer's photo on a review, and taking it off");
  {
    const product = `${LOCAL}/@localshop/p/${ids["Sunday Baking"]}`;
    await open(page, product);
    const shown = page.locator("#reviews .rv-photo img");
    is("the photo is shown with its review, named for whoever took it", [await shown.count(), await shown.first().getAttribute("alt")], [1, "Photo from Reader 3"]);
    await open(studio, `${LOCAL}/studio/reviews?view=all`);
    const row = studio.locator("li:not([data-mark])", { hasText: "My Sunday mornings smell like bread now." }).first();
    is("the studio shows it too", await row.getByRole("img", { name: "The buyer's photo" }).count(), 1);
    await row.getByRole("button", { name: "Take the photo off" }).click();
    await studio.getByText("Photo taken off the review.").first().waitFor({ timeout: 15_000 });
    await open(page, product);
    is("taken off, the review stays without it", [await page.locator("#reviews .rv-photo").count(), await page.getByText("My Sunday mornings smell like bread now.").count() > 0], [0, true]);
  }

  await keepSmall();
  part("Putting a pre-order on sale hands it over");
  {
    await open(studio, `${LOCAL}/studio`);
    const before = services.emails().length;
    const steps = await studio.evaluate(async ([id]) => {
      const post = (path, body) => fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      const empty = await post("/api/store/waitlist", { action: "launch", id, note: "", address: "" });
      const kept = await post("/api/store/product", { action: "remove", id });
      const linked = await post("/api/store/product", { action: "link", id, link: "https://example.com/bread-book" });
      const launched = await post("/api/store/waitlist", { action: "launch", id, note: "", address: "" });
      return [empty.error, kept.error, linked.ok, launched.ok];
    }, [preorderId]);
    is("not while it has nothing in it, nor deleted while buyers wait; with its link, on sale", steps, ["empty", "preorders", true, true]);
    let out = null;
    for (let i = 0; i < 60 && !out; i += 1) {
      await new Promise((wait) => setTimeout(wait, 500));
      out = services.emails().slice(before).find((email) => email.subject === "It is out: The Bread Book") ?? null;
    }
    is("its buyer is emailed that it is out, at once", [Boolean(out), [].concat(out?.to)[0]], [true, "buyer@example.com"]);
    const link = out?.text.split("\n").find((line) => /\/orders\?/.test(line)) ?? "";
    await open(page, local(link.trim()));
    const row = page.locator("li", { hasText: "The Bread Book" }).first();
    is("and their list of purchases opens it", [(await words(row)).includes("Pre-ordered on"), await row.getByRole("link", { name: /Open|Download/ }).count() > 0], [true, true]);
    await open(page, `${LOCAL}/@localshop/p/${preorderId}`);
    is("from now on it is sold as anything else", await page.locator("#preorder").count(), 0);
  }

  await keepSmall();
  part("A note from the creator after paying");
  {
    const product = ids["Weeknight Dinners"];
    await open(studio, `${LOCAL}/studio/pages?product=${product}`);
    const card = studio.locator("#after-paying");
    await card.getByLabel("Your note").fill("Thank you! Start with the first dinner tonight.\n\n- Read the shopping list\n- Come and say hello");
    await card.getByLabel("Video (optional)").fill("https://example.com/not-a-video.mp4");
    await card.getByRole("button", { name: "Save the note" }).click();
    await card.getByText("That video address is not one we can play.", { exact: false }).waitFor({ timeout: 30_000 });
    is("a video that cannot be played is said, and nothing saved", await card.locator(".tag-live").count(), 0);
    await card.getByLabel("Video (optional)").fill("https://youtu.be/dQw4w9WgXcQ");
    await card.getByLabel("Button words (optional)").fill("Join the group");
    await card.getByLabel("Where the button goes").fill("https://discord.gg/weeknight");
    await card.getByRole("button", { name: "Save the note" }).click();
    await card.locator(".tag-live").waitFor({ timeout: 30_000 });
    is("saved, and on", await words(card.locator(".tag-live")), "On");

    await open(page, `${LOCAL}/@localshop/p/${product}`);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#buy form[data-checkout] button[type=submit]").first().click()]);
    const note = page.locator("section[aria-labelledby=note-title]");
    await note.waitFor({ timeout: 30_000 });
    is("after paying, the buyer reads it under what they bought, in the store's words", [
      /^A note from \S/.test(await words(note.locator("#note-title"))),
      (await words(note)).includes("Start with the first dinner tonight."),
      await note.locator("li").count(),
      await note.getByRole("button", { name: /Play/ }).count() > 0,
      await note.getByRole("link", { name: "Join the group" }).getAttribute("href"),
      await note.getByRole("link", { name: "Join the group" }).getAttribute("target"),
      (await words(note)).includes("discord.gg"),
    ], [true, true, 2, true, "https://discord.gg/weeknight", "_blank", true]);
    let mail = null;
    for (let i = 0; i < 60 && !mail; i += 1) {
      mail = services.emails().find((email) => String(email.text ?? "").includes("Start with the first dinner tonight.")) ?? null;
      if (!mail) await new Promise((wait) => setTimeout(wait, 500));
    }
    is("and in the confirmation email, with the video and the button", [Boolean(mail), String(mail?.text ?? "").includes("Join the group: https://discord.gg/weeknight"), String(mail?.text ?? "").includes("youtube.com/watch?v=dQw4w9WgXcQ")], [true, true, true]);
    if (process.env.E2E_SHOTS) await note.screenshot({ path: join(process.env.E2E_SHOTS, "thanks-note.png") });
    await open(studio, `${LOCAL}/studio/pages?product=${product}`);
    await studio.locator("#after-paying").getByRole("button", { name: "Remove" }).click();
    await studio.locator("#after-paying").getByText("None", { exact: true }).waitFor({ timeout: 30_000 });
  }

  await keepSmall();
  part("A membership's first months for less");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("button", { name: "Add something to sell" }).click();
    await studio.getByLabel("What you are selling").fill("Supper Club");
    await studio.getByLabel("Price", { exact: true }).fill("20");
    await studio.getByLabel("How often it charges").selectOption("month");
    await studio.getByLabel(/^Introductory price/).fill("5");
    await studio.getByLabel("for the first").selectOption("3");
    is("the studio says what the page will say", await words(studio.getByText(/^Your page will say:/)), "Your page will say: $5 a month for the first 3 months, then $20 a month.");
    await studio.getByLabel(/^Free trial/).fill("7");
    await studio.getByRole("button", { name: "Add it" }).click();
    const refused = studio.getByText("A membership starts with one offer: a free trial or an introductory price. Empty one of them.");
    await refused.waitFor({ timeout: 30_000 });
    is("not beside a free trial", await refused.count(), 1);
    await studio.getByLabel(/^Free trial/).fill("");
    await studio.getByRole("button", { name: "Add it" }).click();
    const row = studio.locator("li:not([data-mark])", { hasText: "Supper Club" }).filter({ hasText: "Introductory price, 3 months" });
    await row.first().waitFor({ timeout: 30_000 });
    // Its id, from the link to its page in its row of the studio.
    const club = await studio.evaluate(() => {
      const link = [...document.querySelectorAll("a[href*='/p/']")].find((a) => a.closest("li")?.textContent?.includes("Supper Club"));
      return link ? link.getAttribute("href").split("/p/")[1].split(/[?#]/)[0].split("-").pop() : "";
    });
    is("saved, with its introductory price", club.length > 0, true);
    await studio.evaluate(async (id) => fetch("/api/store/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link", id, link: "https://example.com/supper-club" }) }), club);

    await open(page, `${LOCAL}/@localshop/p/${club}`);
    const buy = page.locator("#buy form[data-checkout] button[type=submit]").first();
    is("the button says the first price, and how long", await words(buy), "Subscribe — $5 a month for the first 3 months");
    is("and the line under it both prices, before anybody pays", (await words(page.locator("#buy"))).includes("$5 a month for the first 3 months, then $20 a month."), true);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), buy.click()]);
    const paid = services.checkouts().at(-1);
    is("Stripe charges the regular price less a coupon for the first 3 months", [paid.mode, paid.amount_total, paid.metadata.intro, paid.discount_coupon], ["subscription", 500, "3", "mm_intro_usd_1500_3"]);
    is("the coupon is made on the creator's account, for 3 months", services.coupons().filter((c) => c.id === "mm_intro_usd_1500_3").map((c) => [c.amount_off, c.duration, c.duration_in_months]), [["1500", "repeating", "3"]]);
    is("and the page after paying says both prices", (await words(page.locator("main"))).includes("for $5 a month for the first 3 months, then $20 a month."), true);
    // The numbers set it beside the sales at full price (lib/discount-impact.ts).
    await open(studio, `${LOCAL}/studio`);
    const discounts = studio.locator("[data-discount-impact]");
    await discounts.waitFor({ timeout: 40_000 });
    const introRow = await words(discounts.locator("tr", { hasText: "Introductory price" }));
    is("the numbers set the introductory price beside full price, with what it took off", [
      await discounts.locator("tr", { hasText: "Full price" }).count(),
      /Introductory price \d+ \$[\d,.]+ \$15/.test(introRow),
    ], [1, true]);
    let mail = null;
    for (let i = 0; i < 60 && !mail; i += 1) {
      mail = services.emails().find((email) => String(email.text ?? "").includes("Supper Club") && /You paid|Paid/.test(String(email.text ?? ""))) ?? null;
      if (!mail) await new Promise((wait) => setTimeout(wait, 500));
    }
    is("and so does the confirmation email", String(mail?.text ?? "").includes("$5 a month for the first 3 months, then $20 a month"), true);
    await studio.evaluate(async (id) => fetch("/api/store/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", id }) }), club);
  }

  await keepSmall();
  part("A monthly membership, or paid yearly for less");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("button", { name: "Add something to sell" }).click();
    await studio.getByLabel("What you are selling").fill("Recipe Club");
    await studio.getByLabel("Price", { exact: true }).fill("20");
    await studio.getByLabel("How often it charges").selectOption("month");
    await studio.getByLabel(/^Or pay yearly/).fill("200");
    is("the studio says what paying yearly saves", (await words(studio.locator("[id^=product-yearly-hint-]").first())).includes("saves $40"), true);
    await studio.getByRole("button", { name: "Add it" }).click();
    await studio.locator("li:not([data-mark])", { hasText: "Recipe Club" }).filter({ hasText: "Or yearly" }).first().waitFor({ timeout: 30_000 });
    const club = await studio.evaluate(() => {
      const link = [...document.querySelectorAll("a[href*='/p/']")].find((a) => a.closest("li")?.textContent?.includes("Recipe Club"));
      return link ? link.getAttribute("href").split("/p/")[1].split(/[?#]/)[0].split("-").pop() : "";
    });
    await studio.evaluate(async (id) => fetch("/api/store/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "link", id, link: "https://example.com/recipe-club" }) }), club);

    await open(page, `${LOCAL}/@localshop/p/${club}`);
    const box = page.locator("#buy");
    const buy = box.locator("form[data-checkout] button[type=submit]").first();
    is("the buyer picks monthly or yearly, with what yearly saves, monthly first", [
      (await words(box)).includes("Monthly $20 a month"),
      (await words(box)).includes("Yearly Save $40 $200 a year"),
      await box.locator("input[name=billing][value=month]").isChecked(),
      await words(buy),
    ], [true, true, true, "Subscribe — $20 a month"]);
    await box.locator("input[name=billing][value=year]").check();
    is("and the button says the year's price once yearly is picked", await words(buy), "Subscribe — $200 a year");
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), buy.click()]);
    const paid = services.checkouts().at(-1);
    is("Stripe charges the year, said on the order", [paid.mode, paid.amount_total, paid.metadata.every], ["subscription", 20000, "year"]);
    is("and the page after paying says a year", (await words(page.locator("main"))).includes("for $200 a year."), true);

    // With a membership on sale, the studio says what members are told when a
    // payment fails (lib/dunning-rules.ts).
    await open(studio, `${LOCAL}/studio`);
    const editor = studio.locator("[data-dunning-editor]");
    is("the setting is in the studio: one email and the card notice, until the creator chooses", [
      await editor.count(),
      await editor.locator("#dunning-reminders").inputValue(),
      await editor.locator("#dunning-card").isChecked(),
    ], [1, "1", true]);
    await editor.locator("#dunning-reminders").selectOption("3");
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/dunning") && r.ok(), { timeout: 30_000 }),
      editor.getByRole("button", { name: "Save" }).click(),
    ]);
    await open(studio, `${LOCAL}/studio`);
    is("three emails, kept", await studio.locator("#dunning-reminders").inputValue(), "3");
    if (process.env.E2E_SHOTS) await studio.locator("[data-dunning-editor]").screenshot({ path: join(process.env.E2E_SHOTS, "dunning-editor.png") });
    is("and the email to members who stopped coming, off until turned on with an address", [await studio.locator("[data-nudge-editor]").count(), await studio.locator("#nudge-on").isChecked()], [1, false]);
    const nudgeRefused = await studio.evaluate(async () => (await fetch("/api/store/nudge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true, address: "" }) })).status);
    is("never on without a postal address", nudgeRefused, 400);
    is("and the email offering monthly members the yearly price, off until turned on with an address", [
      await studio.locator("[data-yearly-ask-editor]").count(),
      await studio.locator("#yearly-ask-on").isChecked(),
      await studio.locator("[data-yearly-none]").count(),
    ], [1, false, 0]);
    const yearlyRefused = await studio.evaluate(async () => (await fetch("/api/store/yearly-ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true, address: "" }) })).status);
    is("that one never on without a postal address either", yearlyRefused, 400);

    // A member paying monthly for Recipe Club moves to yearly from their own page (lib/yearly-switch.ts).
    services.setPauseProduct(club);
    await open(page, `${LOCAL}/@localshop/manage`);
    await page.fill("#manage-email", "pause.member@example.com");
    const askedLink = services.emails().length;
    await Promise.all([page.waitForURL(/status=sent/), page.getByRole("button", { name: "Email me a link to my membership" }).click()]);
    let linkMail = null;
    for (let i = 0; i < 40 && !linkMail; i += 1) {
      linkMail = services.emails().slice(askedLink).find((email) => [email.to].flat().includes("pause.member@example.com") && /token=/.test(String(email.text))) ?? null;
      if (!linkMail) await new Promise((wait) => setTimeout(wait, 250));
    }
    await open(page, local(String(linkMail?.text ?? "").match(/https?:\/\/\S+\/manage\?token=[0-9a-f]{64}/)?.[0] ?? ""));
    const payYearly = page.locator("[data-pay-yearly] a");
    is("the monthly member's page offers paying yearly, with what it saves", await words(payYearly), "Pay yearly: $200 a year, saves $40");
    await Promise.all([page.waitForURL(/to=yearly/), payYearly.click()]);
    is("the next page says what moving charges today, in Stripe's figures, before anything happens", [
      await words(page.locator("[data-yearly-due]")),
      (await words(page.locator("main"))).includes("Saves $40 a year against twelve monthly payments."),
    ], ["$193.33 charged today", true]);
    if (process.env.E2E_SHOTS) await page.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "pay-yearly.png") });
    await Promise.all([page.waitForURL(/status=yearly/), page.getByRole("button", { name: "Switch and pay $193.33" }).click()]);
    const movedYearly = services.subscriptionUpdates().filter((u) => u["items[0][price]"]).at(-1);
    is("the same membership on a yearly price, charged at once, and the page says so", [
      movedYearly?.["items[0][price]"],
      movedYearly?.payment_behavior,
      services.subscriptionUpdates().at(-1)?.["metadata[every]"],
      (await words(page.locator("main"))).includes("You now pay yearly"),
    ], ["price_LocalYearly0001", "pending_if_incomplete", "year", true]);
    services.resetPauseSub();
    is("and beside it, the question asked before members cancel, off until turned on", [await studio.locator("[data-leave-editor]").count(), await studio.locator("#leave-on").isChecked()], [1, false]);
    if (process.env.E2E_SHOTS) await studio.locator("[data-leave-editor]").screenshot({ path: join(process.env.E2E_SHOTS, "leave-editor.png") });
    const refused = await studio.evaluate(async () => (await fetch("/api/store/dunning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reminders: 9, cardNotice: true }) })).status);
    is("a number not offered is refused", refused, 400);
    await studio.evaluate(async () => fetch("/api/store/dunning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reminders: 1, cardNotice: true }) }));
    await studio.evaluate(async (id) => fetch("/api/store/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove", id }) }), club);
  }

  await keepSmall();
  part("What the buyers of a product also bought");
  {
    // The store shows what was bought, as its creator can choose under Look.
    await open(page, `${LOCAL}/@localshop`);
    const look = await page.evaluate(() => {
      const root = document.querySelector(".st-page");
      return { theme: [...(root?.classList ?? [])].find((c) => c.startsWith("st-theme-"))?.slice(9) ?? "light", accent: getComputedStyle(root).getPropertyValue("--st-accent").trim() };
    });
    const setSold = (sold) => studio.evaluate(async ([look, sold]) => (await (await fetch("/api/store/look", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...look, badge: true, sold }) })).json()).ok === true, [look, sold]);
    await open(studio, `${LOCAL}/studio`);
    is("the creator shows what was bought", await setSold(true), true);
    const product = ids["Weeknight Dinners"];
    // Its counts are read from Stripe after a page is sent; then three buyers' worth of
    // pairs is put where that reading keeps them, as many buyers over months would.
    await open(page, `${LOCAL}/@localshop/p/${product}`);
    let key = "";
    for (let i = 0; i < 40 && !key; i += 1) {
      const [scan] = await services.redis([["SCAN", "0", "MATCH", "nl:sold:*", "COUNT", "1000"]]);
      key = (scan?.[1] ?? []).find((k) => !k.includes(":lock:")) ?? "";
      if (!key) await new Promise((wait) => setTimeout(wait, 250));
    }
    await services.redis([["SET", key, JSON.stringify({ at: Date.now(), p: {}, t: { [product]: [[ids["Pantry Checklist"], 4]] } })]]);
    await open(page, `${LOCAL}/@localshop/p/${product}`);
    const section = page.locator("section[aria-labelledby=also-bought-title]");
    is("its page says what its buyers also bought, and how many bought both", [
      await words(section.locator("h2")),
      (await words(section)).includes("Pantry Checklist"),
      (await words(section)).includes("4 buyers bought both"),
      await section.getByRole("link").first().getAttribute("href").then((href) => href?.includes("/p/")),
    ], ["Buyers of Weeknight Dinners also bought", true, true, true]);
    is("and the store's other products under it leave that one out", await page.locator("section[aria-labelledby=more-from-title]").getByText("Pantry Checklist").count(), 0);
    // The cart suggests it too, beside what is in it.
    await page.evaluate(() => window.localStorage.clear());
    await open(page, `${LOCAL}/@localshop/p/${product}`);
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    await page.locator("#cart .st-cart-open").click();
    const cartPanel = page.getByRole("region", { name: "Your cart" });
    await cartPanel.getByText("Often bought with these").waitFor({ timeout: 15_000 });
    is("the open cart offers what the buyers of what is in it also bought", [
      (await words(cartPanel)).includes("Pantry Checklist"),
      (await words(cartPanel)).includes("4 buyers of Weeknight Dinners also bought it"),
    ], [true, true]);
    await cartPanel.getByRole("button", { name: "Add to cart: Pantry Checklist" }).click();
    await cartPanel.getByText("Often bought with these").waitFor({ state: "detached", timeout: 15_000 });
    await cartPanel.locator("ul li a", { hasText: "Pantry Checklist" }).first().waitFor({ timeout: 15_000 });
    is("added with one press, and no longer suggested", [await words(page.locator("#cart .st-cart-open")), (await words(cartPanel)).includes("Pantry Checklist")], ["Cart, 2 products", true]);
    await page.evaluate(() => window.localStorage.clear());
    is("switched off again", await setSold(false), true);
    await open(page, `${LOCAL}/@localshop/p/${product}`);
    is("and the page says nothing about it", await section.count(), 0);
  }

  await keepSmall();
  part("What buyers get next, offered after paying in one press");
  {
    // The studio reads every sale again in the background; then four buyers'
    // worth of later purchases is put where that reading keeps them, as months would.
    await open(studio, `${LOCAL}/studio`);
    let key = "";
    for (let i = 0; i < 60 && !key; i += 1) {
      const [scan] = await services.redis([["SCAN", "0", "MATCH", "nl:next:*", "COUNT", "1000"]]);
      key = (scan?.[1] ?? []).find((k) => !k.includes(":lock:")) ?? "";
      if (!key) await new Promise((wait) => setTimeout(wait, 250));
    }
    const first = ids["Meal Planner"];
    const later = ids["Sunday Baking"];
    await services.redis([["SET", key, JSON.stringify({ at: Date.now(), starts: { [first]: 5 }, next: { [first]: [{ id: later, buyers: 4, days: 12 }] } })]]);
    await open(studio, `${LOCAL}/studio`);
    const paths = studio.locator("#buyer-paths");
    const row = paths.locator("[data-path]").first();
    is("each product, what its buyers bought later, how many and how long after", [
      await words(paths.locator("h2")),
      (await words(row)).includes("Meal Planner"),
      (await words(row)).includes("Sunday Baking"),
      (await words(row)).includes("4 buyers, usually 12 days later"),
      (await words(paths)).includes("Most often bought first: Meal Planner (5 buyers)"),
    ], ["What buyers get next", true, true, true, true]);
    is("and a bundle of the two, started with both in it", (await row.getByRole("link", { name: "Bundle them" }).getAttribute("href"))?.includes(`items=${first},${later}`), true);
    const offerButton = row.getByRole("button", { name: /^Offer it after paying, for / });
    const offerable = (await offerButton.count()) === 1;
    if (offerable) {
      await Promise.all([studio.waitForResponse((r) => r.url().endsWith("/api/store/next-offer") && r.ok(), { timeout: 30_000 }), offerButton.click()]);
      await open(studio, `${LOCAL}/studio/funnels?product=${first}`);
      is("one press: offered in one click after paying, at its own price", (await words(studio.locator("main"))).includes("Sunday Baking"), true);
      await studio.evaluate(async (id) => fetch("/api/store/funnel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, funnel: null }) }), first);
    } else {
      is("where offers after paying exist, it leads to them", (await row.getByRole("link", { name: "Add it to the offers after paying" }).count()) === 1, true);
    }
    await open(studio, `${LOCAL}/studio/bundles?new=1&items=${first},${later}`);
    is("the bundle starts with both", [(await words(studio.locator("main"))).includes("Meal Planner"), (await words(studio.locator("main"))).includes("Sunday Baking")], [true, true]);
  }

  await keepSmall();
  part("A payment plan at each of several prices");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.getByRole("button", { name: "Add something to sell" }).click();
    await studio.getByLabel("What you are selling").fill("Sourdough Guide");
    await studio.getByLabel("Price", { exact: true }).fill("27");
    await studio.getByRole("button", { name: "Add it" }).click();
    await studio.locator("li:not([data-mark])", { hasText: "Sourdough Guide" }).first().waitFor({ timeout: 30_000 });
    const guide = await studio.evaluate(() => {
      const link = [...document.querySelectorAll("a[href*='/p/']")].find((a) => a.closest("li")?.textContent?.includes("Sourdough Guide"));
      return link ? link.getAttribute("href").split("/p/")[1].split(/[?#]/)[0].split("-").pop() : "";
    });
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    await post("/api/store/option", { action: "add", id: guide, label: "1 week", price: "27" });
    await post("/api/store/option", { action: "add", id: guide, label: "5 weeks", price: "39" });
    // The two prices' ids, from the product's own record.
    const [scan] = await services.redis([["SCAN", "0", "MATCH", `nl:catalog:*:l:${guide}`, "COUNT", "100000"]]);
    const [record] = await services.redis([["GET", scan[1][0]]]);
    const [one, five] = JSON.parse(record).options.map((option) => option.id);
    await post("/api/store/product", { action: "link", id: one, link: "https://example.com/sourdough-1" });
    await post("/api/store/product", { action: "link", id: five, link: "https://example.com/sourdough-5" });

    await open(studio, `${LOCAL}/studio`);
    await studio.locator("button[aria-expanded]", { hasText: "Sourdough Guide" }).first().click();
    await studio.getByRole("button", { name: "Offer a payment plan" }).first().click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save the plan" }) });
    const amounts = form.locator("fieldset input[inputmode=decimal]");
    is("one payment for each price, suggested from it", await amounts.evaluateAll((all) => all.map((input) => input.value)), ["9", "13"]);
    await amounts.nth(1).fill("12");
    is("the studio says when a price's payments fall short", (await words(form)).includes("3 of these come to less than $39."), true);
    await form.getByRole("button", { name: "Save the plan" }).click();
    const short = studio.getByText(/^Set a payment for every price/);
    await short.waitFor({ timeout: 30_000 });
    is("and the plan is not saved short", await short.count(), 1);
    await amounts.nth(1).fill("13");
    await form.getByRole("button", { name: "Save the plan" }).click();
    await studio.getByText("Payment plan: 3 monthly payments, from $9 each").waitFor({ timeout: 30_000 });
    is("saved, and said with where it starts", await studio.getByText("Payment plan: 3 monthly payments, from $9 each").count(), 1);

    await open(page, `${LOCAL}/@localshop/p/${guide}`);
    const box = page.locator("#buy");
    const buy = box.locator("form[data-checkout] button[type=submit]").first();
    is("each price says its own payments, and the plan how many", [
      (await words(box)).includes("or 3 monthly payments of $9"),
      (await words(box)).includes("or 3 monthly payments of $13"),
      await words(box.locator("label[for^=pp-]").first()),
    ], [true, true, "3 monthly payments"]);
    is("the page says it can be paid in a plan", (await words(page.locator("main"))).includes("Pay in full, or in 3 monthly payments"), true);
    await box.locator(`input[name=option][value="${five}"]`).check();
    await box.locator("input[name=pay][value=plan]").check();
    is("the button still asks for the price picked", await words(buy), "Continue with this option");
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), buy.click()]);
    const paid = services.checkouts().at(-1);
    is("Stripe charges that price's first payment, in a plan, and keeps which price", [paid.mode, paid.amount_total, paid.metadata.kind, paid.metadata.plan_payments, paid.metadata.option], ["subscription", 1300, "plan", "3", five]);
    await post("/api/store/product", { action: "remove", id: guide });
  }

  await keepSmall();
  part("A certificate, put on LinkedIn and shared as a picture of itself");
  {
    // A certificate as issued (lib/certificate.ts), for a student of the store.
    const cert = "e2ecert000000001";
    const record = { id: cert, store: statsId, productId: ids["Knife Skills"], courseId: "e2ecourse1", name: "Ana Souza", title: "Knife Skills", creator: "Local Shop", email: "ana@example.com", issuedAt: Math.floor(Date.UTC(2026, 9, 10) / 1000), withdrawnAt: 0 };
    await services.redis([["SET", `nl:cert:${cert}`, JSON.stringify(record)]]);
    await open(page, `${LOCAL}/@localshop/certificate/${cert}`);
    const add = new URL(await page.getByRole("link", { name: "Add to LinkedIn profile" }).getAttribute("href"));
    is("the page offers LinkedIn's form, filled in from the record", [add.hostname, add.searchParams.get("name"), add.searchParams.get("organizationName"), add.searchParams.get("certId"), add.searchParams.get("certUrl")?.endsWith(`/@localshop/certificate/${cert}`)], ["www.linkedin.com", "Knife Skills", "Local Shop", cert, true]);
    is("and a post about it, opening in a new tab", [await page.getByRole("link", { name: "Share on LinkedIn" }).getAttribute("target"), (await page.getByRole("link", { name: "Share on LinkedIn" }).getAttribute("href"))?.startsWith("https://www.linkedin.com/sharing/share-offsite/?url=")], ["_blank", true]);
    const og = await page.evaluate(() => document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "");
    const picture = await fetch(og.replace(/^https?:\/\/[^/]+/, LOCAL));
    is("its link unfolds into a picture of the certificate", [picture.status, picture.headers.get("content-type")], [200, "image/png"]);
    if (process.env.E2E_SHOTS) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.E2E_SHOTS}/certificate-card.png`, Buffer.from(await picture.arrayBuffer()));
    }
    const pdfHref = await page.locator("a[data-pdf]").getAttribute("href");
    const pdf = await fetch(`${LOCAL}${pdfHref}`);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    is("and comes as a PDF file to download, drawn from the same record", [pdf.status, pdf.headers.get("content-type"), pdfBytes.subarray(0, 5).toString(), /attachment;/.test(pdf.headers.get("content-disposition") ?? ""), /Knife-Skills-Ana-Souza\.pdf/.test(pdf.headers.get("content-disposition") ?? "")], [200, "application/pdf", "%PDF-", true, true]);
    if (process.env.E2E_SHOTS) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(`${process.env.E2E_SHOTS}/certificate.pdf`, pdfBytes);
    }
    await services.redis([["SET", `nl:cert:${cert}`, JSON.stringify({ ...record, name: "王小明" })]]);
    const elsewhere = await fetch(`${LOCAL}${pdfHref}`, { redirect: "manual" });
    is("a name in a script the file's letters do not cover is sent to the page, which prints it", [elsewhere.status, (elsewhere.headers.get("location") ?? "").endsWith(`/@localshop/certificate/${cert}`)], [303, true]);
    await services.redis([["SET", `nl:cert:${cert}`, JSON.stringify({ ...record, withdrawnAt: Math.floor(Date.now() / 1000) })]]);
    await open(page, `${LOCAL}/@localshop/certificate/${cert}`);
    is("withdrawn, it is offered nowhere, and has no file", [await page.getByRole("link", { name: "Add to LinkedIn profile" }).count(), (await fetch(`${LOCAL}${pdfHref}`)).status], [0, 404]);
  }

  await keepSmall();
  part("A lesson's quiz drafted with AI, the right answer moving around");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Sourdough at Home", price: "40" });
    const bread = made.product?.id ?? "";
    await post("/api/store/course", { action: "enable", id: bread });
    const outlined = await post("/api/store/course", { action: "edit", id: bread, op: "outline", modules: [{ title: "Getting started", lessons: ["Your first starter"] }] });
    // A new course may start with a module of its own: the lesson is found by its title.
    const lessonId = (outlined.course?.modules ?? []).flatMap((m) => m.lessons).find((l) => l.title === "Your first starter")?.id ?? "";
    await post("/api/store/course", { action: "body", id: bread, lessonId, text: "Mix equal weights of flour and water. Feed it every day. It is ready when it doubles." });
    await open(studio, `${LOCAL}/studio/course/${bread}`);
    await studio.locator("li:not([data-mark])", { hasText: "Your first starter" }).getByRole("button", { name: "Edit lesson" }).first().click();
    await studio.getByRole("button", { name: "Add a quiz" }).click();
    const quiz = studio.getByRole("form", { name: "Quiz" });
    await quiz.getByText("Draft questions with AI").click();
    await quiz.locator("select").first().selectOption("3");
    await quiz.getByRole("button", { name: "Write a draft" }).click();
    const said = quiz.locator("details").getByRole("status").or(quiz.locator("details").getByRole("alert"));
    await said.first().waitFor({ timeout: 30_000 });
    const saidWords = await words(said.first());
    if (!saidWords.startsWith("The questions are added below.")) console.log(`        the studio said: ${saidWords}`);
    is("the draft is said to be in", saidWords.startsWith("The questions are added below."), true);
    const texts = await quiz.locator("ol > li textarea").evaluateAll((all) => all.filter((t) => t.id.endsWith("-text")).map((t) => t.value));
    is("the questions are drafted from the lesson, in place of the empty one", texts, ["What goes into a starter?", "How often is it fed?", "When is it ready?"]);
    const places = await quiz.locator("ol > li").evaluateAll((items) => items.map((item) => [...item.querySelectorAll('input[type="radio"][aria-label$="is right"]')].findIndex((input) => input.checked)));
    is("the right answer is never in the same place two questions in a row", places.every((place, i) => place >= 0 && (i === 0 || place !== places[i - 1])), true);
    await quiz.getByRole("button", { name: "Save the quiz" }).click();
    await studio.getByText("3 questions · pass mark 70%").waitFor({ timeout: 30_000 });
    is("and saved by the creator, as they are", await studio.getByText("3 questions · pass mark 70%").count(), 1);
    await post("/api/store/product", { action: "remove", id: bread });
  }

  await keepSmall();
  part("Choosing who gets an email by what they spent, and saving it as a group");
  {
    // lib/segments.ts: the three choices read the store's sales; a group keeps them under a name.
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    await studio.getByText("More ways to choose: what they spent, where they came from, when they last bought").click();
    await studio.getByText(/Nobody has bought yet|Where they were when they first bought/).first().waitFor({ timeout: 30_000 });
    await studio.getByLabel("Spent with you at least").fill("1");
    await studio.getByRole("status").filter({ hasText: /^0 people$/ }).first().waitFor({ timeout: 30_000 });
    is("only buyers can match: on a store nobody has bought from, nobody", await studio.getByRole("status").filter({ hasText: /^0 people$/ }).count() > 0, true);
    await studio.getByLabel("Save who this goes to as a group").fill("Best customers");
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/mail") && r.request().postData()?.includes("segment-save") && r.ok(), { timeout: 30_000 }),
      studio.getByRole("button", { name: "Save group" }).click(),
    ]);
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    const groups = await studio.getByLabel("Saved groups").locator("option").allTextContents();
    is("the group is there the next time, to choose again", groups.includes("Best customers"), true);
    await studio.getByLabel("Saved groups").selectOption({ label: "Best customers" });
    is("and choosing it fills in what was saved", await studio.getByLabel("Spent with you at least").inputValue(), "1.00");
  }

  await keepSmall();
  part("A sequence's emails written with AI, with only the store's links");
  {
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    await studio.getByRole("button", { name: "New sequence" }).click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save the sequence" }) });
    await form.getByText("Write the emails with AI").click();
    await form.locator("details select").first().selectOption("3");
    await form.getByRole("button", { name: "Write a draft" }).click();
    const said = form.locator("details").getByRole("status").or(form.locator("details").getByRole("alert"));
    await said.first().waitFor({ timeout: 30_000 });
    const saidWords = await words(said.first());
    if (!saidWords.startsWith("The emails are in the sequence below.")) console.log(`        the studio said: ${saidWords}`);
    is("the emails are written into the sequence", saidWords.startsWith("The emails are in the sequence below."), true);
    const subjects = await form.locator("ol > li input[maxlength='150']").evaluateAll((all) => all.map((input) => input.value));
    const bodies = await form.locator("ol > li textarea").evaluateAll((all) => all.map((box) => box.value));
    is("each with its subject, in place of the empty one", subjects, ["Welcome to the kitchen", "One trick for busy nights", "What I made for you"]);
    is("and no link that is not the store's", bodies.some((body) => body.includes("elsewhere.example")), false);
    const waits = await form.locator("ol > li input[inputmode='numeric']").evaluateAll((all) => all.map((input) => input.value));
    is("at the pace asked: at once, then 2 and 3 days after", waits, ["0", "2", "3"]);
    await form.getByRole("button", { name: "Close" }).click();
  }

  await keepSmall();
  part("A sequence that stops selling to buyers, and an email only for some");
  {
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    await studio.getByRole("button", { name: "New sequence" }).click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save the sequence" }) });
    await form.getByLabel("Name, for you").fill("Launch with conditions");
    await form.locator("[data-flow-goal-choice]").selectOption("any");
    const subjects = () => form.locator("ol > li input[maxlength='150']");
    const bodies = () => form.locator("ol > li textarea");
    await subjects().nth(0).fill("The doors open");
    await bodies().nth(0).fill("Hello,\n\nThe course is open.");
    await form.getByRole("button", { name: "Add a step" }).click();
    await subjects().nth(1).fill("Still thinking about it?");
    await bodies().nth(1).fill("Hello,\n\nIt closes Friday.");
    const second = form.locator("ol > li").nth(1);
    await second.getByLabel("Send it to").selectOption("lead");
    await second.getByLabel("Everyone else").selectOption("end");
    await form.getByRole("button", { name: "Save the sequence" }).click();
    const row = studio.locator("li:not([data-mark])", { hasText: "Launch with conditions" }).first();
    await row.waitFor({ timeout: 30_000 });
    is("the list says when it ends and who each email is for", [
      await words(row.locator("[data-flow-goal]")),
      (await words(row)).includes("Email 2: Only to those who have not bought anything yet; for the others, the sequence ends there."),
    ], ["Ends for anyone once they have bought something.", true]);
    await row.getByRole("button", { name: "Edit" }).click();
    is("and it opens again as saved", [
      await form.locator("[data-flow-goal-choice]").inputValue(),
      await form.locator("ol > li").nth(1).getByLabel("Send it to").inputValue(),
      await form.locator("ol > li").nth(1).getByLabel("Everyone else").inputValue(),
    ], ["any", "lead", "end"]);
    await form.getByLabel("Starts when").selectOption("bought");
    is("a sequence that starts with a purchase cannot end at one", [await form.locator("[data-flow-goal-choice]").inputValue(), await form.locator("[data-flow-goal-choice] option[value=any]").count()], ["", 0]);
    await form.getByRole("button", { name: "Close" }).click();
    await row.getByRole("button", { name: "Remove" }).click();
    await row.waitFor({ state: "detached", timeout: 30_000 });
  }

  await keepSmall();
  part("Steps that act: a label given, and a sequence that starts with it");
  {
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    // The sequence a label starts, first, so the other can start it too.
    await studio.getByRole("button", { name: "New sequence" }).click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save the sequence" }) });
    await form.getByLabel("Name, for you").fill("The offer");
    await form.getByLabel("Starts when").selectOption("tagged");
    await form.getByLabel("Which label").fill("interested");
    await form.locator("ol > li input[maxlength='150']").nth(0).fill("The course is open");
    await form.locator("ol > li textarea").nth(0).fill("Hello,\n\nThirty dinners.");
    await form.getByRole("button", { name: "Save the sequence" }).click();
    const offerRow = studio.locator("li:not([data-mark])", { hasText: "The offer" }).first();
    await offerRow.waitFor({ timeout: 30_000 });
    is("a sequence that starts with a label says so", (await words(offerRow)).includes("Starts when a sequence gives someone the label “interested”"), true);

    await studio.getByRole("button", { name: "New sequence" }).click();
    await form.getByLabel("Name, for you").fill("Welcome that hands on");
    await form.locator("ol > li input[maxlength='150']").nth(0).fill("Welcome");
    await form.locator("ol > li textarea").nth(0).fill("Hello.");
    await form.getByRole("button", { name: "Add a step" }).click();
    const second = form.locator("ol > li").nth(1);
    await second.locator("[data-step-kind]").selectOption("tag");
    is("a step that acts asks for its label, not for an email", [await second.locator("textarea").count(), await second.getByLabel("The label to give").count()], [0, 1]);
    await second.getByLabel("The label to give").fill("interested");
    await second.getByLabel("Do it for").selectOption("lead");
    await form.getByRole("button", { name: "Add a step" }).click();
    const third = form.locator("ol > li").nth(2);
    await third.locator("[data-step-kind]").selectOption("start");
    is("and another sequence can be started", await third.getByLabel("The sequence to start").locator("option").allTextContents(), ["The offer"]);
    await form.getByRole("button", { name: "Save the sequence" }).click();
    const row = studio.locator("li:not([data-mark])", { hasText: "Welcome that hands on" }).first();
    await row.waitFor({ timeout: 30_000 });
    const listed = await words(row.locator("[data-flow-steps]"));
    is("the list says what each step does, and for whom", [
      (await words(row)).includes("1 email and 2 actions"),
      listed.includes("Step 2: Gives the label “interested”. Only for those who have not bought anything yet; the others skip it."),
      listed.includes("Step 3: Starts the sequence “The offer”."),
    ], [true, true, true]);
    await row.getByRole("button", { name: "Edit" }).click();
    is("and it opens again as saved", [
      await form.locator("ol > li").nth(1).locator("[data-step-kind]").inputValue(),
      await form.locator("ol > li").nth(1).getByLabel("The label to give").inputValue(),
      await form.locator("ol > li").nth(2).locator("[data-step-kind]").inputValue(),
    ], ["tag", "interested", "start"]);
    await form.getByRole("button", { name: "Close" }).click();
    for (const name of ["Welcome that hands on", "The offer"]) {
      const gone = studio.locator("li:not([data-mark])", { hasText: name }).first();
      await gone.getByRole("button", { name: "Remove" }).click();
      await gone.waitFor({ state: "detached", timeout: 30_000 });
    }
  }

  await keepSmall();
  part("A sequence that starts with a form and acts on the store's own people");
  {
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/forms", { form: { name: "Coaching application", fields: [{ id: "q1mail", type: "email", label: "Your email", required: true }], outcomes: [] } });
    await open(studio, `${LOCAL}/studio/email?store=${fresh}`);
    await studio.getByRole("button", { name: "New sequence" }).click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save the sequence" }) });
    await form.getByLabel("Name, for you").fill("Applicants");
    await form.getByLabel("Starts when").selectOption("form");
    is("a form that asks for an address can start it", await form.getByLabel("Which form").locator("option").allTextContents(), ["Coaching application"]);
    await form.locator("ol > li input[maxlength='150']").nth(0).fill("We got your application");
    await form.locator("ol > li textarea").nth(0).fill("Thank you.");
    await form.getByRole("button", { name: "Add a step" }).click();
    const second = form.locator("ol > li").nth(1);
    await second.locator("[data-step-kind]").selectOption("note");
    await second.getByLabel("The note").fill("Applied for coaching");
    await form.getByRole("button", { name: "Add a step" }).click();
    const third = form.locator("ol > li").nth(2);
    await third.locator("[data-step-kind]").selectOption("deal");
    is("a deal goes to one of the board's stages", (await third.getByLabel("The stage").locator("option").allTextContents()).length >= 3, true);
    await form.getByRole("button", { name: "Add a step" }).click();
    await form.locator("ol > li").nth(3).locator("[data-step-kind]").selectOption("notify");
    await form.getByRole("button", { name: "Save the sequence" }).click();
    const row = studio.locator("li:not([data-mark])", { hasText: "Applicants" }).first();
    await row.waitFor({ timeout: 30_000 });
    const listed = await words(row);
    is("saved, and the list says what starts it and what each step does", [
      listed.includes("Starts when someone on your list sends the form “Coaching application”"),
      listed.includes("Writes a note on their page"),
      listed.includes("Puts their deal in a stage of your deals board"),
      listed.includes("Emails you who reached it"),
    ], [true, true, true, true]);
    await row.getByRole("button", { name: "Remove" }).click();
    await row.waitFor({ state: "detached", timeout: 30_000 });
    await post("/api/store/forms", { action: "remove", id: made.form?.id ?? "" });
  }

  await keepSmall();
  part("Which links a buyer uses, asked apart and only after joining");
  {
    await open(studio, `${LOCAL}/studio?store=${fresh}`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Pantry Map", price: "0" });
    const map = made.product?.id ?? "";
    await post("/api/store/product", { action: "link", id: map, link: "https://example.com/pantry-map" });
    await open(page, `${LOCAL}/@freshshop/p/${map}`);
    const form = page.locator('form[action="/api/store/free"]').first();
    const second = form.locator("[data-clicks-box]");
    const before = await second.isVisible();
    await form.locator("input[name=consent]").check();
    const after = await second.isVisible();
    is("a second box, empty, shown only once the box to hear from the creator is checked", [before, after, await second.locator("input").isChecked(), (await words(second)).startsWith("Let Fresh Kitchen see which links")], [false, true, false, true]);
    await post("/api/store/product", { action: "remove", id: map });
  }

  await keepSmall();
  part("A welcome offer with a deadline of each person's own: set, shown with its time, opened at the discount");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const guide = (await post("/api/store/product", { action: "add", title: "Welcome Guide", price: "0" })).product?.id ?? "";
    const course = (await post("/api/store/product", { action: "add", title: "Welcome Course", price: "49" })).product?.id ?? "";
    await post("/api/store/product", { action: "link", id: guide, link: "https://example.com/welcome-guide" });
    await post("/api/store/product", { action: "link", id: course, link: "https://example.com/welcome-course" });
    const saved = await post("/api/store/welcome-offer", { product: course, percent: 25, hours: 48, remind: true, address: "1 Main St, Austin, TX 78701" });
    is("saved, with a coupon made on the creator's own Stripe account", [saved.ok, saved.welcomeOffer?.percent, /^coupon_|^[A-Za-z0-9_-]{3,}$/.test(saved.welcomeOffer?.coupon ?? "")], [true, 25, true]);
    await open(studio, `${LOCAL}/studio`);
    const editor = studio.locator("[data-welcome-offer-editor]");
    is("the studio shows it on", [await editor.count(), (await words(editor)).includes("On")], [1, true]);

    const lead = "welcome.lead@example.com";
    await open(page, `${LOCAL}/@localshop/p/${guide}`);
    const form = page.locator('form[action="/api/store/free"]').first();
    await form.locator('input[name="email"]').fill(lead);
    await form.locator("input[name=consent]").check();
    await Promise.all([page.waitForURL(/status=sent/, { timeout: 60_000 }), form.locator("button[type=submit]").click()]);
    const mail = services.emails().filter((email) => [].concat(email.to).includes(lead)).at(-1);
    const link = mail?.text.match(/https?:\/\/\S+\/free\?token=[0-9a-f]{64}/)?.[0] ?? "";
    await open(page, local(link));
    const box = page.locator("[data-welcome-offer]");
    await box.locator("[data-welcome-left]").waitFor({ timeout: 30_000 });
    const left = await words(box.locator("[data-welcome-left]"));
    is("the page the copy is picked up from offers it, with the time left counting down", [(await words(box)).includes("25% off Welcome Course"), /^Ends in 4[78]:\d\d:\d\d$/.test(left)], [true, true]);
    if (process.env.E2E_SHOTS) await box.screenshot({ path: join(process.env.E2E_SHOTS, "welcome-offer.png") });
    const token = new URL(local(link)).searchParams.get("token") ?? "";
    const opened = await page.request.post(`${LOCAL}/api/store/welcome/open`, { form: { handle: "localshop", token }, maxRedirects: 0, headers: { Origin: LOCAL } });
    const session = services.checkouts().at(-1);
    is("its button opens the checkout with the discount, for that address, as a welcome offer", [opened.status(), session?.discount_coupon === saved.welcomeOffer?.coupon, session?.customer_details?.email, session?.metadata?.welcome], [303, true, lead, "yes"]);
    await open(studio, `${LOCAL}/studio`);
    is("and the studio counts the person offered", (await words(studio.locator("[data-welcome-offer-editor]"))).includes("Offered so far: 1."), true);
    await post("/api/store/welcome-offer", { percent: 0 });
    for (const id of [guide, course]) await post("/api/store/product", { action: "remove", id });
  }

  await keepSmall();
  part("A form whose questions branch: the questions follow the answers, and what is skipped is not kept");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const saved = await post("/api/store/forms", {
      form: {
        name: "Coaching application",
        fields: [
          { id: "q1aaaa", type: "choice", label: "Have you sold online before?", required: true, options: [{ id: "yes001", label: "Yes", outcome: "", next: "q3cccc" }, { id: "no0001", label: "No", outcome: "" }, { id: "skip01", label: "Just looking", outcome: "", next: "end" }] },
          { id: "q2bbbb", type: "short", label: "What would you sell?", required: true },
          { id: "q3cccc", type: "short", label: "What do you sell now?", required: true },
        ],
        outcomes: [],
        doneHeading: "Thank you",
        doneBody: "",
      },
    });
    const formId = saved.form?.id ?? "";
    is("saved with its branches", [saved.ok, saved.form?.fields?.[0]?.options?.map((o) => o.next ?? "")], [true, ["q3cccc", "", "end"]]);
    const pageId = (await post("/api/store/site-page", { action: "add", title: "Apply", slug: "apply" })).id ?? "";
    const pageSaved = await post("/api/store/site-page", { action: "save", id: pageId, page: { blocks: [{ id: "apply01", kind: "form", heading: "Apply", form: formId }], hidden: false } });
    is("placed on a page of the store's own", pageSaved.ok, true);
    await open(page, `${LOCAL}/@localshop/apply`);
    const shown = async () => page.locator("[data-field]").evaluateAll((all) => all.filter((el) => !el.hidden).map((el) => el.getAttribute("data-field")));
    is("before any answer, every question", await shown(), ["q1aaaa", "q2bbbb", "q3cccc"]);
    await page.getByRole("radio", { name: "Yes" }).check();
    is("yes skips the second question", await shown(), ["q1aaaa", "q3cccc"]);
    await page.getByRole("radio", { name: "Just looking" }).check();
    is("just looking ends the form there", await shown(), ["q1aaaa"]);
    await page.getByRole("radio", { name: "Yes" }).check();
    await page.getByLabel("What do you sell now?").fill("Cookbooks");
    await Promise.all([page.waitForLoadState("networkidle"), page.locator(`#form-${formId} button[type=submit]`).click()]);
    const csv = await studio.evaluate(async (id) => (await fetch(`/api/store/forms/export?id=${id}`)).text(), formId);
    is("sent: the answers asked are kept, the skipped one is empty", csv.split("\r\n")[1]?.split(",").slice(1, 4), ["Yes", "", "Cookbooks"]);
    await post("/api/store/site-page", { action: "remove", id: pageId });
    await post("/api/store/forms", { action: "remove", id: formId });
  }

  await keepSmall();
  part("A chat on the store, answered from the studio's inbox, the answer in the chat and by email");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    await open(page, `${LOCAL}/@localshop`);
    is("no chat until it is turned on", await page.locator(".st-chat").count(), 0);
    const on = await post("/api/store/inbox", { action: "chat", on: true });
    is("turned on", [on.ok, on.inbox?.chat], [true, true]);

    const visitor = "chat.visitor@example.com";
    await open(page, `${LOCAL}/@localshop`);
    await page.locator(".st-chat button[aria-expanded]").click();
    const panel = page.locator(".st-chat [role=dialog]");
    await panel.getByLabel("Your email").fill(visitor);
    await panel.getByLabel("Your name (optional)").fill("Vee Visitor");
    await panel.getByLabel("Your message").fill("Does the course include the recipes as a PDF?");
    await panel.getByRole("button", { name: "Send" }).click();
    await panel.locator("[data-chat-thread]").getByText("Does the course include the recipes as a PDF?").waitFor({ timeout: 30_000 });
    is("sent from the store's page, and said where the answer goes", (await words(panel)).includes("The answer shows here, and goes to your email too."), true);
    const tellMail = services.emails().filter((email) => /^New message from Vee Visitor on /.test(email.subject ?? "")).at(-1);
    is("the creator is told by email, with the way to the inbox", /\/studio\/inbox\?(store=[^&]+&)?c=[a-z0-9]{12}/.test(tellMail?.text ?? ""), true);

    await open(studio, `${LOCAL}/studio/inbox`);
    await studio.locator("[data-inbox-list]").getByText("Vee Visitor").first().click();
    const thread = studio.locator("[data-inbox-thread]");
    await thread.getByText("Does the course include the recipes as a PDF?").waitFor({ timeout: 30_000 });
    const saved = await post("/api/store/inbox", { action: "saved", saved: [{ id: "pdf001", title: "PDF", text: "Yes, every recipe comes as a PDF too." }] });
    is("a saved reply kept", saved.inbox?.saved?.map((s) => s.title), ["PDF"]);
    await thread.getByLabel("Your answer").fill("Yes, every recipe comes as a PDF too.");
    await thread.getByRole("button", { name: "Send the answer" }).click();
    await studio.getByText(`Sent: in their chat, and emailed to ${visitor}.`).first().waitFor({ timeout: 30_000 });
    if (process.env.E2E_SHOTS) await studio.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "inbox-studio.png") });

    const answerMail = services.emails().filter((email) => [].concat(email.to).includes(visitor)).at(-1);
    const back = answerMail?.text.match(/https?:\/\/\S+\/@localshop\?chat=[A-Za-z0-9_-]{32}/)?.[0] ?? "";
    is("the answer is emailed to the visitor alone, with the way back to the chat", [answerMail?.subject?.endsWith("answered your message"), Boolean(back), answerMail?.text.includes("Yes, every recipe comes as a PDF too.")], [true, true, true]);
    await open(page, local(back));
    const reopened = page.locator(".st-chat [data-chat-thread]");
    await reopened.getByText("Yes, every recipe comes as a PDF too.").waitFor({ timeout: 30_000 });
    is("the link opens the conversation with the answer in it", (await words(reopened)).includes("Does the course include the recipes as a PDF?"), true);
    if (process.env.E2E_SHOTS) await page.locator(".st-chat").screenshot({ path: join(process.env.E2E_SHOTS, "store-chat.png") });

    await post("/api/store/inbox", { action: "saved", saved: [] });
    const off = await post("/api/store/inbox", { action: "chat", on: false });
    await open(page, `${LOCAL}/@localshop`);
    is("turned off, it is gone from the store", [off.inbox?.chat, await page.locator(".st-chat").count()], [false, 0]);
  }

  await keepSmall();
  part("A page of the store's own, in its menu and on its address");
  {
    await open(studio, `${LOCAL}/studio/site?store=${fresh}`);
    await studio.locator("nav[aria-label='Your pages']").getByRole("button", { name: "About", exact: true }).click();
    await studio.locator("#page-title").filter({ hasText: "About" }).waitFor({ timeout: 30_000 });
    is("started from its blocks, out of sight until it is switched on", [await studio.getByRole("checkbox", { name: /Visitors see this page/ }).isChecked(), await studio.locator("[data-site-page-settings]").count()], [false, 1]);
    await studio.getByRole("checkbox", { name: /Visitors see this page/ }).check();
    await studio.getByRole("button", { name: "Save the page" }).click();
    await studio.getByText("Page saved.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@freshshop/about`);
    is("on its address, in the store's look, with the store's menu", [
      await page.locator("main[data-site-page='about']").count(),
      (await words(page.locator("main[data-site-page='about']"))).includes("About"),
      await page.locator("[data-store-pages] a[aria-current='page']").count(),
    ], [1, true, 1]);
    await open(page, `${LOCAL}/@freshshop`);
    is("and in the menu at the top of the store", await page.locator("[data-store-pages] a", { hasText: "About" }).count(), 1);
    await open(page, `${LOCAL}/@freshshop/no-such-page`);
    is("an address that is no page is not found", (await page.locator("main[data-site-page]").count()), 0);
  }

  await keepSmall();
  part("A funnel of pages: made in the studio, walked from its address, through paying");
  {
    await open(studio, `${LOCAL}/studio/funnels`);
    await studio.getByRole("button", { name: "New funnel" }).click();
    await studio.locator("#pf-name").fill("Launch");
    await studio.locator("#pf-step-0").selectOption({ value: `product:${ids["Pantry Checklist"]}` });
    await studio.getByRole("button", { name: /Add a step/ }).click();
    await studio.locator("#pf-step-1").selectOption({ value: `product:${ids["Sunday Baking"]}` });
    is("its address made from its name", await studio.locator("#pf-slug").inputValue(), "launch");
    await studio.getByRole("button", { name: "Make the funnel" }).click();
    await studio.getByText("Funnel made.").first().waitFor({ timeout: 30_000 });
    await studio.locator("section[aria-labelledby='page-funnels-title'] li", { hasText: "Launch" }).first().waitFor({ timeout: 30_000 });
    is("listed with its address and its two steps", [
      (await words(studio.locator("section[aria-labelledby='page-funnels-title']"))).includes("/@localshop/go/launch"),
      await studio.locator("section[aria-labelledby='page-funnels-title'] ol > li").count(),
    ], [true, 2]);

    await open(page, `${LOCAL}/@localshop/go/launch?utm_source=newsletter`);
    const entered = new URL(page.url());
    const mark = entered.searchParams.get("f") ?? "";
    is("the address opens the first step, with the funnel's mark and the link's tags", [entered.pathname.includes(ids["Pantry Checklist"]), /^[a-z0-9]{10}$/.test(mark), entered.searchParams.get("utm_source")], [true, true, "newsletter"]);
    const skip = page.getByRole("link", { name: "No thanks, continue" });
    is("a paid step says how to go on without buying", [await skip.count(), (await skip.getAttribute("href"))?.includes(ids["Sunday Baking"]) && (await skip.getAttribute("href"))?.endsWith(`f=${mark}`)], [1, true]);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#buy form[action='/api/store/checkout'] button[type=submit]").first().click()]);
    await page.waitForLoadState("networkidle");
    is("the checkout carries the funnel, from the page it was opened on", services.checkouts().at(-1).metadata.funnel, mark);
    const next = page.getByRole("link", { name: "Continue" });
    is("after paying, what was bought first, then the way on", [
      (await words(page.locator("main"))).includes("You bought Pantry Checklist"),
      await page.locator("#funnel-next").count(),
      (await next.getAttribute("href"))?.includes(ids["Sunday Baking"]),
    ], [true, 1, true]);
    await Promise.all([page.waitForURL(new RegExp(ids["Sunday Baking"]), { timeout: 60_000 }), next.click()]);
    await page.waitForLoadState("networkidle");
    is("the last step, with nothing after it to skip to", [new URL(page.url()).searchParams.get("f"), await page.getByRole("link", { name: "No thanks, continue" }).count()], [mark, 0]);

    await open(studio, `${LOCAL}/studio/funnels`);
    const counted = await words(studio.locator("section[aria-labelledby='page-funnels-title'] ol").first());
    // Who opened each step is counted by the page in a browser that is not a
    // robot's (tests/page-funnel.test.ts holds it): this one calls itself
    // headless, so only the payment, counted by the thank-you page, shows here.
    is("counted step by step: the payment at the first step", [/opened it · 1 paid/.test(counted), (counted.match(/opened it/g) ?? []).length], [true, 2]);
  }

  await keepSmall();
  part("Short links for posts: made in the studio, opened, sent somewhere else, ended");
  {
    await open(studio, `${LOCAL}/studio`);
    const share = studio.locator("details", { has: studio.locator("[data-short-links]") });
    await share.locator("summary").first().click();
    const box = studio.locator("[data-short-links]");
    await box.getByLabel("Name of the post").fill("October Reel!");
    is("the name is shown as it is counted", await box.getByText("Counted as “october-reel”.").count(), 1);
    await box.getByLabel("Where you post it").selectOption("tiktok");
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/short-links") && r.ok(), { timeout: 30_000 }),
      box.getByRole("button", { name: "Make a short link" }).click(),
    ]);
    const short = await box.getByLabel("Short link for october-reel").inputValue();
    is("a short address of six letters", /^https:\/\/marktmorgen\.com\/l\/[a-hj-km-np-z2-9]{6}$/.test(short), true);
    await box.getByRole("button", { name: "QR code" }).click();
    is("with its own QR code", await box.getByRole("img", { name: "QR code that opens the link for october-reel" }).count(), 1);
    const sent = await studio.request.get(local(short), { maxRedirects: 0 });
    const to = sent.headers().location ?? "";
    is("it opens the store, tagged with where it was posted and the post's name, and the CDN keeps it", [sent.status(), to.endsWith("/@localshop?utm_source=tiktok&utm_medium=post&utm_campaign=october-reel"), /s-maxage=300/.test(sent.headers()["cache-control"] ?? "")], [302, true, true]);
    await open(page, local(to));
    is("and the store opens", await page.locator('form[action="/api/store/checkout"]').count() > 0, true);
    const line = box.locator("li", { hasText: "october-reel" });
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/short-links") && r.ok(), { timeout: 30_000 }),
      line.getByLabel("Goes to").selectOption({ label: "Knife Skills" }),
    ]);
    const moved = (await studio.request.get(local(short), { maxRedirects: 0 })).headers().location ?? "";
    is("sent to a product instead, the same link", moved.includes(`/@localshop/p/${ids["Knife Skills"]}?utm_source=tiktok`), true);
    if (process.env.E2E_SHOTS) await box.screenshot({ path: join(process.env.E2E_SHOTS, "short-links.png") });
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/short-links") && r.ok(), { timeout: 30_000 }),
      line.getByRole("button", { name: "End the link for october-reel" }).click(),
    ]);
    const endedTo = (await studio.request.get(local(short), { maxRedirects: 0 })).headers().location ?? "";
    await open(page, local(endedTo));
    is("ended, it says so", [endedTo.endsWith("/l/ended"), await page.getByRole("heading", { name: "This link has ended" }).count()], [true, 1]);
  }

  await keepSmall();
  part("Discord: a server connected in the studio, a product giving a role, a buyer let in");
  {
    // Discord's page is another site: a form's redirect to it is followed here by hand, as a browser would.
    const follow = async (who, path, form) => {
      const answer = await who.request.post(`${LOCAL}${path}`, { form, maxRedirects: 0, headers: { Origin: LOCAL } });
      return answer.headers().location ?? "";
    };
    await open(studio, `${LOCAL}/studio/discord`);
    is("the studio offers to connect a server", await studio.getByRole("button", { name: "Connect a Discord server" }).count(), 1);
    const toDiscord = await follow(studio, "/api/store/discord/connect", {});
    is("the creator is sent to Discord's page to add the bot, with roles and nothing more", [new URL(toDiscord).searchParams.get("scope"), new URL(toDiscord).searchParams.get("permissions")], ["identify bot", "268435459"]);
    await open(studio, toDiscord);
    await studio.getByText("Fresh Kitchen Club").first().waitFor({ timeout: 30_000 });
    is("and comes back with the server connected", [studio.url().includes("discord=connected"), await studio.getByText("Connected", { exact: true }).count()], [true, 1]);
    // Something the buyer bought for themselves, paid once: not a gift, not places for several.
    const bought = services.checkouts().find((c) => c.customer_details?.email === "buyer@example.com" && c.mode === "payment" && c.metadata?.product && !c.metadata.gift && !c.metadata.group && !c.metadata.preorder && !c.metadata.bumps);
    const title = Object.entries(ids).find(([, id]) => id === bought?.metadata?.product)?.[0] ?? "";
    const planner = studio.locator("li", { has: studio.locator("legend", { hasText: title }) }).first();
    await planner.getByRole("checkbox", { name: "Members" }).check();
    await planner.getByRole("button", { name: "Save" }).click();
    await planner.getByText("Gives 1 role.").waitFor({ timeout: 30_000 });
    is("the product gives the role the bot can give, and only those are offered", [await planner.getByText("Gives 1 role.").count(), await planner.getByRole("checkbox", { name: "Marktmorgen" }).count()], [1, 0]);

    await open(page, `${LOCAL}/@localshop/thanks?session_id=${bought?.id ?? ""}`);
    is("the buyer is offered the way in after paying", await page.getByRole("button", { name: "Join the Discord" }).count(), 1);
    const toJoin = await follow(page, "/api/store/discord/join", { handle: "localshop", session_id: bought?.id ?? "" });
    is("and is sent to Discord's page, asked only who they are and to be put in a server", new URL(toJoin).searchParams.get("scope"), "identify guilds.join");
    await open(page, toJoin);
    await page.locator("[data-discord-status]").waitFor({ timeout: 30_000 });
    const { calls, ids: d } = services.discord();
    is("they are in, with the product's role", [await page.locator("[data-discord-status]").getAttribute("data-discord-status"), calls.includes(`PUT /guilds/${d.server}/members/${d.buyer}`)], ["joined", true]);
    is("with the way to open the server", await page.getByRole("link", { name: "Open Discord" }).getAttribute("href"), `https://discord.com/channels/${d.server}`);
    const stranger = await follow(page, "/api/store/discord/join", { handle: "localshop", session_id: "cs_test_nobody" });
    is("an order that is not paid opens nothing", stranger.endsWith("/@localshop/discord?status=none"), true);
    await open(studio, `${LOCAL}/studio/discord`);
    is("the studio lists who joined", (await words(studio.locator("table"))).includes("buyer@example.com"), true);
    await studio.evaluate(async () => fetch("/api/store/discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "disconnect" }) }));
  }

  await keepSmall();
  part("An assignment on a lesson: set in the studio, shown on the lesson, closed to strangers");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Copywriting Workshop", price: "60" });
    const workshop = made.product?.id ?? "";
    await post("/api/store/course", { action: "enable", id: workshop });
    const outlined = await post("/api/store/course", { action: "edit", id: workshop, op: "outline", modules: [{ title: "Week one", lessons: ["Your opening line", "Your offer"] }] });
    const lessons = (outlined.course?.modules ?? []).flatMap((m) => m.lessons);
    const lessonId = lessons.find((l) => l.title === "Your opening line")?.id ?? "";
    await open(studio, `${LOCAL}/studio/course/${workshop}`);
    await studio.locator("li:not([data-mark])", { hasText: "Your opening line" }).getByRole("button", { name: "Edit lesson" }).first().click();
    await studio.getByRole("button", { name: "Add an assignment" }).click();
    const form = studio.getByRole("form", { name: "Assignment" });
    await form.getByLabel("What the student does").fill("Write the first line of your own sales page, and say who it is for.");
    await form.getByRole("checkbox", { name: /Students must finish it to go on/ }).check();
    await form.getByRole("button", { name: "Save the assignment" }).click();
    await studio.getByText("you read and approve each one · must be finished to go on · a file may be added").waitFor({ timeout: 30_000 });
    is("saved with its switches, and the quiz makes way for it", [
      await studio.getByText("you read and approve each one · must be finished to go on · a file may be added").count(),
      await studio.getByRole("button", { name: "Add a quiz" }).count(),
    ], [1, 0]);
    const quizToo = await post("/api/store/course", { action: "quiz", id: workshop, lessonId, quiz: { passPercent: "70", attempts: "", required: false, questions: [{ text: "Q?", kind: "single", choices: ["A", "B"], correct: [0], explanation: "" }] } });
    is("a quiz on the same lesson is refused", quizToo.error, "task_there");
    await open(studio, `${LOCAL}/studio/course/${workshop}`);
    is("the studio keeps a place for the work handed in", (await words(studio.locator("#work"))).includes("Nothing is waiting."), true);
    const student = await studio.getByRole("link", { name: "See it as a student does" }).getAttribute("href");
    await open(studio, `${LOCAL}${student}/${lessonId}`);
    const section = studio.locator("#task");
    is("the creator sees it on the lesson as students do, and where to read their work", [
      (await words(section)).includes("Write the first line of your own sales page"),
      (await words(section)).includes("You read it in your studio"),
      await section.locator("textarea").count(),
    ], [true, true, 0]);
    const handle = (student ?? "").split("/")[1]?.replace(/^@/, "") ?? "";
    await open(page, `${LOCAL}/@${handle}`);
    const stranger = await page.evaluate(async ([handle, product, lesson]) => {
      const handIn = await fetch("/api/store/course/task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle, product, lesson, text: "Mine", file: null }) });
      const door = await fetch("/api/store/course/task/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "blob.generate-presigned-url", payload: { pathname: "x.pdf", clientPayload: JSON.stringify({ handle, product, lesson, type: "application/pdf" }), multipart: false } }) });
      const file = await fetch(`/api/store/course/task?h=${handle}&p=${product}&l=${lesson}`);
      return [handIn.status, door.status, file.status];
    }, [handle, workshop, lessonId]);
    is("somebody who has not bought it can hand in nothing, upload nothing and download nothing", stranger, [403, 403, 403]);
    await post("/api/store/product", { action: "remove", id: workshop });
  }

  await keepSmall();
  part("Lessons from many videos at once: each named after its file, none left empty when one cannot go");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Sourdough Weekends", price: "49" });
    const course = made.product?.id ?? "";
    await post("/api/store/course", { action: "enable", id: course });
    await post("/api/store/course", { action: "edit", id: course, op: "module-add", title: "The first loaf" });
    await open(studio, `${LOCAL}/studio/course/${course}`);
    const input = studio.getByLabel("Add lessons from videos to module 1");
    is("each module offers it, saying what happens", (await words(studio.locator("section", { has: input }))).includes("Each becomes a lesson at the end of this module, named after its file, in the order of the file names."), true);
    // The video service answers that it cannot take videos just now: the first lesson is made, then taken away again.
    await studio.route("**/api/store/stream", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: "video_unavailable" }) }));
    const clip = (name, mimeType = "video/mp4") => ({ name, mimeType, buffer: Buffer.from("not really a video") });
    await input.setInputFiles([clip("02 - Shaping.mp4"), clip("01_Mixing.mp4"), clip("notes.txt", "text/plain")]);
    const report = studio.getByRole("alert").filter({ hasText: "None of these became a lesson" });
    await report.waitFor({ timeout: 60_000 });
    const lines = await report.locator("li").allInnerTexts();
    is("the files are told apart, in the order of their names, each with its reason", lines, [
      "notes.txt · This type does not play in every browser. Upload it as an MP4, a MOV or a WebM.",
      "01_Mixing.mp4 · Videos cannot be taken in just now. Try again in a few minutes.",
      "02 - Shaping.mp4 · Not sent, because the video before it could not go.",
    ]);
    await studio.unroute("**/api/store/stream");
    await open(studio, `${LOCAL}/studio/course/${course}`);
    is("and no empty lesson is left behind", await studio.getByRole("button", { name: "Edit lesson" }).count(), 0);
    await post("/api/store/product", { action: "remove", id: course });
  }

  await keepSmall();
  part("Members moved from another platform: a link of their own, first charged on the day it would have renewed");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Harbor Circle", price: "15", every: "month" });
    const circle = made.product?.id ?? "";
    await post("/api/store/product", { action: "link", id: circle, link: "https://example.com/harbor-circle" });
    await open(studio, `${LOCAL}/studio/import?what=members`);
    const renews = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const csv = `Email,Membership,Next Charge Date,Tier\r\nmover@example.com,Harbor Circle,${renews},\r\nnobody@example.com,Harbor Circle,04/05/2026,\r\n`;
    await studio.locator("#file-members").setInputFiles({ name: "patrons.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    is("the columns are found by the names other platforms give them", [
      await studio.locator("#map-members-email option:checked").innerText(),
      await studio.locator("#map-members-renews option:checked").innerText(),
      await studio.locator("#map-members-option option:checked").innerText(),
    ], ["Email", "Next Charge Date", "Tier"]);
    is("each date is shown with its month in letters, and one that reads two ways says so", [
      (await words(studio.locator("table"))).includes(new Date(`${renews}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })),
      (await words(studio.locator("table"))).includes("04/05/2026: choose how dates are written"),
    ], [true, true]);
    await studio.locator("#import-stopped").check();
    await studio.getByRole("button", { name: "Import 2 rows" }).click();
    is("nothing starts until the file's way of writing dates is chosen from the list", await studio.getByRole("alert").filter({ hasText: "Choose how this file writes dates" }).count(), 1);
    is("the list says what each choice makes of the date", await studio.locator("#import-date-order option").allInnerTexts(), ["Choose one", "Month first: 04/05/2026 is Apr 5, 2026", "Day first: 04/05/2026 is May 4, 2026"]);
    await studio.locator("#import-date-order").selectOption("dmy");
    is("and the date is shown again as it will be read", (await words(studio.locator("table"))).includes("May 4, 2026 (04/05/2026)"), true);
    await studio.locator("#import-stopped").uncheck();
    await studio.getByRole("button", { name: "Import 2 rows" }).click();
    is("nothing starts until the old renewals are promised to stop", await studio.getByRole("alert").filter({ hasText: "stop these memberships renewing" }).count(), 1);
    await studio.locator("#import-stopped").check();
    await studio.getByRole("button", { name: "Import 2 rows" }).click();
    // This import's own card, once it is over (the column beside it lists earlier imports, finished long ago).
    const card = studio.locator("section [aria-live=polite]").filter({ hasText: "invited to move" }).filter({ hasText: "Finished" });
    await card.first().waitFor({ timeout: 120_000 });
    is("one member invited, and the May date, long past, not invited", [
      await card.first().locator("dt", { hasText: "invited to move" }).locator("xpath=following-sibling::dd").innerText(),
      await card.first().locator("dt", { hasText: "could not be read" }).locator("xpath=following-sibling::dd").innerText(),
    ], ["1", "1"]);
    let invite = null;
    for (let i = 0; i < 60 && !invite; i += 1) {
      invite = services.emails().find((email) => [].concat(email.to).includes("mover@example.com")) ?? null;
      if (!invite) await new Promise((wait) => setTimeout(wait, 500));
    }
    is("the member is emailed their own link", /\/move\/[A-Za-z0-9_-]+\?k=[0-9a-f]{40}/.test(String(invite?.text ?? "")), true);
    const link = String(invite?.text ?? "").match(/https?:\/\/\S+\/move\/\S+/)?.[0] ?? "";
    await open(page, local(link));
    is("their page says nothing is charged today, and when the first payment is", [
      await page.locator("[data-move]").getAttribute("data-move"),
      (await words(page.locator("main"))).includes("Nothing is charged today. Your first payment here, $15, is taken on"),
      (await words(page.locator("main"))).includes("This link is for mover@example.com."),
    ], ["open", true, true]);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.getByRole("button", { name: "Keep my membership" }).click()]);
    const kept = services.checkouts().at(-1);
    const due = Math.floor(Date.parse(`${renews}T12:00:00Z`) / 1000);
    is("Stripe takes the card now and first charges it on the renewal date, for their address", [kept.trial_end, kept.metadata.moved, kept.customer_details.email, kept.amount_total], [String(due), "yes", "mover@example.com", 0]);
    is("the page after says the membership moved, and that nothing was charged", [
      (await words(page.locator("main"))).includes("Membership moved"),
      (await words(page.locator("main"))).includes("Nothing was charged today"),
    ], [true, true]);
    let receipt = null;
    for (let i = 0; i < 60 && !receipt; i += 1) {
      receipt = services.emails().find((email) => [].concat(email.to).includes("mover@example.com") && String(email.text ?? "").includes("Harbor Circle") && String(email.text ?? "").includes("first payment here of $15")) ?? null;
      if (!receipt) await new Promise((wait) => setTimeout(wait, 500));
    }
    is("and the confirmation email says when the first payment is taken", String(receipt?.text ?? "").includes("Nothing was charged today. Your first payment here of $15"), true);
    await open(page, `${LOCAL}/@localshop/move/${circle}?k=${"f".repeat(40)}`);
    is("a made-up link opens nothing", await page.locator("[data-move]").getAttribute("data-move"), "closed");
    await post("/api/store/product", { action: "remove", id: circle });
  }

  await keepSmall();
  part("A key that writes: list, labels and a product given from a creator's own tool");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Larder Labels", price: "7" });
    const checklist = made.product?.id ?? "";
    await post("/api/store/product", { action: "link", id: checklist, link: "https://example.com/larder" });
    await open(studio, `${LOCAL}/studio#api`);
    const panel = studio.locator("#api");
    await panel.getByLabel("What will use it").fill("Reader");
    await panel.getByRole("button", { name: "Make a key" }).click();
    const readKey = await panel.locator("#api-key").inputValue();
    await panel.getByRole("button", { name: "I have kept it" }).click();
    await panel.getByLabel("What will use it").fill("Zapier");
    await panel.locator("#api-key-write").check();
    await panel.getByRole("button", { name: "Make a key" }).click();
    const writeKey = await panel.locator("#api-key").inputValue();
    await panel.getByRole("button", { name: "I have kept it" }).click();
    is("the studio says which key writes", [
      (await words(panel.locator("li", { hasText: "Zapier" }))).includes("Reads and writes"),
      (await words(panel.locator("li", { hasText: "Reader" }))).includes("Reads only"),
    ], [true, true]);
    const api = async (method, path, key, data) => {
      const response = await page.request.fetch(`${LOCAL}/api/v1/${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, data });
      return [response.status(), await response.json()];
    };
    is("a key made to read cannot write", (await api("POST", "leads", readKey, { email: "zap@example.com", agreed: true }))[1].error, "read_only");
    is("nobody is added without the caller's word that they agreed", (await api("POST", "leads", writeKey, { email: "zap@example.com" }))[1].error, "consent");
    is("added to the list", (await api("POST", "leads", writeKey, { email: "zap@example.com", tags: ["webinar"], agreed: true }))[1].data, { email: "zap@example.com", status: "added" });
    is("and labeled", (await api("POST", "leads/labels", writeKey, { email: "zap@example.com", add: ["vip"] }))[1].data.labels, ["webinar", "vip"]);
    const given = await api("POST", "access", writeKey, { email: "zap@example.com", product: "Larder Labels", notify: true });
    is("a product given by its name, with the one email asked for", [given[0], given[1].data.status, given[1].data.emailed], [200, "given", true]);
    const mail = services.emails().find((email) => [].concat(email.to).includes("zap@example.com") && String(email.subject).startsWith("Larder Labels"));
    is("the email says it was given and nothing was charged", String(mail?.text ?? "").includes("has given you Larder Labels. Nothing was charged."), true);
    is("taken back again by the API that gave it", (await api("DELETE", "access", writeKey, { email: "zap@example.com", product: checklist }))[1].data.status, "taken_back");
    is("and a second time there is nothing to take", (await api("DELETE", "access", writeKey, { email: "zap@example.com", product: checklist }))[0], 404);
    await post("/api/store/product", { action: "remove", id: checklist });
  }

  await keepSmall();
  part("A phone number asked at checkout, in Stripe's own box");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Coaching Notes", price: "9" });
    const notes = made.product?.id ?? "";
    await post("/api/store/product", { action: "link", id: notes, link: "https://example.com/coaching-notes" });
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("button[aria-expanded]", { hasText: "Coaching Notes" }).first().click();
    await studio.getByRole("button", { name: "Ask the buyer something at checkout" }).first().click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save the questions" }) });
    await form.getByLabel("Answer").selectOption("phone");
    is("Stripe's own box needs no label, and is always required", [await form.getByText("Always required by Stripe").count(), await form.locator("input[type=text]").count()], [1, 0]);
    await form.getByRole("button", { name: "Save the questions" }).click();
    await studio.getByText("Asks at checkout: “Phone number”").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop/p/${notes}`);
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#buy form[data-checkout] button[type=submit]").first().click()]);
    const paid = services.checkouts().at(-1);
    is("Stripe is asked for its phone box, and nothing is added to its questions", [paid.customer_details?.phone, paid.metadata.product], [("+" + "15125550142"), notes]);
    await open(studio, `${LOCAL}/studio`);
    is("the number is on the sale in the studio", (await studio.locator("body").innerText()).includes(("+" + "15125550142")), true);
    await post("/api/store/product", { action: "remove", id: notes });
  }

  await keepSmall();
  part("A buyer's library: every store they bought from, in one place");
  {
    await open(page, `${LOCAL}/library`);
    await page.fill('input[name="email"]', "buyer@example.com");
    await Promise.all([page.waitForURL(/status=sent/, { timeout: 60_000 }), page.locator("main button[type=submit]").click()]);
    const mail = services.emails().filter((email) => [].concat(email.to).includes("buyer@example.com") && email.subject === "Your purchases on Marktmorgen").at(-1);
    const link = mail?.text.match(/https?:\/\/\S+\/library\?token=[0-9a-f]{64}/)?.[0] ?? "";
    is("asked for by the address paid with, a link is emailed to it", Boolean(link), true);
    await open(page, local(link));
    const shelf = page.locator("[data-library-store='localshop']");
    is("the store it bought from is there, with the way to its purchases", [await shelf.count(), await shelf.getByRole("link", { name: "Open your purchases" }).count()], [1, 1]);
    await open(page, local((await shelf.getByRole("link", { name: "Open your purchases" }).getAttribute("href")) ?? ""));
    is("which opens that store's own list for the same address", [/\/@localshop\/orders\?token=[0-9a-f]{64}$/.test(page.url()), await page.locator("h1", { hasText: "Your purchases" }).count() > 0], [true, true]);
  }

  await keepSmall();
  part("Renewals in the studio's numbers, apart from new sales");
  {
    await open(studio, `${LOCAL}/studio`);
    const tile = studio.locator("dl div", { hasText: "Renewals" }).first();
    await tile.waitFor({ timeout: 30_000 });
    is("the payments after the first are shown apart, with what they came to", [(await words(tile)).includes("$20"), (await words(tile)).includes("1 payment after the first")], [true, true]);
  }

  await keepSmall();
  part("Telling a product's buyers it was updated");
  {
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("button[aria-expanded]", { hasText: "Weeknight Dinners" }).first().click();
    await studio.getByRole("button", { name: "Tell buyers about an update" }).first().click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Check before sending" }) });
    await form.getByLabel("What changed (optional)").fill("Ten new recipes.");
    // The first press shows what will go out (487 [IT4], pattern 8); only "Yes, email every buyer" sends.
    await form.getByRole("button", { name: "Check before sending" }).click();
    await form.getByRole("heading", { name: "Check before it goes out" }).waitFor({ timeout: 30_000 });
    await form.getByRole("button", { name: "Yes, email every buyer" }).click();
    const said = form.getByRole("alert");
    await said.waitFor({ timeout: 30_000 });
    is("on a store without Pro, it says where it is, and sends nothing", await words(said), "Emails to your buyers are on Pro, with your store's email set up under Email.");
    await open(page, `${LOCAL}/unsubscribe?u=${"0".repeat(40)}`);
    is("a stop link nobody was given is said to be unknown", await page.locator("h1").count(), 1);
  }

  await keepSmall();
  part("A physical product, shipped by the creator");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "The Supper Book", summary: "Printed, 120 pages.", price: "35" });
    const book = made.product?.id ?? "";
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("button[aria-expanded]", { hasText: "The Supper Book" }).first().click();
    await studio.getByRole("button", { name: "Ship it: a physical product, sent by you" }).first().click();
    const form = studio.locator("form", { has: studio.getByRole("button", { name: "Save shipping" }) });
    await form.getByLabel("Shipping cost per order, in dollars").fill("6");
    await form.getByLabel("Ships to").selectOption("na");
    await form.getByLabel("When it ships (optional)").fill("Ships within 3 business days");
    await form.getByRole("button", { name: "Save shipping" }).click();
    await studio.getByText("Shipped by you: $6.00 shipping · The United States and Canada").or(studio.getByText("Shipped by you: $6 shipping · The United States and Canada")).first().waitFor({ timeout: 30_000 });
    is("set up in the studio, and said back", await studio.getByText(/^Shipped by you: \$6/).count() > 0, true);

    // Two versions of it, each shipped the same way.
    await post("/api/store/option", { action: "add", id: book, label: "Unsigned", price: "35" });
    await post("/api/store/option", { action: "add", id: book, label: "Signed", price: "45" });
    await open(page, `${LOCAL}/@localshop/p/${book}`);
    is("its page says what shipping costs, where it goes and when", await words(page.locator("#buy [data-shipping]").first()), "+ $6 shipping · Ships to: United States and Canada · Ships within 3 business days");
    await page.locator("#buy").getByLabel(/Signed/).first().check();
    // The box to start during the cancellation period (lib/digital-consent.ts), checked by clicking its label, as a buyer does.
    for (const label of await page.locator('label:visible:has(> input[name="dc"]:not(:checked))').all()) await label.click();
    await Promise.all([page.waitForURL(/\/thanks\?session_id=/, { timeout: 120_000 }), page.locator("#buy form[data-checkout] button[type=submit]").first().click()]);
    const paid = services.checkouts().at(-1);
    is("Stripe asks for the address and adds the shipping, for the version picked", [paid.metadata.ship, paid.shipping_cost?.amount_total, paid.amount_total, paid.metadata.title], ["yes", 600, 4500, "The Supper Book (Signed)"]);
    is("the page after paying says where it is going and who sends it", [(await words(page.locator("[data-ship-to]"))).includes("1 Main St"), (await words(page.locator("[data-ship-to]"))).includes("ships it and emails you when it is on its way")], [true, true]);

    await open(studio, `${LOCAL}/studio`);
    const ship = studio.locator("form", { has: studio.getByRole("button", { name: "Mark as shipped" }) }).first();
    await ship.getByLabel("Tracking link (optional)").fill("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400");
    await ship.getByRole("button", { name: "Mark as shipped" }).click();
    await studio.getByText(/^Marked as shipped on/).first().waitFor({ timeout: 30_000 });
    let mail = null;
    for (let i = 0; i < 40 && !mail; i += 1) {
      mail = services.emails().find((email) => String(email.subject ?? "") === "The Supper Book (Signed) is on its way") ?? null;
      if (!mail) await new Promise((wait) => setTimeout(wait, 250));
    }
    is("marked as shipped, and the buyer told with the tracking link", String(mail?.text ?? "").includes("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400"), true);
    await post("/api/store/product", { action: "remove", id: book });
  }

  part("A cover made in the studio");
  {
    await open(studio, `${LOCAL}/studio`);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const made = await post("/api/store/product", { action: "add", title: "Sourdough at Home", summary: "A starter, a loaf and a schedule that works", price: "19" });
    const loaf = made.product?.id ?? "";
    await open(studio, `${LOCAL}/studio`);
    await studio.locator("button[aria-expanded]", { hasText: "Sourdough at Home" }).first().click();
    await studio.getByRole("button", { name: "Make a cover" }).first().click();
    const maker = studio.locator("section", { has: studio.getByRole("heading", { name: "Make a cover" }) }).first();
    await maker.waitFor({ timeout: 15_000 });
    is("it starts from the product's own words", [await maker.getByLabel("Title on the cover").inputValue(), await maker.getByLabel("Line under the title").inputValue()], ["Sourdough at Home", "A starter, a loaf and a schedule that works"]);
    await maker.getByLabel("Small line above the title").fill("Ebook");
    // Each design drawn: many colors on its canvas, not an empty frame.
    let drawn = [];
    for (let i = 0; i < 40; i += 1) {
      drawn = await maker.locator("canvas[data-design]").evaluateAll((canvases) =>
        canvases.map((canvas) => {
          const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
          const seen = new Set();
          for (let p = 0; p < data.length; p += 400) seen.add(`${data[p]},${data[p + 1]},${data[p + 2]}`);
          return seen.size;
        }),
      );
      if (drawn.length === 6 && drawn.every((count) => count > 20)) break;
      await new Promise((wait) => setTimeout(wait, 250));
    }
    is("six designs, each drawn", [drawn.length, drawn.every((count) => count > 20)], [6, true]);
    await maker.getByText("Glow", { exact: true }).click();
    if (process.env.E2E_SHOTS) await maker.screenshot({ path: join(process.env.E2E_SHOTS, "cover-maker.png") });
    // The cover goes through the picture's own door: the first thing asked is for a place in this store's picture folder.
    let asked = null;
    await studio.route("**/api/store/image/upload", async (route) => {
      asked = route.request().postDataJSON();
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "stopped here by the test" }) });
    });
    await maker.getByRole("button", { name: "Use this cover" }).click();
    for (let i = 0; i < 60 && !asked; i += 1) await new Promise((wait) => setTimeout(wait, 250));
    await studio.unroute("**/api/store/image/upload");
    const pathname = String(asked?.payload?.pathname ?? asked?.pathname ?? JSON.stringify(asked ?? ""));
    is("made full size, shrunk, and sent as a picture of this store", [/images\/[0-9a-f]+\/[0-9a-f]{32}\.(webp|jpg)/.test(pathname), pathname.includes(loaf) || JSON.stringify(asked).includes(loaf)], [true, true]);
    await post("/api/store/product", { action: "remove", id: loaf });
  }

  part("The affiliate directory");
  {
    await open(studio, `${LOCAL}/studio/affiliates`);
    is("the studio says where the program would be listed, and what the row shows", (await words(studio.locator("main"))).includes("People looking for something to promote find it at marktmorgen.com/affiliate-programs"), true);
    const post = (path, body) => studio.evaluate(async ([path, body]) => (await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
    const terms = { action: "settings", enabled: true, percent: 35, days: 45, rule: "last", payday: 10, hold: 14, rates: {}, buyers: false, lifetime: true };
    const saved = await post("/api/store/affiliates", { ...terms, directory: true, numbers: true });
    is("listed with one box", saved.ok, true);
    await open(page, `${LOCAL}/affiliate-programs`);
    const row = page.locator("[data-program=localshop]");
    const text = await words(row);
    is("its row, read from the store: the share, the window, a buyer kept, the payday, and a product with what one sale earns", [
      await words(row.locator("[data-share]")),
      text.includes("A click counts for 45 days; the last link followed earns the sale"),
      text.includes("A buyer you bring stays yours"),
      text.includes("Pays on the 10th of each month, once a sale is 14 days old"),
      (await row.locator("[data-earns]").count()) > 0,
    ], ["35% of each sale", true, true, true, true]);
    is("its own numbers, because the creator allowed them; no rate per click before 100 clicks", [(await words(row.locator("[data-numbers]"))).toLowerCase().includes("shown by the creator's choice"), (await words(row.locator("[data-numbers]"))).includes("shown after 100 clicks") || /of clicks became a sale/.test(await words(row.locator("[data-numbers]")))], [true, true]);
    is("the order and the rules for affiliates are on the page", [(await words(page.locator("#order"))).includes("Nobody can pay to be placed higher"), (await words(page.locator("main"))).includes("Say it is an affiliate link")], [true, true]);
    is("kept from search engines while there are fewer than ten programs", await page.locator('meta[name="robots"]').getAttribute("content"), "noindex, follow");
    await page.getByLabel("Search programs and products").fill("zzzz nothing like this");
    is("search narrows the list, and says so", [await page.locator("[data-program]").count(), (await words(page.getByRole("status").first())).startsWith("Showing 0 of")], [0, true]);
    await page.getByLabel("Search programs and products").fill("");
    if (process.env.E2E_SHOTS) await page.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "affiliate-directory.png") });
    await row.getByRole("link", { name: "See the program and apply" }).click();
    await page.waitForURL(/\/@localshop\/affiliates/);
    is("its program page asks for honest promotion before anyone applies", (await words(page.locator("main"))).includes("Wherever you share your link, say that you earn from it"), true);
    // Memberships that keep paying, a monthly bonus, and no paid search on the store's name (lib/affiliate-setting.ts).
    await open(studio, `${LOCAL}/studio/affiliates`);
    const program = studio.locator("section[aria-labelledby=terms-title]");
    await program.getByLabel("Memberships and payment plans").selectOption("12");
    await program.getByRole("button", { name: "Add a bonus" }).click();
    await program.getByLabel("Sales in a month").fill("10");
    await program.getByLabel(/^Bonus \(/).fill("50");
    await Promise.all([
      studio.waitForResponse((r) => r.url().endsWith("/api/store/affiliates") && r.request().method() === "POST" && r.ok(), { timeout: 30_000 }),
      program.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    await open(page, `${LOCAL}/@localshop/affiliates`);
    const offered = await words(page.locator("main"));
    is("the program page states the new terms before anyone applies", [
      offered.includes("on purchases made through your link"),
      offered.includes("A membership earns on each of its payments in its first 12 months"),
      offered.includes("A bonus of $50 for any calendar month in which 10 sales through your link earn"),
      offered.includes("Paid search ads on Local Shop's name are not allowed") || /Paid search ads on .+ name are not allowed/.test(offered),
    ], [true, true, true, true]);
    await post("/api/store/affiliates", { ...terms, directory: false });
    await open(page, `${LOCAL}/affiliate-programs`);
    is("unchecked, it leaves the page at once", await page.locator("[data-program=localshop]").count(), 0);
  }

  part("Posts drafted for an affiliate, each saying it is an affiliate link");
  {
    const fan = "kit.fan@example.com";
    await open(page, `${LOCAL}/@localshop/affiliates`);
    await page.fill("#aff-email", fan);
    await Promise.all([page.waitForURL(/status=sent/), page.getByRole("button", { name: "Email me a link to apply" }).click()]);
    let mail = null;
    for (let i = 0; i < 40 && !mail; i += 1) {
      mail = services.emails().find((email) => [email.to].flat().includes(fan)) ?? null;
      if (!mail) await new Promise((wait) => setTimeout(wait, 250));
    }
    const link = String(mail?.text ?? "").match(/https?:\/\/\S+\/@localshop\/affiliates\S*/)?.[0] ?? "";
    await open(page, local(link));
    await Promise.all([page.waitForLoadState("networkidle"), page.getByRole("button", { name: "Open my affiliate page" }).click()]);
    await open(studio, `${LOCAL}/studio/affiliates`);
    await studio.locator("li:not([data-mark])", { hasText: fan }).getByRole("button", { name: "Approve" }).click();
    await studio.getByText("Affiliate approved.").first().waitFor({ timeout: 30_000 });
    await open(page, `${LOCAL}/@localshop/affiliates`);
    const kit = page.locator("[data-kit]");
    await kit.getByLabel("Who you share with, and how you know it (optional)").fill("My followers cook on weeknights.");
    await kit.getByRole("button", { name: "Write three posts" }).click();
    await kit.locator("[data-posts]").waitFor({ timeout: 30_000 });
    const posts = await kit.locator("[data-posts] textarea").evaluateAll((boxes) => boxes.map((box) => box.value));
    is("three posts, each with the affiliate's link to the product and the line saying they earn from it", [
      posts.length,
      posts.every((post) => /\/@localshop\/p\/\S+\?via=[a-z0-9]+/.test(post)),
      posts[0].includes("#ad (affiliate link)"),
      posts[1].includes("Affiliate link: I earn a commission if you buy through it."),
      posts[2].includes("Affiliate link: I earn a commission if you buy through it."),
    ], [3, true, true, true, true]);
    const asked = services.writing().filter((body) => String(body.system ?? "").startsWith("You write three short posts an affiliate shares")).at(-1);
    is("written from the product's page and the affiliate's own note, never claiming they used it", [
      String(asked?.messages?.[0]?.content ?? "").includes("My followers cook on weeknights."),
      String(asked?.system ?? "").includes("Never say or suggest the affiliate bought, used or tried the product"),
    ], [true, true]);
    if (process.env.E2E_SHOTS) await kit.screenshot({ path: join(process.env.E2E_SHOTS, "affiliate-kit.png") });
    const signedOut = await studio.evaluate(async () => (await fetch("/api/store/affiliates/kit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "localshop", product: "x" }) })).status);
    is("nobody but a signed-in affiliate can ask", signedOut, 401);
  }

  part("A member pauses instead of canceling, and comes back");
  {
    await open(studio, `${LOCAL}/studio`);
    const saved = await studio.evaluate(async () => (await fetch("/api/store/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ months: 2 }) })).json());
    is("the creator lets members pause for up to 2 months", saved.ok, true);
    await open(page, `${LOCAL}/@localshop/manage`);
    await page.fill("#manage-email", "pause.member@example.com");
    await Promise.all([page.waitForURL(/status=sent/), page.getByRole("button", { name: "Email me a link to my membership" }).click()]);
    let mail = null;
    for (let i = 0; i < 40 && !mail; i += 1) {
      mail = services.emails().find((email) => [email.to].flat().includes("pause.member@example.com") && /token=/.test(String(email.text))) ?? null;
      if (!mail) await new Promise((wait) => setTimeout(wait, 250));
    }
    await open(page, local(String(mail?.text ?? "").match(/https?:\/\/\S+\/manage\?token=[0-9a-f]{64}/)?.[0] ?? ""));
    const offer = page.locator("[data-pause]");
    await offer.locator("summary").click();
    is("beside Cancel, a pause of up to the months the creator allows, saying what it does", [
      await offer.locator("select option").count(),
      (await words(offer)).includes("What you have paid for stays open until"),
    ], [2, true]);
    await offer.locator("select").selectOption("2");
    await Promise.all([page.waitForURL(/status=paused/), offer.getByRole("button", { name: "Pause my membership" }).click()]);
    const sent = services.subscriptionUpdates().at(-1);
    is("Stripe skips the payments of the pause and resumes by itself", [sent?.["pause_collection[behavior]"], Number(sent?.["pause_collection[resumes_at]"]) > Number(sent?.["metadata[pause_from]"])], ["void", true]);
    is("the page says it is paused, from when and until when", [(await words(page.locator("main"))).includes("Your membership is paused"), /^Pauses on .+, back on .+/.test(await words(page.locator("[data-paused] .st-note")))], [true, true]);
    let note = null;
    for (let i = 0; i < 40 && !note; i += 1) {
      note = services.emails().find((email) => [email.to].flat().includes("pause.member@example.com") && /membership is paused$/.test(String(email.subject))) ?? null;
      if (!note) await new Promise((wait) => setTimeout(wait, 250));
    }
    is("and the member is emailed the dates", Boolean(note), true);
    if (process.env.E2E_SHOTS) await page.locator("main").screenshot({ path: join(process.env.E2E_SHOTS, "member-pause.png") });
    await Promise.all([page.waitForURL(/status=resumed/), page.locator("[data-paused]").getByRole("button", { name: "Resume now" }).click()]);
    is("before the pause starts, coming back only takes it off", [(await words(page.locator("main"))).includes("Your membership is on again"), services.subscriptionUpdates().at(-1)?.pause_collection, services.subscriptionUpdates().at(-1)?.billing_cycle_anchor], [true, "", undefined]);
    await studio.evaluate(async () => fetch("/api/store/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ months: 0 }) }));
  }

  part("Asked why before canceling, and answered");
  {
    await open(studio, `${LOCAL}/studio`);
    const saved = await studio.evaluate(async () =>
      (await fetch("/api/store/leaving", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true, reasons: ["too_expensive", "unused", "missing_features", "switched_service", "too_complex", "low_quality", "customer_service", "other"], own: [{ text: "The live calls don't fit my time zone" }] }) })).json(),
    );
    is("the creator turns it on, with a reason of their own", [saved.ok, saved.leaving?.own?.length], [true, 1]);
    await open(page, `${LOCAL}/@localshop/manage`);
    await page.fill("#manage-email", "pause.member@example.com");
    const asked = services.emails().length;
    await Promise.all([page.waitForURL(/status=sent/), page.getByRole("button", { name: "Email me a link to my membership" }).click()]);
    let mail = null;
    for (let i = 0; i < 40 && !mail; i += 1) {
      mail = services.emails().slice(asked).find((email) => [email.to].flat().includes("pause.member@example.com") && /token=/.test(String(email.text))) ?? null;
      if (!mail) await new Promise((wait) => setTimeout(wait, 250));
    }
    await open(page, local(String(mail?.text ?? "").match(/https?:\/\/\S+\/manage\?token=[0-9a-f]{64}/)?.[0] ?? ""));
    await Promise.all([page.waitForURL(/\/manage\/leave\?/), page.getByRole("link", { name: "Cancel", exact: true }).first().click()]);
    is("Cancel opens the store's page that asks why, with the way out on it from the start", [
      await page.locator("input[name=why]").count(),
      await page.getByText("The live calls don't fit my time zone").count(),
      await page.getByRole("button", { name: "Cancel my membership" }).count(),
    ], [9, 1, 1]);
    await page.getByLabel("Something I need is missing").check();
    await Promise.all([page.waitForURL(/why=missing_features/), page.getByRole("button", { name: "Continue" }).click()]);
    is("something missing is answered with a way to write to the creator", (await words(page.locator("[data-leave-answer]"))).includes("Harbor Kitchen Local would like to know."), true);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "leave-answer.png"), fullPage: true });
    {
      // The same page, checked against the accessibility rules.
      const audit = await browser.newContext({ viewport: { width: 430, height: 900 }, bypassCSP: true });
      const reader = await audit.newPage();
      await reader.goto(page.url(), { waitUntil: "networkidle", timeout: 120_000 });
      await reader.addScriptTag({ path: axePath });
      const found = await reader.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return result.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
      });
      await audit.close();
      is("no accessibility errors on it", found, []);
    }
    const before = services.subscriptionUpdates().length;
    // Stripe's page is not reachable from here: where the button sends the member is read from the answer.
    const [sent] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/store/manage/cancel"), { timeout: 30_000 }),
      page.getByRole("button", { name: "Cancel my membership" }).click(),
    ]);
    const written = services.subscriptionUpdates().slice(before).at(-1);
    is("pressing it opens Stripe's page, with the reason written on the membership and not asked again", [
      /^https:\/\/billing\.stripe\.com\//.test(sent.headers().location ?? ""),
      written?.["metadata[leave_reason]"],
      services.portalConfigs().at(-1)?.["features[subscription_cancel][cancellation_reason][enabled]"],
    ], [true, "missing_features", "false"]);
    await studio.evaluate(async () => fetch("/api/store/leaving", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: false }) }));
  }

  part("A card link that no longer works");
  {
    await open(page, `${LOCAL}/@localshop/manage/card?t=${"0".repeat(64)}`);
    is("a card link that no longer works says so, and offers the way in", [
      (await words(page.locator("main"))).includes("This link has expired"),
      await page.getByRole("button", { name: "Add a new card" }).count(),
      await page.getByRole("link", { name: "Manage or cancel your membership" }).count(),
    ], [true, 0, 1]);
    if (process.env.E2E_SHOTS) await page.screenshot({ path: join(process.env.E2E_SHOTS, "card-expired.png"), fullPage: true });
  }

  await keepSmall();
  part("Nothing went wrong on the way");
  is("no page threw an error", errors, []);
  is("and no page's own policy refused anything on it", [...new Set(policyRefusals)], []);
  is("and React found every page as the server drew it", [...new Set(reactWarnings)], []);
  is("nothing was asked of a service with no stand-in", services.unknown(), []);
} catch (error) {
  failed += 1;
  console.error(`\nStopped: ${error?.stack ?? error}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stop(app);
  await services.close().catch(() => {});
  if (process.env.E2E_APP_LOG) writeFileSync(process.env.E2E_APP_LOG, appLog);
}

console.log(failed ? `\n${failed} failing.` : "\nEverything passing.");
process.exit(failed ? 1 : 0);
