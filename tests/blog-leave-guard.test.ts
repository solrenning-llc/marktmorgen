/**
 * A blog post written and not saved is never lost to a click away
 * (487 [IT4], item 6; added 1 November 2026; docs/ease-patterns-audit.md).
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const editor = readFileSync("components/blog-editor.tsx", "utf8");
is("the blog editor uses the leave guard", editor.includes('import { useLeaveGuard } from "@/components/leave-guard";') && editor.includes("useLeaveGuard(dirty && !done);"), true);
is("unsaved means the title, the text or the product differ from the saved post", editor.includes("const dirty = title !== base.title || body !== base.body || product !== base.product;"), true);
is("a delete lets the page go without asking", (editor.match(/setDone\(true\);/g) ?? []).length, 1);
is("a confirmed save is what is compared against until the saved post comes back, so typing after it stays guarded", editor.includes('const base = sent ?? { title: post.title, body: post.body, product: post.product ?? "" };') && editor.includes("setSent({ title, body, product });"), true);
is("and once the saved post comes back, its changes are guarded again", /if \(seen !== post\) \{\s*setSeen\(post\);[\s\S]{0,700}?setDone\(false\);\s*\}/.test(editor), true);
const faq = readFileSync("components/faq-editor.tsx", "utf8");
is("after a save, the editor takes the post as the server kept it, except a field typed in since", /if \(sent\) \{\s*if \(title === sent\.title\) setTitle\(post\.title\);\s*if \(body === sent\.body\) setBody\(post\.body\);\s*if \(product === sent\.product\) setProduct\(post\.product \?\? ""\);\s*setSent\(null\);/.test(editor), true);
is("the FAQ editor asks too, with its own measure of unsaved answers", faq.includes("useLeaveGuard(changed && !saving);") && faq.includes("const changed = JSON.stringify(rows.map"), true);
is("and takes its rows as they were saved, compared against what was saved until the page brings the new list", faq.includes("setRows(expected.map((item, key) => ({ ...item, key })));") && faq.includes("setBase(expected);") && faq.includes("!== JSON.stringify(base);"), true);
const quiz = readFileSync("components/quiz-editor.tsx", "utf8");
is("the quiz editor asks only while a quiz is open and differs from what was opened, never while saving", quiz.includes("useLeaveGuard(draft !== null && JSON.stringify(draft) !== opened && !busy);"), true);
is("both ways of opening a quiz keep what was opened", (quiz.match(/setOpened\(JSON\.stringify\((fresh|read)\)\);/g) ?? []).length, 2);
const product = readFileSync("components/product-editor.tsx", "utf8");
is("the product form asks only while it is open and differs from what was opened, never while saving", product.includes("useLeaveGuard((adding || editingId !== null) && JSON.stringify(draft) !== JSON.stringify(opened) && !busy);"), true);
is("adding, editing and a long description read late all move what was opened with the form", [product.includes("setDraft(EMPTY);\n    setOpened(EMPTY);"), product.includes("setDraft(form);\n    setOpened(form);"), product.includes("setOpened((current) => ({ ...current, about: read }));")], [true, true, true]);
const course = readFileSync("components/course-editor.tsx", "utf8");
is("a module asks with its own measure of unsaved, and takes back what the server kept", course.includes("useLeaveGuard(changed);") && course.includes("answer.course?.modules.find((m) => m.id === unit.id)"), true);
is("a lesson asks for its name, link, preview or text, and while a file is still going up", course.includes('const unsaved = title !== lesson.title || preview !== lesson.preview || link !== (lesson.link ?? "") || text !== savedText;') && course.includes("useLeaveGuard(unsaved || uploading !== null);"), true);
is("the lesson's text counts as saved once read and once saved", (course.match(/setSavedText\(/g) ?? []).length, 3);
is("a field changed while a module or lesson was saving keeps what was typed", (course.match(/\(now\) => \(now === \w+ \?/g) ?? []).length, 5);
const task = readFileSync("components/task-editor.tsx", "utf8");
is("an assignment asks like a quiz, from what was opened", task.includes("useLeaveGuard(draft !== null && JSON.stringify(draft) !== opened && !busy);") && (task.match(/setOpened\(JSON\.stringify\((fresh|read)\)\);/g) ?? []).length === 2, true);
const designer = readFileSync("components/mail-designer.tsx", "utf8");
const studio = readFileSync("components/email-studio.tsx", "utf8");
is("the email designer keeps nothing of its own: every change goes to the email it is in", designer.includes("onChange(text);") && !designer.includes("useLeaveGuard"), true);
is("and both emails it is used in already ask before leaving", studio.includes("useLeaveGuard(dirty || aiBusy);") && studio.includes("useLeaveGuard(aiBusy || (draft !== null && JSON.stringify(draft) !== draftBaseline));") && (studio.match(/<MailBodyEditor/g) ?? []).length, 2);
done();
