/**
 * 260 [KJ5], unit 4: the studio's box for importing a course outline
 * (components/course-import-box.tsx). Plain US English for every place and
 * problem (lib/course-import-words.ts); a file input with its own label; the
 * format shown as an example; nothing saved until the confirm button, which
 * is drawn only after a preview; mounted by the course editor only on a new
 * course, beside the ready structures.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CourseImportBox } from "@/components/course-import-box";
import { COURSE_IMPORT_FORMAT, previewCourseImport } from "@/lib/course-import";
import { IMPORT_MAX_BYTES } from "@/lib/course-import-apply";
import { IMPORT_EXAMPLE, importProblem, placeWords } from "@/lib/course-import-words";
import { done, is, part } from "./check";

part("Places said in words, not field names");
is("a module's title", placeWords("modules[0].title"), "Module 1, its title");
is("a lesson's text", placeWords("modules[1].lessons[2].text"), "Module 2, lesson 3, its text");
is("a lesson", placeWords("modules[0].lessons[0]"), "Module 1, lesson 1");
is("a lesson's file", placeWords("modules[0].lessons[0].files[1]"), "Module 1, lesson 1, download 2");
is("the whole file", placeWords("file"), "The file");
is("anything else is said as the file", placeWords("constructor"), "The file");

part("Every problem says what to do");
is("the outline's own reason, with its place", importProblem({ error: "invalid", path: "modules[0].title", reason: "Give each module a title." }), "Module 1, its title: Give each module a title.");
is("a course with changes", importProblem({ error: "not_new" }), "This course already has your changes, so an outline can't be brought into it. Make a new course for it instead.");
is("a full store, in the store's own words", importProblem({ error: "store_full", message: "Your store's data room is full." }), "Your store's data room is full. Nothing was imported.");
is("busy", importProblem({ error: "busy" }), "This course is being saved somewhere else. Try again in a moment. Nothing was imported.");
is("too large", importProblem({ error: "too_large" }), `This file is larger than ${IMPORT_MAX_BYTES / 1_000_000} MB. Make it smaller, or split it across separate courses.`);
is("anything else", importProblem({ error: "server_error" }), "Something went wrong, and nothing was imported. Try again.");
// After Import, a lost answer may follow a save: never "nothing was imported" then (Revisor 1 on e-kj5-u4, MEDIUM).
const unsure = "We could not confirm the import. Reload the page to see the course as it is now.";
is("after Import, a server error is not called nothing", importProblem({ error: "server_error" }, true), unsure);
is("after Import, an unknown answer the same", importProblem({}, true), unsure);
is("after Import, a refusal before any write still says so", importProblem({ error: "store_full", message: "Your store's data room is full." }, true), "Your store's data room is full. Nothing was imported.");
is("a refusal with the studio's own message", importProblem({ error: "used", message: "You have used this month's studio requests." }), "You have used this month's studio requests.");

part("The example is a real outline the preview accepts");
const example = previewCourseImport(IMPORT_EXAMPLE);
is("accepted", example.ok, true);
is("its format", JSON.parse(IMPORT_EXAMPLE).format, COURSE_IMPORT_FORMAT);

part("Drawn on a new course");
const html = renderToStaticMarkup(createElement(CourseImportBox, { productId: "p1", show: true, busy: false, onImported: () => {}, onUnsure: () => {} }));
is("a named section", /<section[^>]*aria-labelledby="course-import-title"/.test(html) && html.includes('id="course-import-title"'), true);
is("its heading", html.includes("Bring in a course you already wrote"), true);
is("the file input has its own label", /<label[^>]*for="course-import-file"/.test(html) && /<input[^>]*id="course-import-file"[^>]*type="file"|<input[^>]*type="file"[^>]*id="course-import-file"/.test(html), true);
is("JSON files offered", /accept="[^"]*\.json/.test(html), true);
is("the format shown as an example", html.includes("<details") && html.includes(COURSE_IMPORT_FORMAT), true);
is("nothing to confirm before a preview", html.includes("Import "), false);
is("a place where results are announced", /role="status"|aria-live="polite"/.test(html), true);
is("not drawn when the course has changes", renderToStaticMarkup(createElement(CourseImportBox, { productId: "p1", show: false, busy: false, onImported: () => {}, onUnsure: () => {} })), "");

part("Mounted by the course editor beside the ready structures");
const editor = readFileSync("components/course-editor.tsx", "utf8");
is("imported", editor.includes('import { CourseImportBox } from "@/components/course-import-box";'), true);
is("shown only on a new course", /<CourseImportBox[\s\S]{0,200}show=\{templateFits\(course\)\.ok && templateFits\(initial\)\.ok\}/.test(editor), true);
const box = readFileSync("components/course-import-box.tsx", "utf8");
is("it saves only through the import route with confirm", box.includes('"/api/store/course/import"') && box.includes("confirm: true"), true);
is("a file over the limit is refused before it is sent", box.includes("IMPORT_MAX_BYTES"), true);
// The body sent is the file escaped in JSON, so the limit is held on that (Revisor 1 on e-kj5-u4, LEVE 1).
is("the limit is held on the body sent", box.includes("new TextEncoder().encode(body).byteLength > IMPORT_MAX_BYTES"), true);
is("after Import, an unsure answer reloads the course", box.includes("importProblem(answer, true)") && box.includes("onUnsure()"), true);
is("the editor reloads on an unsure answer", /<CourseImportBox[\s\S]{0,600}onUnsure=\{\(\) => router\.refresh\(\)\}/.test(editor), true);
// LEVE 2 (AX): a disabled control drops the focus to the page; aria-disabled keeps it.
is("the file input is never disabled", /<input[\s\S]{0,400}type="file"[\s\S]{0,400}(?<![-\w])disabled=/.test(box), false);
is("it says it is busy instead", /type="file"[\s\S]{0,400}aria-disabled=\{blocked \|\| undefined\}/.test(box), true);
done();
