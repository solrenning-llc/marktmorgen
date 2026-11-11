// The page editor's block list in a real browser (AX274, AAA review of #2904):
// an arrow that cannot move keeps the focus and says it is off (2.4.3, 4.1.2);
// a move keeps the focus on the arrow that moved with its block and says
// where it went (2.4.3, 4.1.3); the same sentence said twice is said again;
// in forced colors no icon button animates its colors (inbox C4-35); Undo and
// Redo of moves made in one step name the block that moved, and a picture
// block whose send is still pending, or with no room left on the page, or in a
// column, never drops the focus (#2926).
// The real component with a synthetic page and every request held in the
// page (tests/e2e/page-editor-harness.tsx), the site's own style sheet built
// by Tailwind from the editor's classes: no server, no build, nothing sent.
// node tests/e2e/page-editor-actions.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const driver = require("playwright-core")[engine];
const { compile } = require("@tailwindcss/node");
const { Scanner } = require("@tailwindcss/oxide");

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

/** A valid PNG of w × h opaque gray pixels, made here (CRC and zlib), so the editor's shrink reads a real picture. */
function pngOf(w, h) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 128)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/page-editor-harness.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  logLevel: "error",
  alias: { "@": root, "next/link": join(root, "tests/next-link-world.tsx") },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "next-navigation",
    setup(b) {
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-navigation", namespace: "stand-in" }));
      b.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({ contents: "export const useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} }); export const usePathname = () => '/studio/pages'; export const useSearchParams = () => new URLSearchParams();", loader: "js" }));
    },
  }],
});
const script = bundle.outputFiles[0].text;
// The site's own style sheet with the Tailwind classes the editor uses, as the studio draws them.
const compiler = await compile(readFileSync(join(root, "app/globals.css"), "utf8"), { base: join(root, "app"), onDependency() {} });
const css = compiler.build(new Scanner({ sources: [{ base: root, pattern: "components/page-editor.tsx", negated: false }] }).scan());
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page editor check</title><link rel="stylesheet" href="/globals.css"></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/editor.js"></script></body></html>`;

const browser = await driver.launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const errors = [];
const uploads = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  // Only http and https are routed: WebKit sends a blob: URL through request interception too (playwright-core wkPage
  // _onRequestWillBeSent skips only data: and about:), so a route on every URL answered the picture's own blob: load
  // (its origin is the page's) with a 404, image.decode() failed in shrink and the send ended before any request
  // (WebKit job 128304280508 on #2926; the same cause as tests/e2e/shrink-tone.mjs on #2790). A blob: URL never leaves the page.
  await page.route((url) => url.protocol === "http:" || url.protocol === "https:", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://localhost:41904") return route.abort();
    // A picture's send is held here, never answered, so it stays "being sent"; nothing is uploaded.
    if (url.pathname === "/api/store/image/upload") return void uploads.push(route);
    if (url.pathname === "/editor.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/globals.css") return route.fulfill({ contentType: "text/css", body: css });
    return url.pathname === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 404, body: "" });
  });
  // localhost is a secure context, as the studio's https is (crypto.randomUUID names a picture); every request to it is
  // answered by the route above, so nothing needs to listen there.
  await page.goto("http://localhost:41904/");
  const settled = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  const status = () => page.evaluate(() => [...document.querySelectorAll('p[role="status"].sr-only')].map((node) => node.textContent).find((text) => text) ?? "");

  // A hero, then two Text blocks and a FAQ: the hero stays first, so the block under it cannot move up.
  await page.evaluate(() => window.harness.mount(["hero", "text", "text", "faq"].map((kind) => window.harness.block(kind))));
  const up2 = page.getByRole("button", { name: "Move block 2 up" });
  await up2.waitFor();
  is("the arrow that cannot move says it is off, and stays in the tab order", await up2.evaluate((node) => [node.getAttribute("aria-disabled"), node.disabled, node.tabIndex]), ["true", false, 0]);
  await up2.focus();
  await page.keyboard.press("Enter");
  await settled();
  is("pressing an arrow that cannot move keeps the focus on it", await focused(), "Move block 2 up");

  // Moved down from 2 to 3, then from 3 to 4, the last place: the focus rides with the arrow, and each place is said.
  await page.getByRole("button", { name: "Move block 2 down" }).focus();
  await page.keyboard.press("Enter");
  await settled();
  is("after a move, the focus is on the same arrow, now the block's at its new place", await focused(), "Move block 3 down");
  is("the move is said", (await status()).trim(), "Moved Text to position 3 of 4.");
  await page.keyboard.press("Enter");
  await settled();
  is("moved to the last place, the arrow is off and still holds the focus", [await focused(), await page.evaluate(() => document.activeElement?.getAttribute("aria-disabled"))], ["Move block 4 down", "true"]);
  is("the last move is said", (await status()).trim(), "Moved Text to position 4 of 4.");

  // Removed twice from the same place, the same sentence is still a change to the live region, so it is said again;
  // the focus goes to the block now in that place, never to the page's body.
  await page.evaluate(() => window.harness.mount(["hero", "text", "text", "faq"].map((kind) => window.harness.block(kind))));
  const said = [];
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Remove block 2, Text" }).focus();
    await page.keyboard.press("Enter");
    await settled();
    said.push(await status());
    // The first removal leaves hero, Text, Questions: the other Text now stands at 2. The second leaves hero, FAQ: the Questions block stands at 2.
    is(`after removal ${i + 1}, the focus is on the block now in its place`, await page.evaluate(() => ({ controls: document.activeElement?.getAttribute("aria-controls")?.startsWith("panel-") ?? false, label: document.activeElement?.querySelector("span")?.textContent ?? null })), { controls: true, label: i === 0 ? "2. Text" : "2. Questions" });
  }
  is("the same removal said twice is said again: the same words, a different text in the live region", [said[0].trim() === said[1].trim(), said[0] === said[1], said[0].trim()], [true, false, "Removed Text from position 2. Undo, at the top of the editor, brings it back."]);
  await page.evaluate(() => window.harness.mount(["hero", "text", "text", "faq"].map((kind) => window.harness.block(kind))));
  await page.getByRole("button", { name: "Move block 2 up" }).waitFor();

  // In forced colors, no icon button animates its colors: one that turns usable shows the system colors at once.
  const timing = () => page.evaluate(() => [...document.querySelectorAll(".icon-btn")].map((node) => getComputedStyle(node).transitionDuration).filter((d) => d !== "0s").length);
  is("outside forced colors the icon buttons keep their color transition", (await timing()) > 0, true);
  await page.emulateMedia({ forcedColors: "active" });
  is("forced colors are on for the next check", await page.evaluate(() => matchMedia("(forced-colors: active)").matches), true);
  is("in forced colors no icon button animates its colors", await timing(), 0);
  await page.emulateMedia({ forcedColors: "none" });

  // Move pressed three times within the history's 500 ms pause is one step: Undo and Redo name the block that went
  // back and forward, never one only pushed aside by it (Claude 5's MEDIUM on #2926; WCAG 4.1.3).
  await page.evaluate(() => window.harness.mount(["hero", "text", "faq", "video", "guarantee"].map((kind) => window.harness.block(kind))));
  await page.getByRole("button", { name: "Move block 5 up" }).focus();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Enter");
    await settled();
  }
  is("three quick Moves up take the Guarantee to position 2", (await status()).trim(), "Moved Guarantee to position 2 of 5.");
  await page.locator("#undo-step").click();
  await settled();
  is("Undo of the three Moves names the block that went back", (await status()).trim(), "Undone: Guarantee moved to position 5 of 5. Nothing more to undo.");
  await page.locator("#redo-step").click();
  await settled();
  is("Redo of the three Moves names the block that went forward", (await status()).trim(), "Redone: Guarantee moved to position 2 of 5. Nothing more to redo.");

  // A picture block's last picture removed while another is still being sent (#2926, candidate of the Codex M review):
  // the focus goes to the block's Add button, which says it is sending; it must stay on the page, never on the body.
  // The send is held by the page's route below, so it stays pending; nothing is uploaded.
  const png = pngOf(4, 4);
  const pictures = async () => {
    await page.evaluate(() => {
      const block = window.harness.block("pictures");
      window.harness.mount([{ ...block, items: [{ path: "images/0123456789abcdef01234567/0123456789abcdef0123456789abcdef.jpg", width: 4, height: 4, alt: "A synthetic picture", caption: "" }] }]);
    });
    const open = page.locator("button[aria-expanded]", { hasText: "1 picture" }).first();
    await open.click();
    await page.getByRole("button", { name: "Remove picture 1" }).waitFor();
  };
  const sending = () => page.getByRole("button", { name: /^Sending 1 picture/ });
  const where = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, words: document.activeElement?.textContent?.trim() ?? "", busy: document.activeElement?.getAttribute("aria-busy") ?? null }));

  await pictures();
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: png });
  await sending().waitFor();
  await page.getByRole("button", { name: "Remove picture 1" }).focus();
  await page.keyboard.press("Enter");
  await settled();
  await settled();
  is("removing the last picture while another is sent puts the focus on its Add button, which says it is sending", await where(), { tag: "BUTTON", words: "Sending 1 picture…", busy: "true" });
  await page.keyboard.press("Enter");
  await settled();
  is("pressing it while it sends starts nothing more: one send held", uploads.length, 1);

  // The Add button pressed, a picture chosen, and the send starting under the focus: the focus stays on it.
  await pictures();
  const add = page.getByRole("button", { name: /^Add pictures/ });
  await add.focus();
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: png });
  await sending().waitFor();
  await settled();
  is("a send starting under the focus keeps it on the Add button, which says it is sending", await where(), { tag: "BUTTON", words: "Sending 1 picture…", busy: "true" });

  // A block's last picture removed where the page has no room left for another (the other blocks, or the other version
  // of the page, hold the page's 24): no Add button is drawn then, so the focus goes to the block's heading field, never
  // to the body (Claude 5's LIGHT 1 on #2926; WCAG 2.4.3). Four full blocks and one holding a picture: synthetic.
  await page.evaluate(() => {
    const picture = (n) => ({ path: `images/0123456789abcdef01234567/${n.toString(16).padStart(32, "0")}.jpg`, width: 4, height: 4, alt: `Synthetic picture ${n}`, caption: "" });
    const full = (k) => ({ ...window.harness.block("pictures"), items: Array.from({ length: 6 }, (_, j) => picture(k * 6 + j + 1)) });
    window.harness.mount([full(0), full(1), full(2), full(3), { ...window.harness.block("pictures"), items: [picture(99)] }]);
  });
  await page.locator("button[aria-expanded]", { hasText: "1 picture" }).first().click();
  await page.getByRole("button", { name: "Remove picture 1" }).waitFor();
  is("with no room on the page, the block holding one picture draws no Add button", await page.getByRole("button", { name: /^Add pictures/ }).count(), 0);
  await page.getByRole("button", { name: "Remove picture 1" }).focus();
  await page.keyboard.press("Enter");
  await settled();
  await settled();
  is("removing that last picture puts the focus on the block's heading field", await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.labels?.[0]?.textContent ?? null })), { tag: "INPUT", label: "Heading (optional)" });

  // A picture in a column is one part of the row: the row's own Remove takes it away and sends the focus on, and the
  // picture's own list sends it nowhere, so nothing takes it after (Claude 5's LIGHT 2 on #2926). Synthetic row.
  await page.evaluate(() => {
    const picture = { path: "images/0123456789abcdef01234567/0123456789abcdef0123456789abcdee.jpg", width: 4, height: 4, alt: "A synthetic picture in a column", caption: "" };
    window.harness.mount([{ ...window.harness.block("row"), columns: [[{ kind: "image", picture, decorative: false }], []] }]);
  });
  await page.locator("button[aria-expanded]", { hasText: "Columns" }).first().click();
  const removePart = page.getByRole("button", { name: /^Remove: part 1 of column 1/ });
  await removePart.waitFor();
  is("a column's picture draws no Remove button of its own", await page.getByRole("button", { name: /^Remove picture/ }).count(), 0);
  await removePart.focus();
  await page.keyboard.press("Enter");
  for (let i = 0; i < 4; i++) await settled();
  is("the row's Remove sends the focus to the column's Add, and it stays there", await page.evaluate(() => document.activeElement?.id?.endsWith("-c0-add") ?? false), true);

  is("no error on the page", errors, []);
} finally {
  await browser.close();
}
console.log(`PAGE_EDITOR_ACTIONS: ${engine}, ${cases - failed} of ${cases} checks passed`);
if (failed) process.exit(1);
