/**
 * Claude 6's LEVE on #4324 @356f211d6c (personal data): the privacy policy and the data register promise that signing
 * out removes every quiz draft from the browser, but a course student let in by the store's pass, with no Marktmorgen
 * account, signs out from the community's "You" page, whose answer moves them to the store's page, never to the page
 * that removes the drafts (/signin?status=out). Checked here:
 *
 *   - sending the pass sign-out form removes every draft, on the device and in the tab, before the browser leaves
 *     (components/quiz-sweep.tsx forgetDraftsOnSubmit, the real code, on a stand-in form and storages);
 *   - nothing is removed before the form is sent, and a storage that throws does not stop the other;
 *   - the "You" page draws it inside that form, and only that one;
 *   - the promise in the privacy policy and the register stays, now true for both ways of signing out.
 *
 * A draft is only ever written by a script (components/quiz-keep.tsx), so a browser without one has none to remove.
 */
import { readFileSync } from "node:fs";
import * as sweep from "@/components/quiz-sweep";
import { quizKeepKey } from "@/lib/quiz-keep-rules";
import { PERSON_DATA } from "@/lib/person-data";
import { done, is, part } from "./check";

function storage(keys: string[]): Storage & { kept: Map<string, string> } {
  const kept = new Map(keys.map((key) => [key, "{}"]));
  return {
    kept,
    get length() { return kept.size; },
    key: (i: number) => [...kept.keys()][i] ?? null,
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
    clear: () => kept.clear(),
  } as Storage & { kept: Map<string, string> };
}

async function main(): Promise<void> {
  part("Sending the pass sign-out form removes every draft first");
  const forgetOnSubmit = (sweep as { forgetDraftsOnSubmit?: (form: EventTarget, areas: () => Storage[]) => () => void }).forgetDraftsOnSubmit;
  is("there is a way to tie it to the form", typeof forgetOnSubmit, "function");
  if (typeof forgetOnSubmit === "function") {
    const draft = quizKeepKey("a".repeat(32));
    const device = storage([draft, "mm:place:other"]);
    const tab = storage([quizKeepKey("b".repeat(32))]);
    const form = new EventTarget();
    const stop = forgetOnSubmit(form, () => [device, tab]);
    is("nothing goes before the form is sent", [device.kept.size, tab.kept.size], [2, 1]);
    form.dispatchEvent(new Event("submit"));
    is("sent: the drafts on the device and in the tab are gone, nothing else", [[...device.kept.keys()], tab.kept.size], [["mm:place:other"], 0]);
    stop();
    const later = storage([draft]);
    forgetOnSubmit(form, () => [{ ...later, key: () => { throw new Error("storage blocked (synthetic)"); }, get length() { return 1; } } as Storage, later]);
    form.dispatchEvent(new Event("submit"));
    is("a storage that throws does not keep the other's drafts", later.kept.size, 0);
  }

  part("The \"You\" page draws it inside the sign-out form, and only there");
  const you = readFileSync("app/[handle]/community/you/page.tsx", "utf8");
  is("inside the form that sends action=signout", /<form action="\/api\/store\/community" method="post" className="mt-4">\s*<ForgetQuizDraftsOnSubmit \/>\s*<Carry store=\{store\} action="signout" from="you" \/>/.test(you), true);
  is("once", you.split("<ForgetQuizDraftsOnSubmit />").length - 1, 1);

  part("The promise stays, and is now true for both ways of signing out");
  const privacy = readFileSync("app/privacy/page.tsx", "utf8");
  is("the privacy policy still says signing out removes them all", /id="quiz-drafts"[\s\S]{0,2400}signing out removes them all/.test(privacy), true);
  is("and the register", PERSON_DATA.some((r) => r.file === "lib/quiz-keep-rules.ts" && /sign out/.test(r.what)), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
