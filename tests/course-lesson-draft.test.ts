/**
 * Each lesson of a draft course says so (754 [STN1], unit 3).
 *
 * While the course's product is hidden from the store, every lesson row in
 * the studio's course editor reads "Hidden — course is draft", so the creator
 * never takes a lesson (or its free preview) for one buyers can see. A
 * published course draws no such line. The studio's course page passes the
 * product's own hidden flag; nothing new is read or written for it.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { CourseEditor } from "@/components/course-editor";
import { applyTemplate, templateById } from "@/lib/course-templates";
import { emptyCourse, lessonCount } from "@/lib/course";
import { done, is, part } from "./check";

const made = applyTemplate(emptyCourse(), templateById("weekly")!);
if (!made.ok) throw new Error("no course");
const course = made.course;
const lessons = lessonCount(course);
const LINE = "Hidden — course is draft";

const draw = (draft?: boolean) =>
  renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: { refresh() {}, push() {} } as never }, createElement(CourseEditor, { productId: "p1", initial: course, folder: "f", ...(draft === undefined ? {} : { draft }) })),
  );
const count = (html: string) => html.split(LINE).length - 1;

part("A draft course: every lesson says it is hidden");
is("the course has lessons to show", lessons > 1, true);
is("one line per lesson", count(draw(true)), lessons);

part("A published course, or one whose state is not passed: no such line");
is("published", count(draw(false)), 0);
is("not passed", count(draw()), 0);

part("The studio's course page passes the product's own hidden flag");
const page = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
is("draft={product.hidden === true}", page.includes("draft={product.hidden === true}"), true);

done();
