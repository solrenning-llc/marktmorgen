// The deals board in a real browser (635 [GL3], AAA review of the board, AX274):
// focus after removing, saving, cancelling and moving (2.4.3, 2.4.11); a removal
// confirmed before anything is sent (3.3.6); a stage select that never writes
// (3.2.2, 3.2.5); an error tied to its field (3.3.1, 3.3.3); one status region,
// not said at each key (4.1.3); why a control is off (aria-describedby); the
// view-only notice once. The real component (components/deals-board.tsx) with
// synthetic deals and a stand-in for /api/store/crm kept in the page
// (tests/e2e/deals-board-harness.tsx): no server, no build, nothing sent.
// node tests/e2e/deals-board-focus.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");
const require = createRequire(join(root, "package.json"));
const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const driver = require("playwright-core")[engine];

let failed = 0, cases = 0;
function is(name, got, want) {
  cases++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(want)}\n      got      ${JSON.stringify(got)}`}`);
}

const bundle = await build({
  entryPoints: [join(root, "tests/e2e/deals-board-harness.tsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  logLevel: "error",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "next-navigation",
    setup(b) {
      // The studio's router: a refresh draws the board again from the stand-in's deals.
      b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-navigation", namespace: "stand-in" }));
      b.onLoad({ filter: /.*/, namespace: "stand-in" }, () => ({ contents: "export const useRouter = () => ({ refresh() { window.harness.refresh(); }, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} }); export const usePathname = () => '/studio/deals'; export const useSearchParams = () => new URLSearchParams();", loader: "js" }));
    },
  }],
});
const script = bundle.outputFiles[0].text;
// Only what the checks read: visually hidden text stays in the page, as in the studio.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Deals board check</title><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/board.js"></script></body></html>`;

const STAGES = [{ id: "lead00", name: "New", kind: "open" }, { id: "talk00", name: "Talking", kind: "open" }, { id: "offr00", name: "Offer sent", kind: "open" }, { id: "won000", name: "Won", kind: "won" }, { id: "lost00", name: "Lost", kind: "lost" }];
const deal = (id, title, stage, extra = {}) => ({ id, title, email: "", cents: 0, stage, note: "", nextAction: "", dueDate: "", assignee: "", createdAt: 1, updatedAt: 1, ...extra });
const v = (n) => String(n).padStart(32, "0");
const world = (extra = {}) => ({
  pipelines: [{ id: "sales0", name: "Sales", stages: STAGES }],
  deals: [deal("dealaaaaa1", "Coaching for Ana", "lead00"), deal("dealaaaaa2", "Course for Ben", "lead00"), deal("dealaaaaa3", "Project for Cy", "talk00"), deal("dealaaaaa4", "Workshop for Dee", "talk00")],
  versions: { dealaaaaa1: v(1), dealaaaaa2: v(2), dealaaaaa3: v(3), dealaaaaa4: v(4) },
  fields: [],
  ...extra,
});

// CHROMIUM=<path to the browser> runs it on a machine whose browser is not the one playwright-core expects (as tests/e2e/agreements.mjs).
const browser = await driver.launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("http://deals.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return path === "/board.js" ? route.fulfill({ contentType: "text/javascript", body: script }) : route.fulfill({ contentType: "text/html", body: html });
  });
  await page.goto("http://deals.test/");
  const mount = async (w) => {
    await page.evaluate((w) => window.harness.mount(w), w);
    await page.locator("#deals-title").waitFor();
  };
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  const writes = () => page.evaluate(() => window.harness.writes.map((w) => w.action));
  const press = async (id, key = "Enter") => { await page.locator("#" + id).focus(); await page.keyboard.press(key); };
  const settled = () => page.waitForFunction(() => !document.getElementById("deal-board-why")?.textContent?.includes("still being saved"));
  const attr = (id, name) => page.locator("#" + id).getAttribute(name);
  const text = (id) => page.locator("#" + id).textContent();

  await mount(world());

  // 4.1.3: one status region on the board, never said at each key.
  is("one status region on the board, and no other live region but the alerts", await page.evaluate(() => [document.querySelectorAll("#root [role=status]").length, document.querySelectorAll("#root [aria-live]").length]), [1, 0]);
  await page.evaluate(() => {
    window.statusChanges = 0;
    new MutationObserver(() => window.statusChanges++).observe(document.getElementById("deal-board-status"), { childList: true, characterData: true, subtree: true });
  });
  await page.locator("#deal-search").focus();
  await page.keyboard.type("for", { delay: 80 });
  is("typing in the search says nothing at each key", await page.evaluate(() => window.statusChanges), 0);
  await page.waitForFunction(() => document.getElementById("deal-board-status").textContent !== "", null, { timeout: 5000 });
  is("once typing stops, it says how many deals are shown, once and short", [await text("deal-board-status"), await page.evaluate(() => window.statusChanges)], ["Showing 4 of 4 deals.", 1]);
  await page.locator("#deal-search").fill("Ana");
  await page.locator("button", { hasText: "Clear selection" }).click();
  is("Clear selection gives focus back to the search box it cleared (2.4.3)", await active(), "deal-search");

  // 3.2.2, 3.2.5: choosing a stage never writes; Move does, and focus goes back to the deal's select.
  is("Move is off until a new stage is chosen, still focusable, and says why", [await attr("deal-move-dealaaaaa1", "aria-disabled"), await attr("deal-move-dealaaaaa1", "aria-describedby"), await text("deal-stage-hint-dealaaaaa1")], ["true", "deal-stage-hint-dealaaaaa1", "Choose a new stage, then press Move."]);
  await press("deal-move-dealaaaaa1");
  is("pressing Move with nothing chosen sends nothing and keeps focus", [await writes(), await active()], [[], "deal-move-dealaaaaa1"]);
  await page.locator("#deal-stage-dealaaaaa1").focus();
  // Arrowing through a closed select changes it at each key in Chromium; nothing may be sent (WebKit and Firefox open a list instead).
  if (engine === "chromium") await page.keyboard.press("ArrowDown");
  await page.locator("#deal-stage-dealaaaaa1").selectOption("offr00");
  is("changing the stage select sends nothing", await writes(), []);
  is("the status region says the stage chosen, and Move is on", [await text("deal-board-status"), await attr("deal-move-dealaaaaa1", "aria-disabled")], ["Stage chosen: Offer sent. Not moved yet.", null]);
  await press("deal-move-dealaaaaa1");
  await page.waitForFunction(() => window.harness.world.deals.find((d) => d.id === "dealaaaaa1").stage === "offr00");
  await settled();
  await page.waitForFunction(() => document.activeElement?.id === "deal-stage-dealaaaaa1", null, { timeout: 5000 }).catch(() => {});
  is("Move sends one change, and focus goes to the deal's stage select in its new stage (2.4.3)", [await writes(), await active(), await page.locator("#deal-column-offr00 ~ * #deal-stage-dealaaaaa1, section:has(#deal-column-offr00) #deal-stage-dealaaaaa1").count()], [["deal"], "deal-stage-dealaaaaa1", 1]);

  // 3.3.6: removing asks first; Escape or "Keep deal" keeps it, with focus back on Remove.
  await press("deal-remove-dealaaaaa3");
  is("Remove opens a question with focus on it, and sends nothing", [await active(), await writes(), await page.locator("#deal-confirm-dealaaaaa3").getAttribute("role")], ["deal-confirm-dealaaaaa3", ["deal"], "group"]);
  is("the question names the deal and says it cannot be undone", (await text("deal-confirm-dealaaaaa3")).includes("Remove “Project for Cy”?This deletes the deal and its note. You cannot get it back."), true);
  await page.keyboard.press("Escape");
  is("Escape keeps the deal, with focus back on its Remove button", [await active(), await page.locator("#deal-confirm-dealaaaaa3").count(), await writes()], ["deal-remove-dealaaaaa3", 0, ["deal"]]);
  await press("deal-remove-dealaaaaa3");
  await press("deal-keep-dealaaaaa3");
  is("Keep deal does the same", [await active(), await writes()], ["deal-remove-dealaaaaa3", ["deal"]]);
  // Removing: focus goes to the next deal of the stage, else the stage's heading.
  await press("deal-remove-dealaaaaa3");
  is("the question's first control is Remove deal, then Keep deal", await page.evaluate(() => [...document.querySelectorAll("#deal-confirm-dealaaaaa3 button")].map((b) => b.id)), ["deal-confirm-yes-dealaaaaa3", "deal-keep-dealaaaaa3"]);
  await page.evaluate(() => { window.harness.delay = 400; });
  await press("deal-confirm-yes-dealaaaaa3");
  await page.waitForTimeout(100);
  is("while it is removed, focus stays on the pressed button, which is off but not disabled (2.4.3)", [await active(), await attr("deal-confirm-yes-dealaaaaa3", "aria-disabled"), await page.locator("#deal-confirm-yes-dealaaaaa3").evaluate((button) => button.disabled)], ["deal-confirm-yes-dealaaaaa3", "true", false]);
  is("why it is off is said beside it", [(await attr("deal-confirm-yes-dealaaaaa3", "aria-describedby")) ?? "", await text("deal-board-why")], ["deal-board-why", "Please wait. Your last change is still being saved."]);
  await page.evaluate(() => { window.harness.delay = 60; });
  await page.waitForFunction(() => !document.getElementById("deal-remove-dealaaaaa3"));
  await settled();
  await page.waitForFunction(() => document.activeElement?.id === "deal-stage-dealaaaaa4", null, { timeout: 5000 }).catch(() => {});
  is("Remove deal sends the removal once; focus goes to the next deal in the stage", [await writes(), await active()], [["deal", "undeal"], "deal-stage-dealaaaaa4"]);
  await press("deal-remove-dealaaaaa4");
  await press("deal-confirm-yes-dealaaaaa4");
  await page.waitForFunction(() => !document.getElementById("deal-remove-dealaaaaa4"));
  await settled();
  await page.waitForFunction(() => document.activeElement?.id === "deal-column-talk00", null, { timeout: 5000 }).catch(() => {});
  is("the stage's last deal removed: focus goes to the stage's heading", await active(), "deal-column-talk00");

  // Opening and closing the editor (2.4.3), and why other controls are off meanwhile.
  await press("deal-edit-dealaaaaa2");
  is("Edit opens the editor with focus on its first field", await active(), "deal-field-title");
  is("meanwhile another deal's Remove is off, focusable, and says why", [await attr("deal-remove-dealaaaaa1", "aria-disabled"), await attr("deal-remove-dealaaaaa1", "aria-describedby"), await text("deal-board-why")], ["true", "deal-board-why", "Finish the open form first: save it or cancel it."]);
  await press("deal-remove-dealaaaaa1");
  is("pressing it does nothing", [await page.locator("#deal-confirm-dealaaaaa1").count(), await active()], [0, "deal-remove-dealaaaaa1"]);
  await press("deal-cancel");
  is("Cancel closes the editor and gives focus back to the Edit that opened it", [await page.locator("#deal-field-title").count(), await active()], [0, "deal-edit-dealaaaaa2"]);

  // 3.3.1, 3.3.3: an error tied to its field, with focus there; nothing sent for an empty name.
  await press("deal-edit-dealaaaaa2");
  await page.locator("#deal-field-title").fill("");
  await press("deal-save");
  is("an empty name is said beside the field, which gets focus; nothing is sent", [await active(), await attr("deal-field-title", "aria-invalid"), await attr("deal-field-title", "aria-describedby"), await text("deal-field-title-error"), await writes()], ["deal-field-title", "true", "deal-field-title-error", "Give the deal a name.", ["deal", "undeal", "undeal"]]);
  is("the alert stays empty, so the error is said once", await page.locator("fieldset [role=alert]").textContent(), "");
  await page.locator("#deal-field-title").fill("Course for Ben Jr");
  await page.locator("#deal-field-dueDate").fill("2026-12-01");
  await page.evaluate(() => { window.harness.next = { status: 400, body: { ok: false, error: "followup" } }; });
  await press("deal-save");
  await page.waitForFunction(() => document.getElementById("deal-field-nextAction")?.getAttribute("aria-invalid") === "true");
  is("a refusal about one field is said beside that field, which gets focus", [await active(), await attr("deal-field-nextAction", "aria-describedby"), await text("deal-field-nextAction-error"), await attr("deal-field-title", "aria-invalid")], ["deal-field-nextAction", "deal-field-nextAction-error", "Write a next action before setting its date. Keep it within 200 characters.", null]);
  await page.locator("#deal-field-nextAction").fill("Send the plan");
  await press("deal-save");
  await page.waitForFunction(() => !document.getElementById("deal-save"));
  await settled();
  await page.waitForFunction(() => document.activeElement?.id === "deal-edit-dealaaaaa2", null, { timeout: 5000 }).catch(() => {});
  is("a saved deal closes the editor and gives focus back to its Edit; its change was kept", [await active(), await page.evaluate(() => window.harness.world.deals.find((d) => d.id === "dealaaaaa2").title)], ["deal-edit-dealaaaaa2", "Course for Ben Jr"]);

  // The pipeline editor: focus on open, Up at the top keeps focus, a removed stage's neighbor, Cancel.
  await press("pipeline-change");
  is("the pipeline editor opens with focus on its name", await active(), "pipeline-name");
  await press("stage-up-talk00");
  is("Up moves the stage and keeps focus on it, now off at the top and saying why", [await active(), await attr("stage-up-talk00", "aria-disabled"), (await attr("stage-up-talk00", "aria-describedby")) ?? ""], ["stage-up-talk00", "true", "stage-edges"]);
  await press("stage-up-talk00");
  is("pressing it at the top does nothing and keeps focus", [await active(), await page.evaluate(() => document.querySelector("#stage-name-talk00").closest("li") === document.querySelector("ol li"))], ["stage-up-talk00", true]);
  await page.locator('[aria-label="Remove stage 1"]').focus();
  await page.keyboard.press("Enter");
  is("removing a stage gives focus to the next stage's name", await active(), "stage-name-lead00");
  await page.locator("#stage-name-lead00").fill("");
  await press("pipeline-save");
  is("an empty stage name is said beside it, with focus there, and nothing is sent", [await active(), await attr("stage-name-lead00", "aria-invalid"), await text("stage-name-lead00-error"), (await writes()).length], ["stage-name-lead00", "true", "Keep at least one open stage, one won and one lost, each with a name.", 5]);
  await press("pipeline-cancel");
  is("Cancel gives focus back to the button that opened the editor", await active(), "pipeline-change");

  // The fields editor.
  await press("crm-fields-change");
  is("the fields editor opens on \"Add a field\" when there is none", await active(), "crm-field-add");
  await page.keyboard.press("Enter");
  const fieldName = await active();
  is("a field added gets focus on its name", fieldName.startsWith("crm-field-name-"), true);
  await press("crm-fields-save");
  is("a field with no name is said beside it, with focus there", [await active(), await attr(fieldName, "aria-invalid")], [fieldName, "true"]);
  await press("crm-fields-cancel");
  is("Cancel gives focus back to the button that opened it", await active(), "crm-fields-change");

  // A change that could not be confirmed is said once, and the board says why it is paused.
  await press("deal-edit-dealaaaaa1");
  await page.locator("#deal-field-note").fill("Call on Monday");
  await page.evaluate(() => { window.harness.next = { status: 502, body: { ok: false, error: "crm_write_unconfirmed" } }; });
  await press("deal-save");
  await page.waitForFunction(() => document.getElementById("deal-board-why")?.textContent?.includes("reload"));
  const unconfirmed = "The change could not be confirmed and may already have happened.";
  is("the unconfirmed change is said once, in the alert, not in a status region too", [await page.evaluate((w) => document.body.innerText.split(w).length - 1, unconfirmed), (await page.locator("fieldset [role=alert]").textContent()).startsWith(unconfirmed), (await text("deal-board-status")).includes(unconfirmed)], [1, true, false]);
  is("Save stays focusable, off, and says why", [await active(), await attr("deal-save", "aria-disabled"), await text("deal-board-why")], ["deal-save", "true", "Changes are paused until you reload this page."]);

  // 639 [GL7](7): a pipeline this person may only see says so once, at the top of the board.
  await mount(world({ viewOnly: ["sales0"] }));
  is("the view-only notice is shown once, at the top of the board, and no change control is drawn", [await page.evaluate(() => document.body.innerText.split("You can see this pipeline but not change it.").length - 1), await page.locator("#deal-board-view-only").count(), await page.locator('[id^="deal-remove-"], [id^="deal-edit-"], #deal-new').count()], [1, 1, 0]);

  is("no error in the page", errors, []);
  await context.close();
} finally {
  await browser.close();
}
console.log(`\n${cases} checks, ${failed} failing (${engine}).`);
process.exit(failed ? 1 : 0);
