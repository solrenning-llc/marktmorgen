// A quiz's answers kept in the student's browser (297 [SQ8]) in a real browser: the real QuizKeep inside a form
// shaped like components/lesson-quiz.tsx's; every request is intercepted, nothing leaves the machine.
// node tests/e2e/quiz-keep.mjs  (E2E_BROWSER=chromium|firefox|webkit; CHROMIUM=<path> for a local browser)
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve("."), require = createRequire(root + "/package.json");
const fixture = (shown) => build({
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
        <QuizKeep handle="shop" product="prod" lesson="lessonaaaaa1" shown={shown} words={{ quizKeptBack: w.quizKeptBack, quizKeptClear: w.quizKeptClear, quizKeptCleared: w.quizKeptCleared }} />
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
const sameTry = await fixture("aaaaaaaaaaa1,aaaaaaaaaaa2");
const otherTry = await fixture("aaaaaaaaaaa1,aaaaaaaaaaa9");

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
const KEY = "mm:quiz:shop:prod:lessonaaaaa1";
try {
  const context = await browser.newContext();
  const tab = await context.newPage(), errors = [], sent = [];
  tab.setDefaultTimeout(5000);
  tab.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) => route.abort());
  await context.route("https://quiz.test/", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Quiz keep check</title><body><main id="root"></main></body></html>' }));
  await context.route("https://quiz.test/sent", (route) => { sent.push(route.request().postData()); return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Marked</title><p>Marked</p>" }); });
  const open = async (script) => {
    await tab.goto("https://quiz.test/");
    await tab.addScriptTag({ content: script });
    await tab.getByRole("button", { name: "Check my answers" }).waitFor();
  };
  const picked = () => tab.evaluate(() => [...document.querySelectorAll('input[name^="q_"]')].map((i) => i.checked));
  const kept = () => tab.evaluate((k) => localStorage.getItem(k), KEY);

  await open(sameTry);
  is("nothing kept, nothing said, at first", [await kept(), await tab.getByRole("status").count()], [null, 0]);
  await tab.getByLabel("B").check();
  await tab.getByLabel("D").check();
  is("each choice is kept in this browser as it is made", JSON.parse(await kept()).answers, { q_aaaaaaaaaaa1: [1], q_aaaaaaaaaaa2: [1] });
  is("nothing was sent", sent.length, 0);

  await open(sameTry);
  is("coming back puts the choices back", await picked(), [false, true, false, true]);
  is("and says so, and that nothing is checked yet", await tab.getByRole("status").textContent(), "Your answers from last time are back. They are not checked until you press the button below.");

  await tab.getByRole("button", { name: "Clear my answers" }).click();
  is("Clear my answers empties the choices and forgets them", [await picked(), await kept()], [[false, false, false, false], null]);
  is("and says so", await tab.getByRole("status").textContent(), "Your answers are cleared.");

  await tab.getByLabel("A").check();
  await open(otherTry);
  is("a try with other questions never gets them, and they are forgotten", [await picked(), await kept(), await tab.getByRole("status").count()], [[false, false, false, false], null, 0]);

  await tab.getByLabel("A").check();
  await tab.getByRole("button", { name: "Check my answers" }).click();
  await tab.getByText("Marked").waitFor();
  is("pressing the quiz's button sends the answers as before", sent.length === 1 && sent[0].includes("q_aaaaaaaaaaa1=0"), true);
  is("and forgets what was kept", await kept(), null);

  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("denied"); } });
  });
  await open(sameTry);
  await tab.getByLabel("B").check();
  is("a browser that keeps nothing: the quiz still works, nothing is said", [await tab.getByLabel("B").isChecked(), await tab.getByRole("status").count()], [true, 0]);
  is("no script error", errors, []);
} finally {
  await browser.close();
}
console.log(`${engine}: ${checks} checks, ${failures} failing.`);
if (failures) process.exit(1);
