/**
 * 656 [WG16], unit 6: the course's own page in the studio and the studio's
 * Discord page use the one studio empty state (components/empty-state.tsx,
 * StudioEmptyState) where a list is empty, instead of a bare sentence in a
 * sand box:
 *
 *   - "Students": no one has opened the course yet. The title is an h3 under
 *     the section's h2, the sentence says who will be listed, and the one
 *     action is the course's sale page, to share it, drawn only while the
 *     store can sell the course (otherwise the link would lead to a page that
 *     sells nothing, so no action is drawn and the sentence says why);
 *   - "Completions": no certificate issued. Its two true sentences are kept
 *     (certificates on: nobody finished yet; off: switch them on above), with
 *     no action, since the switch sits just above in the same section;
 *   - "Who joined" on the Discord page: nobody joined yet; its sentence is
 *     kept, with no action, since buyers join after paying.
 *
 * Read from the source, as unit 2's test reads the blog and reviews pages:
 * these pages need a signed-in owner and a Stripe account to render.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioEmptyState } from "@/components/empty-state";
import { done, is, part } from "./check";

const course = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
const discord = readFileSync("components/discord-studio.tsx", "utf8");

part("The course's students: an empty list");
is("the page imports the studio empty state", /import \{[^}]*\bStudioEmptyState\b[^}]*\} from "@\/components\/empty-state";/.test(course), true);
is("the page imports how a product's sale page is addressed", /import \{[^}]*\bproductSegment\b[^}]*\} from "@\/lib\/product-slug";/.test(course), true);
is(
  "no students: the studio empty state, an h3 under the section's h2",
  course.includes('{students.length === 0 ? (\n            <StudioEmptyState\n              level={3}\n              compact\n              className="mt-5"\n              title="No students yet"'),
  true,
);
is(
  "its sentence says who is listed, and why nobody can be while the course is not on sale",
  course.includes('body={selling ? "Each buyer who opens the course is listed here, with the lessons they marked done." : "Each buyer who opens the course is listed here. It is not on sale yet, so nobody can buy it."}'),
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
  "no certificate: the studio empty state, an h3 like the list's own heading",
  course.includes('{certificates.list.length === 0 ? (\n            <StudioEmptyState\n              level={3}\n              compact\n              className="mt-3"\n              title={course.certificate ? "No certificates yet" : "Certificates are off"}'),
  true,
);
is(
  "its two true sentences are kept",
  course.includes('body={course.certificate ? "Nobody has finished yet. When a student does and asks for their certificate, it is listed here." : "Switch certificates on above and each student who finishes is listed here with theirs."}'),
  true,
);
is("no action: the switch is just above, in the same section", /title=\{course\.certificate \? "No certificates yet"[\s\S]{0,400}?action=/.test(course.slice(course.indexOf('"Certificates are off"') - 200, course.indexOf('"Certificates are off"') + 400)), false);
is("no bare sentence left where nobody finished", course.includes('<p className="mt-3 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">'), false);

part("The Discord page: nobody joined yet");
is("the component imports the studio empty state", /import \{[^}]*\bStudioEmptyState\b[^}]*\} from "@\/components\/empty-state";/.test(discord), true);
is(
  "nobody joined: the studio empty state, an h3 under the section's h2, its sentence kept, no action",
  discord.includes('{members.length === 0 ? (\n          <StudioEmptyState\n            level={3}\n            compact\n            className="mt-5"\n            title="Nobody has joined yet"\n            body="Buyers see “Join the Discord” after paying, and on their orders."\n          />'),
  true,
);
is("the section's heading it sits under is an h2", discord.includes('<h2 id="discord-people"'), true);
is("no bare sentence left", discord.includes(">Nobody has joined yet. Buyers see"), false);

part("What the creator sees, drawn by the real component");
const students = renderToStaticMarkup(
  createElement(StudioEmptyState, {
    level: 3,
    compact: true,
    className: "mt-5",
    title: "No students yet",
    body: "Each buyer who opens the course is listed here, with the lessons they marked done.",
    action: { href: "/@harbor/p/first-course-c1", label: "Open the sale page to share it" },
  }),
);
is("a heading, one sentence and one real link to the sale page, at least 44 px tall (.btn is 48 px)", /^<div class="mt-5" data-empty-state=""><h3 class="text-base font-semibold text-ink">No students yet<\/h3><p class="mt-1 text-sm text-ink-soft">Each buyer who opens the course is listed here, with the lessons they marked done\.<\/p><a class="btn btn-secondary mt-4" href="\/@harbor\/p\/first-course-c1">Open the sale page to share it<\/a><\/div>$/.test(students), true);
const notOnSale = renderToStaticMarkup(createElement(StudioEmptyState, { level: 3, compact: true, title: "No students yet", body: "Each buyer who opens the course is listed here. It is not on sale yet, so nobody can buy it." }));
is("not on sale: no link, no button", /<a |<button/.test(notOnSale), false);

done();
