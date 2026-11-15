/**
 * 299 [H5-2], unit 1: one next product, picked by the creator in the course's
 * settings, shown to a student on the course's page once they have finished
 * it. Read in the same reading as the course's "More from" shelf
 * (lib/course-shelf.ts), so a page view still pays for one reading, taken
 * before anything is read; the reading holds one pick more than the shelf's,
 * and its line in tests/plan-cost-registry.ts counts it.
 *
 * What fails here:
 *   - a pick kept that is not a product id, or is the course itself;
 *   - offered: the finished course, something the student has, anything when
 *     what they have is unknown, a draft, a limited product, a bundle the
 *     buyer builds or one holding something they have, a product not on sale;
 *   - a second reading on the page, or the registry line not counting the
 *     extra pick;
 *   - any discount, countdown, scarcity, count, testimonial, video or
 *     autoplay; the box taking focus; no way to dismiss it, or it coming back
 *     once dismissed; anything stored on the server to remember that;
 *   - a buyer language without its words.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COURSE_OFFER_PICKS, MAX_SHELF, nextFor, readNext } from "@/lib/course-shelf-rules";
import { editCourse, parseCourse, type Course } from "@/lib/course";
import { CourseNextBox, NEXT_DISMISS_COOKIE } from "@/components/course-next-box";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import type { Listing } from "@/lib/store";
import { done, is, part } from "./check";

const listing = (id: string, extra: Partial<Listing> = {}) => ({ id, title: `T ${id}`, priceCents: 2500, hidden: false, stock: null, ...extra }) as unknown as Listing;

part("The creator's pick, as kept");
is("a product id", readNext("abcdef12", "course0001"), "abcdef12");
is("the course itself is never its own next", readNext("course0001", "course0001"), "");
is("not an id", readNext("<script>", "course0001"), "");
is("not a string", readNext(42, "course0001"), "");
const course = { id: "0123456789abcdef0123456789abcdef", modules: [], certificate: false, startsAt: null } as unknown as Course;
const set = editCourse(course, { op: "next", product: "abcdef12", courseProductId: "course0001" });
is("set by an edit", set.ok && set.course.next, "abcdef12");
const cleared = set.ok ? editCourse(set.course, { op: "next", product: "", courseProductId: "course0001" }) : set;
is("cleared by an empty edit", cleared.ok && !("next" in cleared.course), true);
is("kept when the course is read back", parseCourse(JSON.stringify({ ...course, next: "abcdef12" }))?.next, "abcdef12");
is("an invalid pick is dropped when read back", parseCourse(JSON.stringify({ ...course, next: "<x>" }))?.next, undefined);

part("What is offered, and what never");
const sold = new Map([["abcdef12", listing("abcdef12")]]);
is("the pick, on sale, not owned", nextFor("abcdef12", sold, new Set(), "course0001")?.id, "abcdef12");
is("unknown ownership: nothing", nextFor("abcdef12", sold, null, "course0001"), null);
is("owned: nothing", nextFor("abcdef12", sold, new Set(["abcdef12"]), "course0001"), null);
is("not on sale (not among the sold): nothing", nextFor("abcdef12", new Map(), new Set(), "course0001"), null);
is("the course itself: nothing", nextFor("course0001", new Map([["course0001", listing("course0001")]]), new Set(), "course0001"), null);
is("a draft: nothing", nextFor("abcdef12", new Map([["abcdef12", listing("abcdef12", { hidden: true })]]), new Set(), "course0001"), null);
is("a limited product: nothing", nextFor("abcdef12", new Map([["abcdef12", listing("abcdef12", { stock: 5 } as Partial<Listing>)]]), new Set(), "course0001"), null);
is("a bundle holding something owned: nothing", nextFor("abcdef12", new Map([["abcdef12", listing("abcdef12", { bundle: ["x1", "y2"] } as Partial<Listing>)]]), new Set(["x1"]), "course0001"), null);
is("no pick: nothing", nextFor("", sold, new Set(), "course0001"), null);

part("One reading for the page, paid before it reads");
is("the reading holds one pick more than the shelf", COURSE_OFFER_PICKS, MAX_SHELF + 1);
const registry = readFileSync("tests/plan-cost-registry.ts", "utf8");
is("the registry's shelf reading counts that pick", /export const SHELF_READ = request\("wait", NEXT_OFFER_COMMANDS \+ TAKE_COMMANDS \+ COURSE_OFFER_PICKS,/.test(registry), true);
const page = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
is("the page reads once, for both", (page.match(/await courseOffers\(/g) ?? []).length === 1 && !page.includes("await shelfShown("), true);
is("shown only once the student has finished, unless dismissed", page.includes("finished && offers.next && !dismissed"), true);

part("The box");
const html = renderToStaticMarkup(createElement(CourseNextBox, { courseId: "c1", store: "Kiln Works", product: { id: "abcdef12", title: "Glazes 201", price: "$25", href: "/@kiln/p/abcdef12", image: null }, language: "en" }));
const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
is("names the product and its published price", text.includes("Glazes 201") && text.includes("$25"), true);
is("a way to dismiss it", /<button[^>]*type="button"/.test(html) && text.includes(coursesWords("en").nextDismiss), true);
is("no focus taken, no video, no autoplay", /autofocus|autoFocus|<video|autoplay/i.test(html), false);
is("nothing urgent, scarce, counted or quoted", /% off|only \d|left|hurry|ends in|countdown|\d+ (students|buyers)|"[^"]{20,}"/i.test(text), false);
const box = readFileSync("components/course-next-box.tsx", "utf8");
is("dismissing remembers it in this browser only, never on the server", box.includes(`document.cookie = \`\${NEXT_DISMISS_COOKIE(`) && !/fetch\(/.test(box), true);
is("the cookie is the course's own", NEXT_DISMISS_COOKIE("c1"), "nl_next_off_c1");

part("Every buyer language has the words");
for (const code of LANGUAGE_CODES) {
  const w = coursesWords(code);
  is(`${code}: heading, dismiss`, [w.nextTitle("Zed").includes("Zed"), w.nextDismiss.length > 2], [true, true]);
}

done();
