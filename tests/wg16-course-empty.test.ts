/**
 * 656 [WG16], unit 6: the course's own page in the studio uses the one
 * studio empty state (components/empty-state.tsx,
 * StudioEmptyState) where a list is empty, instead of a bare sentence in a
 * sand box:
 *
 *   - "Students": no one has opened the course yet. The title is an h3 under
 *     the section's h2, the sentence says who will be listed, and the one
 *     action is the course's sale page, to share it, drawn only while the
 *     store can sell the course (otherwise the link would lead to a page that
 *     sells nothing, so no action is drawn); the sentence is the same either
 *     way, since a free course is never "sold" and still has students;
 *   - "Completions": no certificate issued. Its two true sentences are kept
 *     (certificates on: nobody finished yet; off: switch them on above), with
 *     no action, since the switch sits just above in the same section.
 *
 * The Discord page's "Who joined" waits for #2932 and #3017 (Claude 5), which
 * hold lib/discord-store.ts and the Discord page; it is not changed here.
 *
 * Read from the source, as unit 2's test reads the blog and reviews pages:
 * this page needs a signed-in owner and a Stripe account to render.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioEmptyState } from "@/components/empty-state";
import { done, is, part } from "./check";

const course = readFileSync("app/studio/course/[product]/page.tsx", "utf8");

part("The course's students: an empty list");
is("the page imports the studio empty state", /import \{[^}]*\bStudioEmptyState\b[^}]*\} from "@\/components\/empty-state";/.test(course), true);
is("the page imports how a product's sale page is addressed", /import \{[^}]*\bproductSegment\b[^}]*\} from "@\/lib\/product-slug";/.test(course), true);
is(
  "no students: the studio empty state, an h3 under the section's h2",
  course.includes(' students.length === 0 ? (\n            <StudioEmptyState\n              level={3}\n              compact\n              className="mt-5"\n              title="No students yet"'),
  true,
);
is(
  "its sentence says who is listed, the same whether or not the course is on sale (a free course is never sold, yet students open it)",
  course.includes('body="Each student who opens the course is listed here, with the lessons they marked done."'),
  true,
);
is(
  "its one action is the course's sale page, to share it, only while the store can sell it",
  course.includes('action={selling ? { href: `/@${store.handle}/p/${productSegment(product)}`, label: "Open the sale page to share it" } : undefined}'),
  true,
);
is("the section's heading it sits under is an h2", course.includes('<h2 id="students-title"'), true);
is("no bare sentence left where nobody opened it", course.includes(">Nobody has opened it yet.<"), false);

part("The course's completions: no certificate issued");
is(
  "no certificate: the studio empty state, an h4 under the list's own h3, Completions",
  course.includes(' certificates.list.length === 0 ? (\n            <StudioEmptyState\n              level={4}\n              compact\n              className="mt-3"\n              title={course.certificate ? "No certificates yet" : "Certificates are off"}'),
  true,
);
is(
  "its two true sentences are kept",
  course.includes('body={course.certificate ? "Nobody has finished yet. When a student does and asks for their certificate, it is listed here." : "Switch certificates on above and each student who finishes is listed here with theirs."}'),
  true,
);
is("no action: the switch is just above, in the same section", /title=\{course\.certificate \? "No certificates yet"[\s\S]{0,400}?action=/.test(course.slice(course.indexOf('"Certificates are off"') - 200, course.indexOf('"Certificates are off"') + 400)), false);
is("no bare sentence left where nobody finished", course.includes('<p className="mt-3 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">'), false);

part("What the creator sees, drawn by the real component");
const students = renderToStaticMarkup(
  createElement(StudioEmptyState, {
    level: 3,
    compact: true,
    className: "mt-5",
    title: "No students yet",
    body: "Each student who opens the course is listed here, with the lessons they marked done.",
    action: { href: "/@harbor/p/first-course-c1", label: "Open the sale page to share it" },
  }),
);
is("a heading, one sentence and one real link to the sale page, at least 44 px tall (.btn is 48 px)", /^<div class="mt-5" data-empty-state=""><h3 class="text-base font-semibold text-ink">No students yet<\/h3><p class="mt-1 text-sm text-ink-soft">Each student who opens the course is listed here, with the lessons they marked done\.<\/p><a class="btn btn-secondary mt-4" href="\/@harbor\/p\/first-course-c1">Open the sale page to share it<\/a><\/div>$/.test(students), true);
const notOnSale = renderToStaticMarkup(createElement(StudioEmptyState, { level: 3, compact: true, title: "No students yet", body: "Each student who opens the course is listed here, with the lessons they marked done." }));
is("not on sale: no link, no button", /<a |<button/.test(notOnSale), false);

done();
