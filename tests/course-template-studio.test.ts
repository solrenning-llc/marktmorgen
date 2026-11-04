/**
 * Ready course structures in the studio (540 [CU1], unit 2; added
 * 1 November 2026). Checked, in the in-memory Redis:
 *
 *   - the words the picker shows: a draft said before anything is saved,
 *     each module's opening in the editor's own words, and the example
 *     titles left;
 *   - the route applies a structure by its id only, to the course it keeps,
 *     in one write: exactly what applyTemplate gives, with the product's
 *     lesson count and the module-opening emails set from it;
 *   - a course the creator touched, a second press, an unknown id and a
 *     course of another store are refused, and nothing changes;
 *   - "Start from scratch" saves nothing;
 *   - the course is taken off the store when a structure is applied, its
 *     publishing is refused while an example title is left, and its public
 *     page shows it to its owner only meanwhile (the review: a structure must
 *     never put "your title here" in front of a buyer or in an email);
 *   - the picker shows only on a new course, is a radio group with a
 *     legend, says the draft in a live region, saves only the id, and the
 *     editor says the example titles left and moves focus to that line.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { COURSE_TEMPLATES, applyTemplate, draftWords, exampleTitlesLeft, exampleTitlesWords, opensWords, quizLessonsWaiting, quizWaitingWords, templateById } from "@/lib/course-templates";
import { emptyCourse, lessonCount, readCourse } from "@/lib/course";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as courseRoute } from "@/app/api/store/course/route";
import { POST as productRoute } from "@/app/api/store/product/route";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CourseEditor } from "@/components/course-editor";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DRIP_SET = "nl:courses:drip";
import { paidPeriod } from "./billing-period-fixture";

const read = (file: string) => readFileSync(file, "utf8");

async function main(): Promise<void> {
  part("The words");
  is("a structure by its id; anything else is none", [templateById("weekly")?.name, templateById("nope"), templateById(7), templateById("__proto__")], ["Weekly course", null, null, null]);
  is("opening on the first day, in the editor's words", opensWords(0), "Opens as soon as a student joins.");
  is("opening later, with the email that day", [opensWords(1), opensWords(7)], ["Opens 1 day after each student joins, with an email to them that day.", "Opens 7 days after each student joins, with an email to them that day."]);
  is("the editor beside each module says the same", read("components/course-editor.tsx").includes("Opens as soon as a student joins.") && read("components/course-editor.tsx").includes("after each student joins, with an email to them that day."), true);
  is("the draft is counted, said to be unsaved, and said to stay hidden", draftWords(templateById("weekly")!), 'Draft: 4 modules and 12 lessons. Nothing is saved until you press "Use this structure". The course then stays hidden from your store until you replace every example title.');
  is("the certificate is said", draftWords(templateById("quizzes")!).includes("with a certificate when a student finishes"), true);
  is("one module is one module", draftWords(templateById("mini")!).startsWith("Draft: 1 module and 4 lessons."), true);
  is("from scratch adds nothing, and says so", draftWords(templateById("scratch")!), "Nothing is added. You build the course yourself, one module at a time.");
  is("no example title left: nothing said", exampleTitlesWords(0), "");
  is("some left: counted as examples (the quiz titles do not say \"your title here\"), and why it matters", [exampleTitlesWords(1).startsWith("1 title is still an example."), exampleTitlesWords(12).startsWith("12 titles are still examples."), exampleTitlesWords(3).includes("stays hidden from your store"), exampleTitlesWords(3).includes("in the email a student gets when it opens")], [true, true, true, true]);

  const quizzes = applyTemplate(emptyCourse(), templateById("quizzes")!);
  const waiting = quizzes.ok ? quizLessonsWaiting(quizzes.course) : [];
  is("the quiz structure's quiz lessons wait for their questions, one per module", waiting.length, 3);
  const firstQuiz = quizzes.ok ? quizzes.course.modules.flatMap((m) => m.lessons).find((l) => l.id === waiting[0]) : undefined;
  const asked = quizzes.ok ? { modules: quizzes.course.modules.map((m) => ({ ...m, lessons: m.lessons.map((l) => (l.id === waiting[0] ? { ...l, quiz: { questions: 3, pass: 70, tries: 0 } as never } : l)) })) } : { modules: [] };
  const tasked = quizzes.ok ? { modules: quizzes.course.modules.map((m) => ({ ...m, lessons: m.lessons.map((l) => (l.id === waiting[0] ? { ...l, task: { files: false } as never } : l)) })) } : { modules: [] };
  is("a quiz lesson given an assignment instead is not counted (it cannot take a quiz too)", quizLessonsWaiting(tasked).length, 2);
  is("a quiz written takes that lesson off", [firstQuiz?.title.includes("quiz"), quizLessonsWaiting(asked).length], [true, 2]);
  is("said with what to press, and that until then it is an ordinary lesson", quizWaitingWords(3), '3 quiz lessons have no questions yet. Open each one and press "Add a quiz": until then it is an ordinary lesson.');
  is("the button it names is the quiz editor's own", read("components/quiz-editor.tsx").includes('"Add a quiz"'), true);
  is("none waiting: nothing said", [quizWaitingWords(0), quizLessonsWaiting(emptyCourse()).length], ["", 0]);

  part("Saved by the route, all at once");
  const owner = "maker@example.com";
  await claimHandle(owner, "breadmaker", "Bread Maker", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1Tmplxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_tmpl", subscriptionId: "sub_tmpl", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const post = async (body: Record<string, unknown>, who = session) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${who}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; hidden?: boolean; course?: ReturnType<typeof emptyCourse> } };
  };
  const made = await addProduct(owner, "Sourdough at Home", "", "40");
  const id = made.ok ? made.product.id : "";
  is("a course is made", (await post({ action: "enable", id })).body.ok, true);
  const listing = async () => (await readListing((await storeForEmail(owner))!, id))!;
  const courseId = (await listing()).course!.id;

  let writes = 0;
  const pipeline = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof pipeline }).pipeline = (cmds) => {
    if (cmds.some((c) => String(c[0]).toUpperCase() === "SET" && String(c[1]).includes(courseId) && !String(c[1]).endsWith(":lock"))) writes += 1;
    return pipeline(cmds);
  };

  const scratch = await post({ action: "template", id, template: "scratch" });
  const untouched = await readCourse(courseId);
  is("from scratch: answered, nothing written", [scratch.body.ok, writes, untouched?.modules.map((m) => m.title)], [true, 0, ["Module 1"]]);

  const weekly = await post({ action: "template", id, template: "weekly" });
  const kept = await readCourse(courseId);
  const expected = applyTemplate(untouched!, templateById("weekly")!);
  const shape = (c: ReturnType<typeof emptyCourse> | null | undefined) => c?.modules.map((m) => [m.title, m.dripDays, m.lessons.map((l) => l.title)]);
  is("applied: exactly what the structure gives, in one write", [weekly.status, weekly.body.ok, shape(kept), writes], [200, true, expected.ok ? shape(expected.course) : null, 1]);
  is("the course sent back is the one kept", shape(weekly.body.course), shape(kept));
  is("the product counts its lessons", (await listing()).course?.lessons, lessonCount(kept!));
  is("every title is still an example, and said", exampleTitlesLeft(kept!), 16);
  is("the product is taken off the store, so no buyer sees an example title", [(await listing()).hidden, weekly.body.hidden], [true, true]);
  const [drips] = await redis.pipeline([["SMEMBERS", DRIP_SET]]);
  is("the module-opening emails know the course now that modules open later (registerDrip)", (drips as string[]).includes(`${courseId}|breadmaker|${id}`), true);

  part("Published only once every example title is replaced");
  const publish = async (productId: string) => {
    const response = await productRoute(new NextRequest("https://marktmorgen.com/api/store/product", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify({ action: "visibility", id: productId, hidden: false }) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  const early = await publish(id);
  is("publishing with example titles left: refused, still hidden", [early.status, early.body.error, (await listing()).hidden], [409, "course_examples", true]);
  is("said where it is published, in the product editor's words", read("components/product-editor.tsx").includes("course_examples:") && read("components/product-editor.tsx").includes("Open the course, replace each with your own, then publish it."), true);
  for (const [m, unit] of kept!.modules.entries()) {
    await post({ action: "edit", id, op: "module-edit", moduleId: unit.id, title: `Week ${m + 1}: bread`, dripDays: String(unit.dripDays) });
    for (const [n, lesson] of unit.lessons.entries()) await post({ action: "edit", id, op: "lesson-edit", lessonId: lesson.id, title: `Step ${m + 1}.${n + 1}`, preview: false });
  }
  const renamed16 = await readCourse(courseId);
  is("the titles replaced, the opening days kept", [exampleTitlesLeft(renamed16!), renamed16!.modules.map((m) => m.dripDays)], [0, [0, 7, 14, 21]]);
  const late = await publish(id);
  is("then it publishes", [late.status, late.body.ok, (await listing()).hidden], [200, true, false]);
  is("the public page shows a hidden course with example titles to its owner only", read("app/[handle]/course/[product]/page.tsx").includes("if (product.hidden && exampleTitlesLeft(course) > 0 && !(open && access.learner.owner)) redirect("), true);
  is("the studio says it is hidden, not that Stripe is missing", read("app/studio/course/[product]/page.tsx").includes('"Hidden from your store. Publish it from your products in the studio when it is ready."'), true);

  part("Refused, nothing changed");
  const again = await post({ action: "template", id, template: "mini" });
  is("a second press, now that the course has modules: refused", [again.status, again.body.error, shape(await readCourse(courseId))], [409, "not_new", shape(renamed16)]);
  const other = await addProduct(owner, "Rye at Home", "", "40");
  const otherId = other.ok ? other.product.id : "";
  await post({ action: "enable", id: otherId });
  const otherCourse = (await readListing((await storeForEmail(owner))!, otherId))!.course!.id;
  await post({ action: "edit", id: otherId, op: "module-edit", moduleId: (await readCourse(otherCourse))!.modules[0].id, title: "Getting started", dripDays: "0" });
  const renamed = await post({ action: "template", id: otherId, template: "challenge" });
  is("a course whose module the creator renamed: refused", [renamed.status, renamed.body.error, (await readCourse(otherCourse))!.modules.map((m) => m.title)], [409, "not_new", ["Getting started"]]);
  const unknown = await post({ action: "template", id: otherId, template: "constructor" });
  is("an id that is no structure: refused as invalid", [unknown.status, unknown.body.error], [400, "invalid"]);
  const notCourse = await addProduct(owner, "A Loaf Tin", "", "20");
  const plain = await post({ action: "template", id: notCourse.ok ? notCourse.product.id : "", template: "weekly" });
  is("a product that is not a course: refused", [plain.status, plain.body.error], [400, "not_course"]);
  const stranger = "someone@example.com";
  await claimHandle(stranger, "someoneelse", "Someone", "");
  const before = shape(await readCourse(otherCourse));
  const theirs = await post({ action: "template", id: otherId, template: "weekly" }, await openSession(stranger));
  is("another store's course cannot be reached, and stays as it was", [theirs.body.ok === true, shape(await readCourse(otherCourse))], [false, before]);
  is("signed out: refused", (await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "template", id, template: "weekly" }) }))).status, 401);

  part("The picker and the editor");
  const picker = read("components/course-template-picker.tsx");
  const editor = read("components/course-editor.tsx");
  is("offered only on a new course", editor.includes("templateFits(course).ok") && editor.includes("<CourseTemplatePicker"), true);
  is("a radio group with a legend, one per structure", [picker.includes("<fieldset"), picker.includes("<legend"), picker.includes('type="radio"'), picker.includes("COURSE_TEMPLATES.map")], [true, true, true, true]);
  is("the draft said in a live region before anything is saved", picker.includes('role="status"') && picker.includes("draftWords("), true);
  is("the draft shows each module's opening in the editor's words", picker.includes("opensWords("), true);
  is("only the id is sent; the server applies it", picker.includes('action: "template"') && picker.includes("template: chosen.id") && !picker.includes("modules: draft"), true);
  is("no model is asked, nothing is fetched but the save", [/\/api\/store\/ai/.test(picker), (picker.match(/fetch\(|save\(/g) ?? []).length], [false, 1]);
  is("the editor says the example titles left and takes the focus there after applying", editor.includes("exampleTitlesWords(") && editor.includes('id="course-example-titles"') && editor.includes("tabIndex={-1}"), true);
  is("keeping an empty course moves the focus to the first module's name, not to the page's top", editor.includes('module-${first?.id}-heading"] input`)?.focus()'), true);
  is("after the quiz structure, its first quiz lesson opens", editor.includes("const quiz = quizLessonsWaiting(kept)[0];") && editor.includes("if (quiz) setOpenLesson(quiz);"), true);
  is("not_new is said in the structures' own words", editor.includes('not_new: FIT_WORDS["not-new"]'), true);
  is("no funnel is offered that a sold course cannot fill", picker.includes("/studio/funnels"), false);
  is("a stale page, its course changed further down, refuses and puts the structures away", editor.includes("templateFits(course).ok && templateFits(initial).ok") && editor.includes('if (answer.error === "not_new") {'), true);
  is("\"Start from scratch\" has its own button", picker.includes('{scratch ? "Start from scratch" : "Keep an empty course"}'), true);
  is("the draft is made once per pick (its ids stay put while the page draws again)", picker.includes("useMemo(() => {"), true);
  is("no structure in a course already made changes anything (the route refuses before it writes)", read("app/api/store/course/route.ts").includes('if (!applied.ok) return Response.json({ ok: false, error: "not_new" }, { status: 409 })'), true);

  part("Drawn as the creator sees it");
  const draw = (initial: ReturnType<typeof emptyCourse>) =>
    renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, createElement(CourseEditor, { productId: "p1", initial, folder: "f" })));
  const fresh = draw(emptyCourse());
  is("a new course: the structures as one group with a legend, a radio for each", [fresh.includes("<fieldset"), fresh.includes("Pick a structure</legend>"), (fresh.match(/type="radio"/g) ?? []).length], [true, true, COURSE_TEMPLATES.length]);
  is("the live region is there before anything is picked, and silent", /<p role="status"[^>]*><\/p>/.test(fresh), true);
  is("nothing saved yet: no example line, no save button", [fresh.includes("course-example-titles"), fresh.includes("Use this structure")], [false, false]);
  const filled = draw(kept!);
  is("a course a structure was given: no structures, the example line there to take the focus", [filled.includes("Pick a structure"), filled.includes('id="course-example-titles"'), filled.includes('tabindex="-1"'), filled.includes("16 titles are still examples.")], [false, true, true, true]);
  done();
}

void main();
