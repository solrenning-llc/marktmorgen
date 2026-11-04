// The deals board in a real browser (635 [GL3], AAA review of the board, AX274):
// focus after removing, saving, cancelling and moving (2.4.3, 2.4.11); a removal
// confirmed before anything is sent (3.3.6); a stage select that never writes
// (3.2.2, 3.2.5); an error tied to its field (3.3.1, 3.3.3); one status region,
// not said at each key (4.1.3); why a control is off (aria-describedby); the
// view-only notice once; an off control never faded, so its focus ring keeps
// its contrast (app/globals.css is loaded as the studio loads it). The real component (components/deals-board.tsx) with
// synthetic deals and a stand-in for /api/store/crm kept in the page
// (tests/e2e/deals-board-harness.tsx): no server, no build, nothing sent.
// node tests/e2e/deals-board-focus.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
const css = readFileSync(join(root, "app/globals.css"), "utf8");
// The site's own stylesheet (its Tailwind lines are skipped by the browser), so what is checked is what the studio draws.
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Deals board check</title><link rel="stylesheet" href="/globals.css"><style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style></head><body><main id="root"></main><script>window.process={env:{NODE_ENV:"production"}};</script><script src="/board.js"></script></body></html>`;

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
/** A page holding the board, in a context of its own (the access mode under test). */
async function boardPage(context, errors) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("http://deals.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/board.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === "/globals.css") return route.fulfill({ contentType: "text/css", body: css });
    return path === "/" ? route.fulfill({ contentType: "text/html", body: html }) : route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://deals.test/");
  return page;
}
/** How a focused control is drawn: the opacity it is painted with (its own and its parents'), its words' contrast, and its focus ring's contrast on the board's three surfaces (white, paper, sand). */
const drawn = (page, id) => page.evaluate((id) => {
  const el = document.getElementById(id);
  const rgb = (c) => (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
  const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const style = getComputedStyle(el);
  let opacity = 1;
  for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
  const ring = rgb(style.outlineColor);
  const edge = rgb(style.borderTopColor);
  return { edge: Math.min(...[[255, 255, 255], [239, 236, 229]].map((bg) => ratio(edge, bg))), color: style.color, focused: document.activeElement === el, opacity, text: ratio(rgb(style.color), rgb(style.backgroundColor)), ring: Math.min(...[[255, 255, 255], [247, 245, 240], [239, 236, 229]].map((bg) => ratio(ring, bg))), ringStyle: style.outlineStyle, border: style.borderTopStyle };
}, id);

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  const page = await boardPage(context, errors);
  const mount = async (w) => {
    await page.evaluate((w) => window.harness.mount(w), w);
    await page.locator("#deals-title").waitFor();
  };
  const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  const writes = () => page.evaluate(() => window.harness.writes.map((w) => w.action));
  const press = async (id, key = "Enter") => { await page.locator("#" + id).focus(); await page.keyboard.press(key); };
  const settled = () => page.waitForFunction(() => !document.getElementById("deal-board-why")?.textContent?.startsWith("Please wait"));
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
  // The count after clearing is said once typing has stopped; let it be said before counting what comes next.
  await page.waitForTimeout(1200);

  // 3.2.2, 3.2.5: choosing a stage never writes; Move does, and focus goes back to the deal's select.
  is("Move is off until a new stage is chosen, still focusable, and says why", [await attr("deal-move-dealaaaaa1", "aria-disabled"), await attr("deal-move-dealaaaaa1", "aria-describedby"), await text("deal-stage-hint-dealaaaaa1")], ["true", "deal-stage-hint-dealaaaaa1", "Choose a new stage, then press Move."]);
  // H2: an off control holding the keyboard focus is never faded, so its words keep 7:1 and its ring 3:1.
  await page.locator("#deal-stage-dealaaaaa1").focus();
  await page.keyboard.press("Tab");
  const offMove = await drawn(page, "deal-move-dealaaaaa1");
  is("an off Move reached by Tab is focused and not faded (opacity 1, dashed border)", [offMove.focused, offMove.opacity, offMove.border, offMove.ringStyle], [true, 1, "dashed", "solid"]);
  is("its words keep at least 7:1 and its focus ring at least 3:1 on white, paper and sand", [offMove.text >= 7, offMove.ring >= 3], [true, true]);
  is("its dashed edge is light but seen: at least 3:1 on white and sand, under 5:1 (never louder than a working button)", [offMove.edge >= 3, offMove.edge < 5], [true, true]);
  const hint = await page.locator("#deal-stage-hint-dealaaaaa1").boundingBox();
  is("why Move is off is shown beside it, not only to a screen reader", [await text("deal-stage-hint-dealaaaaa1"), !!hint && hint.width > 40 && hint.height > 8], ["Choose a new stage, then press Move.", true]);
  await press("deal-move-dealaaaaa1");
  is("pressing Move with nothing chosen sends nothing and keeps focus", [await writes(), await active()], [[], "deal-move-dealaaaaa1"]);
  // M1: arrowing or picking through the stages says nothing at each one; the last choice is said after a pause.
  await page.evaluate(() => { window.statusChanges = 0; });
  for (const stage of ["talk00", "offr00", "lost00"]) await page.locator("#deal-stage-dealaaaaa1").selectOption(stage);
  is("choosing three stages in a row says nothing yet", await page.evaluate(() => window.statusChanges), 0);
  await page.waitForFunction(() => document.getElementById("deal-board-status").textContent.includes("Lost"), null, { timeout: 5000 });
  is("after a pause, only the last choice is said, once", [await text("deal-board-status"), await page.evaluate(() => window.statusChanges)], ["Stage chosen: Lost. Not moved yet.", 1]);
  await page.locator("#deal-stage-dealaaaaa1").selectOption("lead00");
  await page.waitForTimeout(1000);
  is("going back to where the deal is says nothing more", await page.evaluate(() => window.statusChanges), 1);
  // L-A: a choice dropped by opening an editor is never said.
  await page.locator("#deal-stage-dealaaaaa1").selectOption("won000");
  await press("deal-edit-dealaaaaa2");
  await page.waitForTimeout(1200);
  is("a stage choice dropped when an editor opens is never said", await page.evaluate(() => window.statusChanges), 1);
  await press("deal-cancel");
  await page.locator("#deal-stage-dealaaaaa1").focus();
  // Arrowing through a closed select changes it at each key in Chromium; nothing may be sent (WebKit and Firefox open a list instead).
  if (engine === "chromium") await page.keyboard.press("ArrowDown");
  await page.locator("#deal-stage-dealaaaaa1").selectOption("offr00");
  is("changing the stage select sends nothing", await writes(), []);
  await page.waitForFunction(() => document.getElementById("deal-board-status").textContent.includes("Offer sent"), null, { timeout: 5000 });
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
  is("the question's first control is the safe one, Keep deal, then Remove deal", await page.evaluate(() => [...document.querySelectorAll("#deal-confirm-dealaaaaa3 button")].map((b) => b.id)), ["deal-keep-dealaaaaa3", "deal-confirm-yes-dealaaaaa3"]);
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
  await page.locator("#deal-field-title").focus();
  await page.keyboard.type("C");
  is("typing in the field clears its error mark and its words", [await attr("deal-field-title", "aria-invalid"), await page.locator("#deal-field-title-error").count(), await attr("deal-field-title", "aria-describedby")], [null, 0, null]);
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

  // H1: a save refused because the deal changed meanwhile (409) moves focus from Save to the first part in conflict.
  await press("deal-edit-dealaaaaa1");
  await page.evaluate(() => {
    const w = window.harness.world;
    w.deals = w.deals.map((d) => (d.id === "dealaaaaa1" ? { ...d, title: "Coaching for Ana (team)", updatedAt: d.updatedAt + 1 } : d));
    w.versions = { ...w.versions, dealaaaaa1: "f".repeat(32) };
  });
  await page.locator("#deal-field-title").fill("Coaching for Ana Lee");
  await press("deal-save");
  await page.waitForFunction(() => document.body.innerText.includes("This deal changed while you were editing"));
  await page.waitForFunction(() => document.activeElement?.id === "deal-field-title", null, { timeout: 5000 }).catch(() => {});
  is("after a 409, focus goes to the first part in conflict, which says what is saved now", [await active(), await page.locator("#deal-saved-title").textContent(), await page.locator("#deal-field-title").inputValue()], ["deal-field-title", "Saved now: Coaching for Ana (team)", "Coaching for Ana Lee"]);
  // M2, M3: while it is saved again, the editor's controls are off, drawn so (never faded), and say why beside the buttons.
  await page.evaluate(() => { window.harness.delay = 600; });
  await press("deal-save");
  await page.waitForTimeout(150);
  const useThis = page.locator("button", { hasText: "Use this" });
  is("\"Use this\" is off while saving, and says why", [await useThis.getAttribute("aria-disabled"), await useThis.getAttribute("aria-describedby")], ["true", "deal-board-editor-why"]);
  is("a select and a field of the editor are off, pointing to the words beside the buttons", [await attr("deal-field-stage", "aria-disabled"), ((await attr("deal-field-stage", "aria-describedby")) ?? "").split(" ").includes("deal-board-editor-why"), await attr("deal-field-note", "aria-disabled"), await page.locator("#deal-field-note").evaluate((n) => n.readOnly), await text("deal-board-editor-why")], ["true", true, "true", true, "Please wait. Your last change is still being saved."]);
  const offSelect = await drawn(page, "deal-field-stage");
  is("an off select is drawn as off without fading: opacity 1, dashed border, words at 7:1 or more", [offSelect.opacity, offSelect.border, offSelect.text >= 7], [1, "dashed", true]);
  const busySave = await drawn(page, "deal-save");
  is("Save keeps focus while saving, unfaded, its ring at 3:1 or more", [busySave.focused, busySave.opacity, busySave.ring >= 3], [true, 1, true]);
  await page.evaluate(() => { window.harness.delay = 60; });
  await page.waitForFunction(() => !document.getElementById("deal-save"));
  await settled();
  await page.waitForFunction(() => document.activeElement?.id === "deal-edit-dealaaaaa1", null, { timeout: 5000 }).catch(() => {});
  is("saved over the deal as it is now: focus back on its Edit", [await active(), await page.evaluate(() => window.harness.world.deals.find((d) => d.id === "dealaaaaa1").title)], ["deal-edit-dealaaaaa1", "Coaching for Ana Lee"]);

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
  is("an empty stage name is said beside it, with focus there, and nothing is sent", [await active(), await attr("stage-name-lead00", "aria-invalid"), await text("stage-name-lead00-error"), (await writes()).includes("pipeline")], ["stage-name-lead00", "true", "Keep at least one open stage, one won and one lost, each with a name.", false]);
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
  // M-B: two fields without a name; removing the first keeps the second's error shown and pointed to.
  await press("crm-field-add");
  const secondName = await active();
  await press("crm-fields-save");
  is("both fields without a name are marked", [await attr(fieldName, "aria-invalid"), await attr(secondName, "aria-invalid")], ["true", "true"]);
  await page.locator('[aria-label="Remove field 1"]').focus();
  await page.keyboard.press("Enter");
  const pointsTo = (await attr(secondName, "aria-describedby")) ?? "";
  is("after removing the first, the second keeps its error, shown and pointed to", [await active(), await attr(secondName, "aria-invalid"), pointsTo ? (await page.locator("#" + pointsTo.split(" ")[0]).textContent().catch(() => null)) : null], [secondName, "true", "Each field needs a name of its own, and a choice needs at least two options."]);
  // L-B: a choice with one option, then made plain text: its error goes.
  await page.locator("#" + secondName).fill("Offer");
  const secondId = secondName.slice("crm-field-name-".length);
  await page.locator('[aria-label="Kind of field 1"]').selectOption("choice");
  await page.locator("#crm-field-choices-" + secondId).fill("Coaching");
  await press("crm-fields-save");
  is("one option is not enough: the choices are marked", await attr("crm-field-choices-" + secondId, "aria-invalid"), "true");
  await page.locator('[aria-label="Kind of field 1"]').selectOption("text");
  is("made plain text, the field has no error left on screen", [await page.locator("#crm-field-choices-" + secondId + "-error").count(), await page.locator("fieldset [aria-invalid=true]").count()], [0, 0]);
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

  // H3: a moved deal that leaves the board (out of the filter, or to another pipeline) gives focus to the next deal of the stage it
  // left, else to that stage's heading.
  const overdue = { nextAction: "Call back", dueDate: "2026-11-01" };
  await mount(world({ deals: [deal("dealoooo01", "Overdue one", "lead00", overdue), deal("dealoooo02", "Overdue two", "lead00", overdue), deal("dealoooo03", "Not dated", "lead00")], versions: { dealoooo01: v(11), dealoooo02: v(12), dealoooo03: v(13) } }));
  await page.locator("button", { hasText: "Overdue (2)" }).click();
  const moveAway = async (id, stage) => {
    await page.locator("#deal-stage-" + id).selectOption(stage);
    await press("deal-move-" + id);
    await page.waitForFunction((id) => !document.getElementById("deal-stage-" + id), id, { timeout: 5000 });
    await settled();
    await page.waitForTimeout(200);
  };
  // M-A: refused because the deal changed meanwhile (409), and no longer shown under the filter: says so; focus goes to the next deal.
  await page.locator("#deal-stage-dealoooo01").selectOption("won000");
  await page.evaluate(() => {
    const w = window.harness.world;
    w.deals = w.deals.map((d) => (d.id === "dealoooo01" ? { ...d, nextAction: "", dueDate: "", updatedAt: d.updatedAt + 1 } : d));
    w.versions = { ...w.versions, dealoooo01: "e".repeat(32) };
    window.harness.refreshDelay = 1000;
  });
  await press("deal-move-dealoooo01");
  // L-F: once answered, the board says it is loading, never that a change is still being saved.
  await page.waitForFunction(() => document.getElementById("deal-board-why")?.textContent?.includes("loading"), null, { timeout: 5000 }).catch(() => {});
  is("after the answer, while the board loads, it says so (not \"still being saved\")", await page.evaluate(() => document.getElementById("deal-board-why")?.textContent ?? ""), "Please wait. The latest deals are loading.");
  await page.evaluate(() => { window.harness.refreshDelay = 0; });
  await page.waitForFunction(() => !document.getElementById("deal-stage-dealoooo01"), null, { timeout: 5000 });
  await settled();
  await page.waitForTimeout(200);
  is("a refused move of a deal that left the filter says so, and focus goes to the next deal of its stage", [await page.locator("#deal-board-alert").textContent(), await active(), (await writes()).filter((w) => w === "deal").length], ["This deal changed a moment ago, so it was not moved. It no longer matches your search or filter, so it is not shown here.", "deal-stage-dealoooo02", 1]);
  await mount(world({ deals: [deal("dealoooo01", "Overdue one", "lead00", overdue), deal("dealoooo02", "Overdue two", "lead00", overdue), deal("dealoooo03", "Not dated", "lead00")], versions: { dealoooo01: v(11), dealoooo02: v(12), dealoooo03: v(13) } }));
  await page.locator("button", { hasText: "Overdue (2)" }).click();
  await moveAway("dealoooo01", "won000");
  is("moved to Won under \"Overdue\", it leaves the list: focus goes to the next deal of its stage", await active(), "deal-stage-dealoooo02");
  await moveAway("dealoooo02", "won000");
  is("the stage's last one: focus goes to the stage's heading", await active(), "deal-column-lead00");
  const coaching = { id: "coach0", name: "Coaching", stages: [{ id: "cnew00", name: "Intro call", kind: "open" }, { id: "cwon00", name: "Signed", kind: "won" }, { id: "clost0", name: "Passed", kind: "lost" }] };
  await mount(world({ pipelines: [{ id: "sales0", name: "Sales", stages: STAGES }, coaching], deals: [deal("dealpppp01", "Plan one", "lead00"), deal("dealpppp02", "Plan two", "lead00"), deal("dealpppp03", "Other", "cnew00")], versions: { dealpppp01: v(21), dealpppp02: v(22), dealpppp03: v(23) } }));
  // L4: the count said is this pipeline's deals, as the board shows them.
  await page.locator("#deal-search").fill("Plan");
  await page.waitForFunction(() => document.getElementById("deal-board-status").textContent !== "", null, { timeout: 5000 });
  is("the count said is of this pipeline's deals", await text("deal-board-status"), "Showing 2 of 2 deals.");
  await page.locator("#deal-search").fill("");
  await moveAway("dealpppp01", "cnew00");
  is("moved to another pipeline, it leaves the board: focus goes to the next deal of its stage", await active(), "deal-stage-dealpppp02");
  // M-A: refused because someone moved it to another pipeline meanwhile: names that pipeline; focus goes to the stage's heading.
  await page.locator("#deal-stage-dealpppp02").selectOption("talk00");
  await page.evaluate(() => {
    const w = window.harness.world;
    w.deals = w.deals.map((d) => (d.id === "dealpppp02" ? { ...d, stage: "cnew00", updatedAt: d.updatedAt + 1 } : d));
    w.versions = { ...w.versions, dealpppp02: "d".repeat(32) };
  });
  await press("deal-move-dealpppp02");
  await page.waitForFunction(() => !document.getElementById("deal-stage-dealpppp02"), null, { timeout: 5000 });
  await settled();
  await page.waitForTimeout(200);
  is("a refused move of a deal now in another pipeline names it, and focus goes to the stage's heading", [await page.locator("#deal-board-alert").textContent(), await active()], ["This deal changed a moment ago and is now in Coaching, so it was not moved. Open Coaching to check it.", "deal-column-lead00"]);

  // 639 [GL7](7): a pipeline this person may only see says so once, at the top of the board.
  await mount(world({ viewOnly: ["sales0"] }));
  is("the view-only notice is shown once, at the top of the board, and no change control is drawn", [await page.evaluate(() => document.body.innerText.split("You can see this pipeline but not change it.").length - 1), await page.locator("#deal-board-view-only").count(), await page.locator('[id^="deal-remove-"], [id^="deal-edit-"], #deal-new').count()], [1, 1, 0]);

  is("no error in the page", errors, []);
  await context.close();

  // H2 in Windows high contrast (forced-colors): an off control stays unfaded and still shows it is off (dashed border).
  const forced = await browser.newContext({ viewport: { width: 1280, height: 900 }, forcedColors: "active" });
  const forcedErrors = [];
  const forcedPage = await boardPage(forced, forcedErrors);
  await forcedPage.evaluate((w) => window.harness.mount(w), world());
  await forcedPage.locator("#deal-stage-dealaaaaa1").focus();
  await forcedPage.keyboard.press("Tab");
  const forcedMove = await drawn(forcedPage, "deal-move-dealaaaaa1");
  is("in forced colors, a focused off Move is not faded, keeps a dashed border and its focus ring", [forcedMove.focused, forcedMove.opacity, forcedMove.border, forcedMove.ringStyle !== "none", forcedErrors], [true, 1, "dashed", true, []]);
  const grayText = await forcedPage.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "GrayText"; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
  is("in forced colors, its words take the system's color for an unavailable control (GrayText)", forcedMove.color, grayText);
  await forced.close();
} finally {
  await browser.close();
}
console.log(`\n${cases} checks, ${failed} failing (${engine}).`);
process.exit(failed ? 1 : 0);
