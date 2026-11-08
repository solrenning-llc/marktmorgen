/**
 * 656 [WG16], unit 4: four more lists use the one empty-state pattern
 * (components/empty-state.tsx): a heading, one sentence and, only where it
 * works, one action. In the studio: agreements (with a jump to the form that
 * sends one, only for someone who may send), comments under lessons, and forms
 * (whose "New form" button and examples already sit right there). On the
 * store: its published emails, in every buyer language.
 */
import { readFileSync } from "node:fs";
import { LETTER_WORDS } from "@/lib/buyer-words/letters";
import { done, is, part } from "./check";

part("Agreements: a heading, a sentence, and the jump to the form only for someone who may send");
const agreements = readFileSync("components/agreements-studio.tsx", "utf8");
is("drawn by the pattern under the list's h2", agreements.includes('<StudioEmptyState title="No agreements yet" body="An agreement you send shows here, with whether it was signed." action={canSend && open ? { href: "#ag-kind", label: "Write your first agreement" } : undefined} className="mt-3" />'), true);
// Claude 4 on #3165, the same two LOWs here: no jump while sending is closed (the form's buttons are disabled; VR
// item 2), and a link text that names what it writes (WCAG 2.4.9, AAA).
is("no jump while sending is closed", /action=\{canSend && open \? \{ href: "#ag-kind"/.test(agreements), true);
is("the link names what it writes", agreements.includes('label: "Write your first agreement"') && !agreements.includes('label: "Write the first one"'), true);
is("the jump goes to the form's first field, which exists", /<select id="ag-kind"/.test(agreements), true);
is("no bare sentence left", agreements.includes('<p className="mt-3 text-ink-soft">No agreements yet.</p>'), false);

part("Comments under lessons");
const comments = readFileSync("components/course-comments-studio.tsx", "utf8");
is("drawn by the pattern under the section's h2", comments.includes('<StudioEmptyState title="No comments yet" body="The newest ones will show here, with a way to answer each." className="mt-6" />'), true);
is("no bare sentence left", comments.includes(">No comments yet. The newest ones will show here, with a way to answer each.</p>"), false);

part("Forms: the heading and the sentence above the examples");
const forms = readFileSync("components/forms-editor.tsx", "utf8");
is("drawn by the pattern, compact inside the examples box", forms.includes('<StudioEmptyState compact title="No forms yet" body="Make one, then add a Form block to one of your pages under Pages and choose it there." />'), true);
is("no bare sentence left", forms.includes("<p>No forms yet. Make one, then add a Form block"), false);

part("The store's published emails, in every buyer language");
for (const [language, w] of Object.entries(LETTER_WORDS)) {
  is(`${language}: a heading over the empty list`, typeof w.emptyTitle === "string" && w.emptyTitle.trim().length > 0, true);
}
const letters = readFileSync("app/[handle]/letters/page.tsx", "utf8");
is("drawn by the pattern, with a way back to the store", letters.includes('<EmptyState title={w.emptyTitle} body={w.empty} action={{ href: `/@${store.handle}`, label: w.visit(store.name) }} className="mt-8" />'), true);
is("no bare sentence left", letters.includes("{w.empty}</p>"), false);

done();
