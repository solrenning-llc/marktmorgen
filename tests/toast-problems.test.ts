// AX274 (WCAG 2.2.3 No Timing, 3.3.1 Error Identification, 1.3.1 Info and
// Relationships, 4.1.3 Status Messages): the studio's toast is a confirmation
// box, a check mark that leaves by itself after 5 seconds. Found by the studio
// audit of 13 November 2026: a failed save on the studio's numbers note, a
// person's page, an inbox reply and a dozen other editors said "That did not
// save..." through that same box, so the error was drawn with a success check
// and vanished on its own, with nothing left next to the control.
//
// What must hold: a message that says something went wrong goes through
// toastProblem(), which shows an alert mark instead of the check, is read out
// by a role="alert" region, and stays until the person closes it or a newer
// message replaces it. The confirmation toast keeps its check, its polite
// status region and its 5 seconds. The scan reads the real components.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as toastModule from "@/components/toast";

let passed = 0;
function is<T>(name: string, actual: T, expected: T) {
  assert.deepEqual(actual, expected, name);
  passed += 1;
}

type Kind = "done" | "problem";
const api = toastModule as unknown as {
  toastProblem?: (message: string) => void;
  toastShownFor?: (kind: Kind) => number | null;
  toastBoxClass?: (kind: Kind) => string;
  ToastMessage?: (props: { message: string; kind: Kind; onDismiss: () => void }) => unknown;
};

// 1. The API exists.
is("toastProblem is exported", typeof api.toastProblem, "function");
is("toastShownFor is exported", typeof api.toastShownFor, "function");
is("ToastMessage is exported", typeof api.ToastMessage, "function");
is("toastBoxClass is exported", typeof api.toastBoxClass, "function");

// 2. Timing: no toast leaves by itself since 2.2.3 (tests/toast-stays.test.ts), a confirmation or a problem.
is("a confirmation has no time limit either (2.2.3)", api.toastShownFor!("done"), null);
is("a problem has no time limit (2.2.3)", api.toastShownFor!("problem"), null);

// 3. Look: the check is only for confirmations; a problem says it is a problem.
const draw = (kind: Kind) =>
  renderToStaticMarkup(createElement(api.ToastMessage as never, { message: "That did not save. Try again.", kind, onDismiss: () => {} }));
const done = draw("done");
const problem = draw("problem");
is("a problem is not drawn with the success check", /data-icon="check"/.test(problem), false);
is("a problem is drawn with the alert mark", /data-icon="alert"/.test(problem), true);
is("a confirmation keeps its check", /data-icon="check"/.test(done), true);
is("a problem's box is marked as a problem for its style", api.toastBoxClass!("problem"), "nb-toast nb-toast-problem");
is("a confirmation's box keeps the plain class", api.toastBoxClass!("done"), "nb-toast");
is("the Toaster draws its box with toastBoxClass", /className=\{toastBoxClass\(current\.kind\)\}/.test(readFileSync("components/toast.tsx", "utf8")), true);
is("a problem names itself in words, not only by its mark (1.3.1, 1.4.1)", /Problem:/.test(problem.replace(/<[^>]+>/g, "")), true);
is("a confirmation is not called a problem", /Problem:/.test(done.replace(/<[^>]+>/g, "")), false);
for (const [name, html] of [["confirmation", done], ["problem", problem]] as const) {
  is(`the ${name} keeps a 44 px Dismiss button`, /<button[^>]*class="nb-toast-close"[^>]*aria-label="Dismiss"/.test(html), true);
}

// 4. Announcement: the Toaster always keeps a polite status region and an alert region.
const toaster = renderToStaticMarkup(createElement(toastModule.Toaster));
is("the polite status region is always in the page", /role="status" aria-live="polite"/.test(toaster), true);
is("the alert region for problems is always in the page", /role="alert"/.test(toaster), true);

// 5. The style: a problem's box has its own colors, with AAA text contrast.
const css = readFileSync("app/globals.css", "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};
is("the problem box has its own rule", rule(".nb-toast-problem").length > 0, true);
is("the problem box uses the error text color as its background (white on it is >= 7:1)", /background:\s*var\(--danger-text\)/.test(rule(".nb-toast-problem")), true);

// 6. The scan: no message that reports a failure goes through the confirmation toast.
const FAILURE = /did not (save|work|go)|could not|couldn['’]t|can['’]t be read|cannot|not be confirmed|Try again|try again/;
const offenders: string[] = [];
const files = readdirSync("components").filter((f) => f.endsWith(".tsx")).map((f) => `components/${f}`);
for (const file of files) {
  if (file === "components/toast.tsx") continue;
  const source = readFileSync(file, "utf8");
  const call = /(^|[^A-Za-z0-9_.$])toast\(/g;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    const args = source.slice(start, i - 1);
    if (FAILURE.test(args)) offenders.push(`${file}:${source.slice(0, m.index).split("\n").length}: toast(${args.slice(0, 90)})`);
  }
}
is(`no failure message goes through the confirmation toast:\n${offenders.join("\n")}`, offenders.length, 0);

console.log(`Toast problems: ${passed} checks passed`);
