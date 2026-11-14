/**
 * WCAG 3.1.2 Language of Parts: a language's own name ("Deutsch", "Français", "Português") written in an English
 * page is a part in that language, and a screen reader reads it with English sounds unless it is marked. The
 * studio's store language list and the course editor's caption languages wrote them unmarked on 13 November 2026.
 * Each now carries lang with the language's own code, on the option or the words that name it.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("The store language list marks each language's name");
const store = readFileSync("components/store-language-editor.tsx", "utf8");
is("each option carries its language", /<option key=\{code\} value=\{code\} lang=\{code\}>/.test(store), true);

part("The caption languages mark each language's name");
const course = readFileSync("components/course-editor.tsx", "utf8");
is("both lists of options carry their language", (course.match(/<option key=\{language\.code\} value=\{language\.code\} lang=\{language\.code\}>/g) ?? []).length, 2);
is("the checkbox words carry their language", course.includes("<span lang={language.code}>{language.label}</span>"), true);
is("a kept track's name carries its language", course.includes('<span className="text-ink" lang={track.lang}>{track.label}</span>'), true);
done();
