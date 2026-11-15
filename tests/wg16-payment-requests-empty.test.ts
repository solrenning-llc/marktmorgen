/**
 * 656 [WG16], unit 8: the studio's payment requests list uses the one
 * empty-state pattern (components/empty-state.tsx), as the agreements list does
 * in unit 4 (#3143): a heading, one sentence, and a jump to the form's first
 * field, drawn only for someone whose role may send (the form is not shown to
 * anyone else) and only while sending is open (Claude 4 on #3165). The page already says when the list could not be read
 * (rule 23), so the empty state is drawn only for a list read as empty.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

part("Payment requests: a heading, a sentence, and the jump to the form only for someone who may send");
const requests = readFileSync("components/payment-requests-studio.tsx", "utf8");
is(
  "drawn by the pattern under the list's h2",
  requests.includes('<StudioEmptyState title="No payment requests yet" body="A request you send shows here, with whether it was paid." action={canSend && open ? { href: "#pr-email", label: "Write your first payment request" } : undefined} className="mt-3" />'),
  true,
);
// Claude 4 on #3165, LEVE 1 (VR item 2): with sending closed the form's Create button is disabled, so no action may
// invite the creator to write one; the role="alert" above the form says why.
is("no jump while sending is closed: the action needs open as well as canSend", /action=\{canSend && open \?/.test(requests), true);
// LEVE 2 (WCAG 2.4.9, AAA): the link's own text says what it makes.
is("the link names what it writes", requests.includes('label: "Write your first payment request"') && !requests.includes('label: "Write the first one"'), true);
is("the jump goes to the form's first field, which exists", /<input id="pr-email"/.test(requests), true);
is("the form is drawn only for someone who may send, as the jump is", requests.includes("{canSend ? (\n        <form onSubmit={create}"), true);
is("no bare sentence left", requests.includes('<p className="mt-3 text-ink-soft">No requests yet.</p>'), false);

part("An unread list is never drawn as empty");
const page = readFileSync("app/studio/requests/page.tsx", "utf8");
is("the page shows a status note instead", /listed === null \|\| openNow === null \? <div role="status" className="notice mt-8">/.test(page), true);

done();
