/**
 * Proposals and agreements signed with a link (docs/agreements-esign.md),
 * run on this computer in a real browser: from the studio's form to the
 * signed copy in both inboxes.
 *
 *   node tests/e2e/agreements.mjs              builds the app, then checks
 *   node tests/e2e/agreements.mjs --no-build   uses the build already in .next
 *
 * Why it exists (18 October 2026). The flow shipped in #552 with unit tests
 * of every function it is made of and none of the path between them: the
 * studio's form, the email, the page a stranger opens, its plain form post
 * and the answer it lands on. This walks that path.
 *
 * What runs: the real app (`next build`, then `next start`), pointed at the
 * stand-in database and email sender of tests/e2e/services.mjs through the
 * addresses the code already accepts (the database's own, RESEND_API_BASE).
 * No real email is sent and no real service is reached.
 *
 * What is checked:
 *
 *   - the owner writes an agreement in the studio and sends it; one email
 *     goes to the person, with the link;
 *   - in a fresh browser, the link shows the exact text, and the fingerprint
 *     printed under it is the SHA-256 of that text, the same one the record
 *     holds;
 *   - a wrong address is refused, and nothing is signed;
 *   - the right name, address and box sign it: the page shows the record,
 *     both signed copies go out with the exact text attached, and the record
 *     holds the version's fingerprint, the name, the consent sentence and a
 *     one-way code of the address (never the address itself);
 *   - a second agreement, opened in the browser signed in to the studio, or
 *     on a device the creator marked, is refused with every right detail
 *     typed, and is still open;
 *   - a new version sent from the studio while the person reads: their
 *     signature of the version they read is refused as changed;
 *   - the signing page, open and signed, and the studio's page, at 390 and 1280: no sideways
 *     scroll, and axe-core (this project's own copy) finds nothing at
 *     WCAG 2.0, 2.1 and 2.2 A and AA.
 *
 * It needs a browser driver: Playwright, or playwright-core with a Chromium
 * (PLAYWRIGHT_BROWSERS_PATH, CHROMIUM=<path to the browser>, or Chrome
 * installed). It does not download a browser. In CI it runs after the
 * production build of the "verify" job (.github/workflows/product-checks.yml).
 *
 * Checked against itself the day it was written: with the address check
 * (lib/agreement-store.ts) or the studio check (the signing route) switched
 * off, it fails; put back, it passes.
 */
import { checkSigninAcknowledgment } from "./signin-acknowledgment.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startServices } from "./services.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const SERVICES = Number(process.env.E2E_SERVICES_PORT || 4488);
const APP = Number(process.env.E2E_APP_PORT || 3188);
const LOCAL = `http://localhost:${APP}`;
const FAKE = `http://127.0.0.1:${SERVICES}`;
const local = (url) => url.replace("https://marktmorgen.com", LOCAL);
const BUILD = !process.argv.includes("--no-build");

const env = {
  ...process.env,
  UPSTASH_REDIS_REST_URL: FAKE,
  UPSTASH_REDIS_REST_TOKEN: "local",
  RESEND_API_KEY: "re_local_only_a_stand_in",
  RESEND_API_BASE: FAKE,
  // The one-way code of the signer's address is made under this key (lib/agreement-store.ts).
  NIMBUS_DATA_KEY: "local_only_a_stand_in_data_key_0000000000000000",
  NEXT_FONT_GOOGLE_MOCKED_RESPONSES: join(here, "google-fonts-mock.cjs"),
  E2E_FONT_ORIGIN: FAKE,
  NEXT_TELEMETRY_DISABLED: "1",
};

const require = createRequire(join(root, "package.json"));
let chromium;
for (const name of ["playwright", "playwright-core", process.env.PLAYWRIGHT_CORE].filter(Boolean)) {
  try {
    ({ chromium } = require(name));
    break;
  } catch {}
}
if (!chromium) {
  console.error("This needs Playwright or playwright-core on the machine (PLAYWRIGHT_CORE=<its folder> to name one). Nothing was run.");
  process.exit(2);
}
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

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
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

const services = await startServices(SERVICES);
let app = null;
let browser = null;
let appLog = "";
const run = (cmd, args) =>
  new Promise((done) => {
    const child = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    child.stdout.on("data", (chunk) => (said += chunk));
    child.stderr.on("data", (chunk) => (said += chunk));
    child.on("close", (status) => done({ status, said }));
  });

try {
  const out = mkdtempSync(join(tmpdir(), "mm-agree-seed-"));
  const seedFile = join(out, "seed.cjs");
  await build({ entryPoints: [join(here, "agreements-seed.ts")], bundle: true, platform: "node", format: "cjs", outfile: seedFile, logLevel: "error", alias: { "@": root } });
  // Not spawnSync: the stand-in database it writes to is served by this very process.
  const seeded = await run(process.execPath, [seedFile]);
  rmSync(out, { recursive: true, force: true });
  if (seeded.status !== 0) throw new Error(`the store could not be made:\n${seeded.said}`);
  const { session } = JSON.parse(seeded.said.trim().split("\n").at(-1));

  if (BUILD) {
    const built = await run("npx", ["next", "build"]);
    if (built.status !== 0) throw new Error(`the app did not build:\n${built.said.slice(-3000)}`);
  }
  app = spawn("npx", ["next", "start", "-p", String(APP)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  app.stdout.on("data", (chunk) => (appLog += chunk));
  app.stderr.on("data", (chunk) => (appLog += chunk));
  const started = Date.now();
  while (!(await fetch(`${LOCAL}/@signshop`).then((r) => r.status === 200).catch(() => false))) {
    if (Date.now() - started > 120_000) throw new Error(`the app did not start:\n${appLog.slice(-2000)}`);
    await new Promise((wait) => setTimeout(wait, 1000));
  }

  browser = await launch();
  const errors = [];
  const watch = (page) => page.on("pageerror", (error) => errors.push(String(error)));
  const open = (page, url) => page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  const record = async (id) => {
    const [raw] = await services.redis([["GET", `nl:agree:r:${id}`]]);
    return raw ? JSON.parse(raw) : null;
  };
  const versionText = async (id, n) => {
    const [raw] = await services.redis([["GET", `nl:agree:v:${id}:${n}`]]);
    return raw ? JSON.parse(raw) : null;
  };

  // The owner, signed in to the studio.
  const studio = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await studio.addCookies([{ name: "nl_session", value: session, url: LOCAL }]);
  const owner = await studio.newPage();
  watch(owner);

  /** Writes and sends one agreement from the studio's form; answers its id and the email that went. */
  const send = async (to, name, title, body) => {
    await open(owner, `${LOCAL}/studio/agreements`);
    const form = owner.locator("form").filter({ hasText: "New proposal or agreement" });
    await form.getByLabel("Their email").fill(to);
    await form.getByLabel("Their name (optional)").fill(name);
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("The text").fill(body);
    await form.getByRole("button", { name: "Add a line" }).click();
    await form.getByPlaceholder("Twelve weekly sessions").fill("Twelve weekly sessions");
    await form.getByLabel("Line 1: amount each").fill("120");
    await form.getByLabel("I deal with this person, and they expect this from me.").check();
    const before = services.emails().length;
    // The first press shows what will go out (487 [IT4], pattern 8); only the review's own button sends.
    await form.getByRole("button", { name: "Check before sending" }).click();
    await form.getByRole("heading", { name: "Check before it goes out" }).waitFor({ timeout: 30_000 });
    const [answer] = await Promise.all([
      owner.waitForResponse((r) => r.url().endsWith("/api/store/agreements") && r.request().method() === "POST"),
      form.getByRole("button", { name: "Yes, send for signature" }).click(),
    ]);
    const data = await answer.json();
    await owner.waitForLoadState("networkidle");
    return { data, mails: services.emails().slice(before) };
  };

  part("Writing one in the studio");
  const BODY = "We agree to twelve weekly coaching sessions, one hour each.\n\nPayment: half before the first session, half after the sixth.\n\nEither side may end it with seven days' notice; sessions not held are not charged.";
  const first = await send("client@example.com", "Rita Alencar", "Coaching, October to December", BODY);
  is("the studio answered with an id, and said it was sent", [first.data.ok, /^[0-9a-f]{32}$/.test(first.data.id ?? ""), first.data.sent], [true, true, true]);
  is("one email, to the person, from the store's name", first.mails.map((m) => [[].concat(m.to)[0], m.subject]), [["client@example.com", 'Harbor Coaching Local: agreement to sign, "Coaching, October to December"']]);
  const link = first.mails[0]?.text.match(/https:\/\/\S+\/sign\/[0-9a-f]{32}/)?.[0] ?? "";
  is("its link is the store's own signing page", link, `https://marktmorgen.com/@signshop/sign/${first.data.id}`);
  is("the studio lists it as waiting", (await words(owner.locator("#agreements-heading + p + ul li").first())).includes("Waiting"), true);

  part("Opening the link in a fresh browser");
  const stranger = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const signer = await stranger.newPage();
  watch(signer);
  await open(signer, local(link));
  const shown = await signer.locator("main pre").innerText();
  const printed = await signer.locator("main p code").innerText();
  const stored = await record(first.data.id);
  const kept = await versionText(first.data.id, 1);
  is("the page shows the text that was kept, exactly", shown, kept?.text);
  is("the text holds what the creator typed", shown.includes(BODY), true);
  is("the fingerprint printed is the SHA-256 of that text", printed, sha(shown));
  is("and is the one the record holds", stored?.versions?.[0]?.sha256, printed);
  is("it is not indexed", await signer.locator('meta[name="robots"]').getAttribute("content"), "noindex, nofollow");

  part("A wrong address is refused");
  await signer.getByLabel("Your full name").fill("Rita Alencar");
  await signer.getByLabel("The email address this was sent to").fill("someone.else@example.com");
  await signer.locator('input[name="agree"]').check();
  await Promise.all([signer.waitForURL(/notice=/), signer.getByRole("button", { name: "Sign", exact: true }).click()]);
  is("refused as the wrong address", new URL(signer.url()).searchParams.get("notice"), "email");
  is("the page says why", await words(signer.locator('main [role="alert"]')), "That is not the address this was sent to Only the person it was sent to may sign it. Type the email address it came to.");
  is("nothing was signed", (await record(first.data.id))?.versions?.[0]?.signature ?? null, null);

  part("Signed by the person it was sent to");
  await signer.getByLabel("Your full name").fill("Rita Alencar");
  await signer.getByLabel("The email address this was sent to").fill("Client@Example.com");
  await signer.locator('input[name="agree"]').check();
  const mailsBefore = services.emails().length;
  await Promise.all([signer.waitForURL(/notice=/), signer.getByRole("button", { name: "Sign", exact: true }).click()]);
  is("signed", new URL(signer.url()).searchParams.get("notice"), "signed");
  is("the page says it is signed", await words(signer.locator("h1")), "Signed");
  const signed = await record(first.data.id);
  const signature = signed?.versions?.[0]?.signature;
  is("the record holds the name, the fingerprint and the sentence checked", [signature?.name, signature?.sha256, typeof signature?.consent === "string" && signature.consent.length > 20], ["Rita Alencar", printed, true]);
  is("and a one-way code of the address, never the address", [/^[0-9a-f]{64}$/.test(signature?.ipHash ?? ""), JSON.stringify(signed).includes("127.0.0.1"), JSON.stringify(signed).includes("::1")], [true, false, false]);
  is("the page shows what was recorded", await signer.locator("main dl dd").first().innerText(), "Rita Alencar");
  is("the same text and fingerprint stay on the page", [await signer.locator("main pre").innerText(), await signer.locator("main p code").innerText()], [shown, printed]);
  is("the form to sign is gone", await signer.locator('form[action="/api/store/agreement-sign"]').count(), 0);
  const copies = services.emails().slice(mailsBefore);
  is("two signed copies: to the person and to the creator", copies.map((m) => [].concat(m.to)[0]).sort(), ["client@example.com", "owner@example.com"]);
  const attached = copies.map((m) => Buffer.from(m.attachments?.[0]?.content ?? "", "base64").toString("utf8"));
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  is("each carries the exact text in its attached file", attached.map((html) => unescape(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? "") === shown), [true, true]);
  is("each names the fingerprint", copies.map((m) => m.text.includes(printed)), [true, true]);
  const again = await signer.request.post(`${LOCAL}/api/store/agreement-sign`, {
    form: { handle: "signshop", agreement: first.data.id, version: "1", sha256: printed, name: "Rita Alencar", email: "client@example.com", agree: "yes" },
    headers: { Origin: LOCAL },
    maxRedirects: 0,
  });
  is("signing again is refused", again.headers().location?.endsWith("?notice=closed"), true);

  part("The studio's own browser is refused");
  const second = await send("other@example.com", "", "Workshop proposal", "One workshop of three hours, on a date we agree by email.");
  const secondLink = second.mails[0]?.text.match(/https:\/\/\S+\/sign\/[0-9a-f]{32}/)?.[0] ?? "";
  await open(owner, local(secondLink));
  await owner.getByLabel("Your full name").fill("Other Person");
  await owner.getByLabel("The email address this was sent to").fill("other@example.com");
  await owner.locator('input[name="agree"]').check();
  await Promise.all([owner.waitForURL(/notice=/), owner.getByRole("button", { name: "Sign", exact: true }).click()]);
  is("refused, with every right detail typed", [new URL(owner.url()).searchParams.get("notice"), await words(owner.locator('main [role="alert"] p').first())], ["studio", "This browser is signed in to the store's studio"]);
  is("and still waiting for a signature", (await record(second.data.id))?.versions?.[0]?.signature ?? null, null);
  // A device the creator marked "don't count" (lib/no-count.ts), not signed in, is the store's own people too.
  const marked = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const sid = (await record(second.data.id))?.sid ?? "";
  await marked.addCookies([{ name: "nl_nc", value: createHash("sha256").update(`no-count|${sid}`).digest("hex").slice(0, 12), url: LOCAL }]);
  const device = await marked.newPage();
  watch(device);
  await open(device, local(secondLink));
  await device.getByLabel("Your full name").fill("Other Person");
  await device.getByLabel("The email address this was sent to").fill("other@example.com");
  await device.locator('input[name="agree"]').check();
  await Promise.all([device.waitForURL(/notice=/), device.getByRole("button", { name: "Sign", exact: true }).click()]);
  is("a device the creator marked is refused too", new URL(device.url()).searchParams.get("notice"), "studio");
  await marked.close();

  part("A new version while the person reads");
  const reader = await stranger.newPage();
  watch(reader);
  await open(reader, local(secondLink));
  const readFirst = await reader.locator("main p code").innerText();
  await open(owner, `${LOCAL}/studio/agreements`);
  await owner.locator("li", { hasText: "other@example.com" }).getByRole("button", { name: "New version" }).click();
  const edit = owner.locator("form").filter({ hasText: "New version for" });
  await edit.getByLabel("The text").fill("One workshop of three hours, on a date we agree by email. Materials included.");
  const sentBefore = services.emails().length;
  await edit.getByRole("button", { name: "Check before sending" }).click();
  await edit.getByRole("heading", { name: "Check before it goes out" }).waitFor({ timeout: 30_000 });
  await Promise.all([
    owner.waitForResponse((r) => r.url().endsWith("/api/store/agreements") && r.request().method() === "POST" && r.request().postDataJSON()?.action === "revise"),
    edit.getByRole("button", { name: "Yes, send the new version" }).click(),
  ]);
  const revised = services.emails().slice(sentBefore);
  is("the new version is emailed to the person", revised.map((m) => [[].concat(m.to)[0], m.subject]), [["other@example.com", 'Harbor Coaching Local: version 2 of "Workshop proposal" to sign']]);
  await reader.getByLabel("Your full name").fill("Other Person");
  await reader.getByLabel("The email address this was sent to").fill("other@example.com");
  await reader.locator('input[name="agree"]').check();
  await Promise.all([reader.waitForURL(/notice=/), reader.getByRole("button", { name: "Sign", exact: true }).click()]);
  is("signing the version read before is refused as changed", new URL(reader.url()).searchParams.get("notice"), "changed");
  const readNow = await reader.locator("main p code").innerText();
  is("the page now shows version 2, with its own fingerprint", [readNow !== readFirst, readNow === sha(await reader.locator("main pre").innerText()), (await reader.locator("main p:has(code)").innerText()).startsWith("Version 2")], [true, true, true]);
  is("version 1 stays unsigned, version 2 waits", ((await record(second.data.id))?.versions ?? []).map((v) => [v.n, v.signature]), [[1, null], [2, null]]);
  await reader.close();
  await open(owner, `${LOCAL}/studio/agreements`);
  is("the studio shows the first one signed by the person", (await words(owner.locator("li", { hasText: "client@example.com" }).first())).includes("signed by Rita Alencar"), true);

  part("The signing page, by width and for accessibility");
  const audit = async (url, label, cookies = []) => {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      if (cookies.length) await context.addCookies(cookies);
      const page = await context.newPage();
      watch(page);
      await open(page, url);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.addScriptTag({ content: axeSource });
      const found = await page.evaluate(async () => {
        const result = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] } });
        return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      });
      is(`${label} at ${width}: no sideways scroll`, sideways, 0);
      is(`${label} at ${width}: axe-core finds nothing at WCAG 2.2 AA`, found, []);
      await context.close();
    }
  };
  await audit(local(secondLink), "open, with its form");
  await audit(local(link), "signed, with its record");
  await audit(`${LOCAL}/studio/agreements`, "the studio's list and form", [{ name: "nl_session", value: session, url: LOCAL }]);

  await checkSigninAcknowledgment({browser,LOCAL,is});
  is("no page threw", errors, []);
} catch (error) {
  failed += 1;
  console.error(error);
  console.error(appLog.slice(-3000));
} finally {
  await browser?.close().catch(() => {});
  if (app?.pid && app.exitCode === null) {
    try {
      process.kill(-app.pid, "SIGTERM");
    } catch {}
  }
  await services.close().catch(() => {});
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
