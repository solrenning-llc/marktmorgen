import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { FaqEditor } from "@/components/faq-editor";
import { done, is, part } from "./check";

const router = { bfcacheId: "faq-focus-fixture", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch: async () => {} };
const html = renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
  createElement(FaqEditor, { faq: [{ q: "First question?", a: "First answer." }, { q: "Second question?", a: "Second answer." }], ai: { on: false, left: 0 } }),
));
const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]);
const named = (words: string) => buttons.filter(attributes => attributes.includes(`aria-label="${words}"`));

part("Every repeated FAQ action names its question and remains a full target");
for (const index of [1, 2]) {
  for (const action of ["Move up", "Move down", "Remove"]) {
    const found = named(`${action} question ${index}`);
    is(`${action} identifies question ${index}`, found.length, 1);
    is(`${action} question ${index} has a 44px minimum target`, !!found[0] && /\bmin-h-11\b/.test(found[0]) && /\bmin-w-11\b/.test(found[0]), true);
  }
}
is("the first question cannot move above the list", named("Move up question 1")[0]?.includes('disabled=""'), true);
is("the last question cannot move below the list", named("Move down question 2")[0]?.includes('disabled=""'), true);
is("the original question and answer words are preserved", ["First question?", "First answer.", "Second question?", "Second answer."].every(text => html.includes(text)), true);
done();
