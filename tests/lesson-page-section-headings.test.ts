/**
 * AX274 (WCAG 2.2 1.3.1, 2.4.6 and 2.4.10 Section Headings): on a course's lesson page the side panel with the
 * course outline and the lesson's downloads were introduced by a styled paragraph, so a screen reader moving by
 * heading or landmark skipped them and the side panel was an unnamed region. Each is now a level-2 heading under
 * the lesson's h1 (the quiz and the comments are h2 as well), and the side panel is named by its heading.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");

part("The lesson page's sections have headings");
is("the outline panel is named by its heading", /<aside[^>]*aria-labelledby="lesson-outline-title"/.test(page), true);
is("…a level-2 heading", page.includes('<h2 id="lesson-outline-title" className="st-label">{w.inThisCourse}</h2>'), true);
is("the downloads are a level-2 heading", page.includes('<h2 className="st-label">{w.downloads}</h2>'), true);
is("no section is introduced by a paragraph any more", /<p className="st-label">\{w\.(inThisCourse|downloads)\}/.test(page), false);
is("one h1 on the page", (page.match(/<h1\b/g) ?? []).length, 1);

done();
