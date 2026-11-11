/**
 * What the poll page draws (125 [F2-EMAIL-POLLS], unit 5:
 * components/email-poll-view.tsx), from synthetic states.
 *
 * What fails here:
 *   - an answer without its own label, the answers without a named group,
 *     or the page without the store's language marked (AX274);
 *   - a form that would vote on opening (anything but a POST), or a press
 *     that does not come back to the page;
 *   - Confirm and Take back offered on a closed poll;
 *   - a result said that did not happen, or not said in a live region;
 *   - the end shown without its time zone.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PollView } from "@/components/email-poll-view";
import { done, is, part } from "./check";

const poll = { question: "Which class next?", options: ["Glazing", "Trimming", "Firing"], days: 7 };
const closesAt = Date.UTC(2026, 10, 18, 12);
const open = { state: "open" as const, poll, sender: "Ana at Clay House", language: "en", closesAt };
const draw = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(PollView, { broadcastId: "0123456789abcdef01234567", link: "2.abc", asked: "", done: "", ...props } as Parameters<typeof PollView>[0]));

part("An open poll");
const html = draw({ page: open, asked: "1" });
is("the store's language marked", /<main[^>]*lang="en-US"/.test(html), true);
is("one heading: the question", (html.match(/<h1[^>]*>([^<]*)</) ?? [])[1], "Which class next?");
is("the answers in a named group", /<fieldset><legend[^>]*>Your answer<\/legend>/.test(html), true);
is("each answer inside its own label", poll.options.every((o, i) => new RegExp(`<label[^>]*><input(?=[^>]*type="radio")(?=[^>]*name="a")(?=[^>]*value="${i}")[^>]*/><span>${o}</span></label>`).test(html)), true);
is("the answer from the email's link chosen, only that one", (html.match(/checked=""/g) ?? []).length === 1 && /<input(?=[^>]*value="1")(?=[^>]*checked="")[^>]*\/>/.test(html), true);
is("both forms are POSTs to the route, coming back to the page", (html.match(/<form[^>]* action="\/api\/mail\/poll\?b=0123456789abcdef01234567&amp;k=2\.abc" method="post"/g) ?? []).length, 2);
is("both say they come from the page", (html.match(/name="from" value="page"/g) ?? []).length, 2);
is("Confirm and Take back", /Confirm my answer/.test(html) && /Take back my answer/.test(html), true);
is("opening counted nothing, said", /Opening this page counted nothing/.test(html), true);
is("the end with its time zone", /until November 18, 2026 \(UTC\)/.test(html), true);
is("nothing said yet, but the live region is there", /<p role="status" class="sr-only"><\/p>/.test(html), true);
is("no answer chosen from a link that names none", (draw({ page: open }).match(/checked=""/g) ?? []).length, 0);
is("an answer the poll does not have chooses none", (draw({ page: open, asked: "7" }).match(/checked=""/g) ?? []).length, 0);

part("What happened, said in the live region");
is("counted", /<p role="status" class="mt-3 font-semibold">Your answer is counted\./.test(draw({ page: open, done: "recorded" })), true);
is("taken back", /role="status"[^>]*>Your answer is taken back\./.test(draw({ page: open, done: "withdrawn" })), true);
is("not saved: says nothing was counted", /role="status"[^>]*>We could not save that just now\. Nothing was counted\./.test(draw({ page: open, done: "unknown" })), true);
is("a word that is not a result says nothing", /<p role="status" class="sr-only"><\/p>/.test(draw({ page: open, done: "hacked" })), true);

part("Closed");
const closed = draw({ page: { ...open, state: "closed" } });
is("said closed", /This poll has closed/.test(closed), true);
is("no form, no button", /<form|<button/.test(closed), false);

part("Not shown");
is("an unknown link", /<h1[^>]*>We do not know this poll link<\/h1>/.test(draw({ page: { state: "invalid" } })), true);
is("not readable now", /<h1[^>]*>This poll could not be opened just now<\/h1>/.test(draw({ page: { state: "unknown" } })), true);
is("resting, in the store's language", /lang="fr-FR"[\s\S]*ne peut pas recevoir de réponses/.test(draw({ page: { state: "resting", language: "fr" } })), true);
is("no poll and no form in any of them", ["invalid", "unknown"].some((state) => /<form/.test(draw({ page: { state } }))), false);

done();
