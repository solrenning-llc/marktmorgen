/**
 * Ready example forms on the empty Forms screen (487 [IT4], item 5; added 2
 * November 2026): each a form the server itself accepts, questions only, no
 * claim or promise of ours; offered only while there is no form; opened in
 * the editor unsaved, with the focus on its name.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { FormsEditor } from "@/components/forms-editor";
import { FORM_STARTERS } from "@/lib/form-starters";
import { MAX_FIELDS, newFormId, parseForm, tierIssues } from "@/lib/forms";
import { sensitiveFieldOf } from "@/lib/form-sensitive";
import { done, is, part } from "./check";

part("The examples");
let n = 0;
const piece = () => String(n++).padStart(6, "a").slice(-6).replace(/[^a-z0-9]/g, "a");
const made = FORM_STARTERS.map((s) => s.make(() => newFormId(6)));
is("two, each named once", [FORM_STARTERS.length, new Set(FORM_STARTERS.map((s) => s.id)).size], [2, 2]);
is("each kept whole by the server's own reader, once named and given an id", made.map((f) => JSON.stringify(parseForm({ ...f, id: newFormId(10) })?.fields) === JSON.stringify(f.fields)), [true, true]);
is("none asks for anything sensitive or beyond a plan, so the save route takes each", made.map((f) => [sensitiveFieldOf(f), tierIssues({ ...f, id: newFormId(10) }).length]), Array(2).fill([null, 0]));
is("within the limits, with an email field, and fresh ids each time", [made.every((f) => f.fields.length <= MAX_FIELDS && f.fields.some((x) => x.type === "email")), (() => { const a = FORM_STARTERS[0].make(piece), b = FORM_STARTERS[0].make(piece); return a.fields[0].id !== b.fields[0].id; })()], [true, true]);
const words = made.flatMap((f) => [...f.fields.map((x) => x.label), ...f.fields.flatMap((x) => x.options.map((o) => o.label))]).join(" ");
is("questions only: no figure, no quotation, no promise made for the creator, no one person assumed", [/\d/.test(words.replace(/1 to 10/g, "")), /“|"/.test(words), /\b(will|guarantee|promise|within|reply|replies)\b/i.test(words), /\b(me|my)\b/i.test(words)], [false, false, false, false]);
is("what a person reads after sending is left to the store's own words, in its language, as on a blank form", made.map((f) => [f.doneHeading, f.doneBody]), Array(2).fill(["", ""]));

part("On the empty screen");
const render = (saved: unknown[]) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { push() {}, refresh() {}, prefetch() {} } as never }, createElement(FormsEditor, { saved: saved as never, products: [], exportBase: "/api/store/forms" })));
const empty = render([]);
is("under its own heading, which names the list", [empty.includes('<h3 id="form-starters-title"'), empty.includes('aria-labelledby="form-starters-title"')], [true, true]);
is("offered with a heading, each with its words tied to its button", [empty.includes("Or start from an example"), FORM_STARTERS.every((s) => empty.includes(`aria-describedby="form-starter-${s.id}"`) && empty.includes(`>Use “${s.name}”</button>`) && empty.includes(`id="form-starter-${s.id}">${s.hint}</span>`))], [true, true]);
is("and that nothing is saved or shown until the creator does it", empty.includes("Nothing is saved or shown on your pages until you save it and add it to a page."), true);
const one = parseForm({ ...made[0], id: newFormId(10) })!;
is("not once there is a form", render([{ form: one, total: 0, latest: [] }]).includes("data-form-starters"), false);
const source = readFileSync("components/forms-editor.tsx", "utf8");
is("opened unsaved in the editor, the focus on its name, as a blank new form is", [source.includes("onClick={() => openNew(starter.make(piece))}"), source.includes("onClick={() => openNew(blank())}"), source.includes("requestAnimationFrame(() => nameField.current?.focus());"), source.includes("<input ref={nameField} ")], [true, true, true, true]);

done();
