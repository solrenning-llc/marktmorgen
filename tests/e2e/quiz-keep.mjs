// A quiz's answers kept in the student's browser (297 [SQ8]) in a real browser: the real QuizKeep inside a form
// shaped like components/lesson-quiz.tsx's; every request is intercepted, nothing leaves the machine.
// node tests/e2e/quiz-keep.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
/** A lesson's quiz for one student (`who`, the server's code) with `tries` already recorded and the questions `shown`. */
const fixture = ({ shown = "aaaaaaaaaaa1,aaaaaaaaaaa2", who = "a".repeat(32), tries = 0 } = {}) => build({
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
        <QuizKeep handle="shop" product="prod" lesson="lessonaaaaa1" who=${JSON.stringify(who)} shown={shown} tries={${tries}} words={{ quizKeptBack: w.quizKeptBack, quizKeptClear: w.quizKeptClear, quizKeptCleared: w.quizKeptCleared }} />
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
const ada = await fixture();
const adaOtherQuestions = await fixture({ shown: "aaaaaaaaaaa1,aaaaaaaaaaa9" });
const adaAfterRecordedTry = await fixture({ tries: 1 });
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
const ADA = `mm:quiz:shop:prod:lessonaaaaa1:${"a".repeat(32)}`;
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
  const kept = () => tab.evaluate((k) => localStorage.getItem(k), ADA);
  const status = () => tab.getByRole("status").textContent();

  await open(ada);
  is("nothing kept and nothing said at first, though the status line is already there, empty", [await kept(), await status()], [null, ""]);
  await tab.getByLabel("B").check();
  await tab.getByLabel("D").check();
  is("each choice is kept in this browser as it is made, under this student's code", JSON.parse(await kept()).answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] });
  is("nothing was sent", sent.length, 0);

  await open(ada);
  is("coming back puts the choices back", await picked(), [false, true, false, true]);
  await tab.getByRole("status").filter({ hasText: "are back" }).waitFor();
  is("and says so in the status line that was there, empty, before", await status(), BACK);

  await tab.getByRole("button", { name: "Check my answers" }).click();
  await tab.getByText("monthly quiz submission allowance").waitFor();
  is("the server refused the try (429): the draft is still there", [sent.length, JSON.parse(await kept()).answers], [1, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] }]);
  await open(ada);
  is("and the lesson puts the answers back", await picked(), [false, true, false, true]);

  answer = "offline";
  await tab.getByRole("button", { name: "Check my answers" }).click().catch(() => {});
  await tab.waitForTimeout(300);
  await open(ada);
  is("the connection dropped on sending: still put back", await picked(), [false, true, false, true]);

  await open(bo);
  is("another student on the same browser gets nothing back, and sees no one's answers", [await picked(), await status(), await tab.getByRole("button", { name: "Clear my answers" }).count()], [[false, false, false, false], "", 0]);
  is("and the first student's draft is left alone", JSON.parse(await kept()).answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] });

  await open(adaAfterRecordedTry);
  is("once the server recorded a try, the draft is never put back, and is forgotten", [await picked(), await kept()], [[false, false, false, false], null]);

  await open(ada);
  await tab.getByLabel("A").check();
  await open(ada);
  await tab.getByRole("button", { name: "Clear my answers" }).click();
  is("Clear my answers empties the choices and forgets them", [await picked(), await kept()], [[false, false, false, false], null]);
  is("says so, and the focus goes to the quiz's first choice, not nowhere", [await status(), await tab.evaluate(() => document.activeElement?.getAttribute("name"))], ["Your answers are cleared.", "q_aaaaaaaaaaa1"]);

  await tab.getByLabel("A").check();
  await open(adaOtherQuestions);
  is("a try with other questions never gets them, and they are forgotten", [await picked(), await kept(), await status()], [[false, false, false, false], null, ""]);

  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
  });
  await open(ada);
  await tab.getByLabel("B").check();
  is("a browser that keeps nothing: the quiz still works, nothing is said", [await tab.getByLabel("B").isChecked(), await status()], [true, ""]);
  is("no script error", errors, []);
} finally {
  await browser.close();
}
console.log(`${engine}: ${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
