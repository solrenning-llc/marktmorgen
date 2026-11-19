// A quiz's answers kept in the student's browser (297 [SQ8]) in a real browser: the real QuizKeep inside a form
// shaped like components/lesson-quiz.tsx's; every request is intercepted, nothing leaves the machine.
// node tests/e2e/quiz-keep.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
/** A lesson's quiz for one student (`who`, the server's code) with `tries` already recorded and the questions `shown`. */
const fixture = ({ shown = "aaaaaaaaaaa1,aaaaaaaaaaa2", who = "a".repeat(32), tries = 0, version = "v1" } = {}) => build({
  stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {QuizKeep} from '@/components/quiz-keep';
    import {COURSES_WORDS} from '@/lib/buyer-words/courses';
    const w = COURSES_WORDS.en;
    const shown = ${JSON.stringify(shown)};
    createRoot(document.getElementById('root')).render(
      <form action="https://quiz.test/sent" method="post">
        <input type="hidden" name="handle" value="shop" />
        <input type="hidden" name="shown" value={shown} />
        <QuizKeep who=${JSON.stringify(who)} shown={shown} tries={${tries}} version=${JSON.stringify(version)} language="en" words={{ quizKeptBack: w.quizKeptBack, quizKeptClear: w.quizKeptClear, quizKeptCleared: w.quizKeptCleared, quizKeepDevice: w.quizKeepDevice, quizKeepDeviceHint: w.quizKeepDeviceHint, quizKeptAsk: w.quizKeptAsk, quizKeptRestore: w.quizKeptRestore, quizKeptStartOver: w.quizKeptStartOver }} />
        <fieldset><legend>One?</legend>
          <label><input type="radio" name="q_aaaaaaaaaaa1" value="0" /> A</label>
          <label><input type="radio" name="q_aaaaaaaaaaa1" value="1" /> B</label>
        </fieldset>
        <fieldset><legend>Two?</legend>
          <label><input type="checkbox" name="q_aaaaaaaaaaa2" value="0" /> C</label>
          <label><input type="checkbox" name="q_aaaaaaaaaaa2" value="1" /> D</label>
        </fieldset>
        <button type="submit">Check my answers</button>
      </form>
    );
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
}).then((b) => b.outputFiles[0].text);
/** The lesson while its quiz cannot be answered (passed, out of tries, or waiting between tries): QuizForget alone. */
const forgetFixture = ({ who = "a".repeat(32), tries = 0, final = false } = {}) => build({
  stdin: { contents: `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {QuizForget} from '@/components/quiz-keep';
    createRoot(document.getElementById('root')).render(<p>Result<QuizForget who=${JSON.stringify(who)} tries={${tries}} final={${final}} /></p>);
  `, resolveDir: root, loader: "tsx" },
  bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
  alias: { "@": root }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error",
}).then((b) => b.outputFiles[0].text);
const ada = await fixture();
const adaPassed = await forgetFixture({ final: true });
const adaWaiting = await forgetFixture({ final: false });
const adaOtherQuestions = await fixture({ shown: "aaaaaaaaaaa1,aaaaaaaaaaa9" });
const adaAfterRecordedTry = await fixture({ tries: 1 });
const adaQuizChanged = await fixture({ version: "v2" });
const bo = await fixture({ who: "b".repeat(32) });

const engine = process.env.E2E_BROWSER ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw Error("Unsupported engine " + engine);
const browser = await require("playwright-core")[engine].launch(engine === "chromium" && process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
let checks = 0, failures = 0;
function is(name, got, expected) {
  checks++;
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${ok ? "" : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`}`);
}
const ADA = `mm:quiz:${"a".repeat(32)}`;
const BACK = "Your answers from last time are back. They are not checked until you press the button below.";
try {
  const context = await browser.newContext();
  const tab = await context.newPage(), errors = [], sent = [];
  tab.setDefaultTimeout(5000);
  tab.on("pageerror", (error) => errors.push(error.message));
  let answer = "refuse";
  await context.route("**/*", (route) => route.abort());
  await context.route("https://quiz.test/", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Quiz keep check</title><body><main id="root"></main></body></html>' }));
  await context.route("https://quiz.test/sent", (route) => {
    sent.push(route.request().postData());
    // The quiz route's own refusal when a store's monthly quiz allowance is used: nothing was counted.
    if (answer === "refuse") return route.fulfill({ status: 429, contentType: "text/plain", body: "This store has reached its monthly quiz submission allowance." });
    return route.abort("internetdisconnected");
  });
  const open = async (script) => {
    await tab.goto("https://quiz.test/");
    await tab.addScriptTag({ content: script });
    await tab.getByRole("button", { name: "Check my answers" }).waitFor();
  };
  const picked = () => tab.evaluate(() => [...document.querySelectorAll('input[name^="q_"]')].map((i) => i.checked));
  // By default a draft lives in this tab's session storage only; the device's storage holds one only when the student
  // chose "Keep my answers on this device for 7 days" (review of #4324, the plan of 6995178754).
  const kept = () => tab.evaluate((k) => sessionStorage.getItem(k), ADA);
  const onDevice = () => tab.evaluate((k) => localStorage.getItem(k), ADA);
  const DEVICE = "Keep my answers on this device for 7 days";
  // QuizKeep puts a draft back, or forgets it, in an effect after the form is drawn: wait for it before reading
  // (review of #4324, LOW 4), never read what the page held a moment before.
  const putBack = (count) => tab.waitForFunction((n) => document.querySelectorAll('input[name^="q_"]:checked').length === n, count);
  const forgotten = () => tab.waitForFunction((k) => sessionStorage.getItem(k) === null && localStorage.getItem(k) === null, ADA);
  const status = () => tab.getByRole("status").textContent();
  // Nothing is put back until the student asks (review of #4324, MEDIUM 9; WCAG 3.3.6 and 4.1.3).
  const ask = () => tab.getByText(/^Restore your answers from .+\?$/);
  const restore = async () => {
    await tab.getByRole("button", { name: "Restore", exact: true }).click();
  };

  await open(ada);
  is("nothing kept and nothing said at first, though the status line is already there, empty", [await kept(), await status()], [null, ""]);
  await tab.getByLabel("B", { exact: true }).check();
  await tab.getByLabel("D", { exact: true }).check();
  is("each choice is kept in this tab as it is made, under this student's code", JSON.parse(await kept()).answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] });
  is("and not on the device: keeping it there is off by default", [await onDevice(), await tab.getByLabel(DEVICE).isChecked()], [null, false]);
  is("nothing was sent", sent.length, 0);
  await tab.getByLabel(DEVICE).check();
  is("choosing to keep it on the device moves the draft there", [JSON.parse((await onDevice()) ?? "null")?.answers, await kept()], [{ q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] }, null]);
  await tab.getByLabel(DEVICE).uncheck();
  is("and turning it off takes it off the device again, back to this tab only", [await onDevice(), JSON.parse((await kept()) ?? "null")?.answers], [null, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] }]);

  await open(ada);
  await ask().waitFor();
  is("coming back asks first, with the draft's date, and puts nothing back on its own", [await picked(), await status(), await tab.getByRole("button", { name: "Start over" }).count()], [[false, false, false, false], "", 1]);
  await restore();
  await putBack(2);
  is("Restore puts the choices back", await picked(), [false, true, false, true]);
  await tab.getByRole("status").filter({ hasText: "are back" }).waitFor();
  is("and says so in the status line, only after the student asked", [await status(), await ask().count()], [BACK, 0]);
  await tab.getByLabel("A", { exact: true }).check();
  await tab.getByLabel("B", { exact: true }).check();
  is("the first change clears the status line", await status(), "");

  await tab.getByRole("button", { name: "Check my answers" }).click();
  await tab.getByText("monthly quiz submission allowance").waitFor();
  is("the server refused the try (429): the draft is still there", [sent.length, JSON.parse(await kept()).answers], [1, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] }]);
  await open(ada);
  await restore();
  await putBack(2);
  is("and the lesson puts the answers back", await picked(), [false, true, false, true]);

  answer = "offline";
  await tab.getByRole("button", { name: "Check my answers" }).click().catch(() => {});
  await tab.waitForTimeout(300);
  await open(ada);
  await restore();
  await putBack(2);
  is("the connection dropped on sending: still put back", await picked(), [false, true, false, true]);
  await open(ada);
  await tab.getByRole("button", { name: "Start over" }).click();
  is("Start over puts nothing back and forgets the draft", [await picked(), await kept(), await ask().count()], [[false, false, false, false], null, 0]);
  await tab.getByLabel("B", { exact: true }).check();
  await tab.getByLabel("D", { exact: true }).check();

  await open(bo);
  is("another student on the same browser gets nothing back, and sees no one's answers", [await picked(), await status(), await tab.getByRole("button", { name: "Clear my answers" }).count()], [[false, false, false, false], "", 0]);
  is("and the first student's draft is left alone", JSON.parse(await kept()).answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] });

  await open(adaAfterRecordedTry);
  await forgotten();
  is("once the server recorded a try, the draft is never put back, and is forgotten", [await picked(), await kept()], [[false, false, false, false], null]);

  await open(ada);
  await tab.getByLabel("A", { exact: true }).check();
  await open(ada);
  await restore();
  await tab.getByRole("button", { name: "Clear my answers" }).click();
  is("Clear my answers empties the choices and forgets them", [await picked(), await kept()], [[false, false, false, false], null]);
  is("says so, and the focus goes to the quiz's first choice, not nowhere", [await status(), await tab.evaluate(() => document.activeElement?.getAttribute("name"))], ["Your answers are cleared.", "q_aaaaaaaaaaa1"]);

  await tab.getByLabel("A", { exact: true }).check();
  await open(adaQuizChanged);
  await forgotten();
  is("a quiz the creator changed since never gets the old choices, and they are forgotten (review of #4324)", [await picked(), await kept(), await status()], [[false, false, false, false], null, ""]);

  await open(ada);
  await tab.getByLabel("A", { exact: true }).check();
  await open(adaOtherQuestions);
  await forgotten();
  is("a try with other questions never gets them, and they are forgotten", [await picked(), await kept(), await status()], [[false, false, false, false], null, ""]);

  // Review of #4324 (LOW 7): the lesson for a student who passed or used the last try draws QuizForget with `final`,
  // and the draft goes the moment the lesson opens; while they only wait between tries, a draft never sent stays.
  const openForget = async (script) => {
    await tab.goto("https://quiz.test/");
    await tab.addScriptTag({ content: script });
    await tab.locator("[data-quiz-forget]").waitFor({ state: "attached" });
  };
  await open(ada);
  await tab.getByLabel("B", { exact: true }).check();
  is("(control) a draft is kept before the lesson closes", JSON.parse(await kept()).answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] });
  await openForget(adaWaiting);
  await tab.waitForTimeout(200);
  is("waiting between tries, at the same count: the draft never sent stays", JSON.parse((await kept()) ?? "null")?.answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [] });
  await openForget(adaPassed);
  await forgotten();
  is("passed or out of tries (final): the draft is gone once the lesson opens", await kept(), null);

  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
    Object.defineProperty(window, "sessionStorage", { get() { throw new Error("denied"); } });
  });
  await open(ada);
  await tab.getByLabel("B", { exact: true }).check();
  is("a browser that keeps nothing: the quiz still works, nothing is said", [await tab.getByLabel("B", { exact: true }).isChecked(), await status()], [true, ""]);
  is("no script error", errors, []);
} finally {
  await browser.close();
}
console.log(`${engine}: ${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
