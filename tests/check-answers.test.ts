/**
 * Before an email goes to people, a summary with "Change" on each item
 * (487 [IT4], pattern 8, GOV.UK "Check answers"; added 1 November 2026;
 * components/email-studio.tsx). Checked:
 *
 *   - the review is a summary list: the subject, who gets it and when, each
 *     as a term and its answer, never one sentence to parse;
 *   - each row has a "Change" button whose name says what it changes, and it
 *     closes the review and puts the focus on that field;
 *   - the fields it leads to have the ids it names;
 *   - the review still says the audience is checked again when sending starts,
 *     and the send button still names how many people.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const studio = readFileSync("components/email-studio.tsx", "utf8");
const review = studio.slice(studio.indexOf('id="mail-send-review"'), studio.indexOf("Eligibility is checked again when sending starts."));
is("the review is a summary list of terms and answers", review.includes("<dl") && (review.match(/<dt/g) ?? []).length >= 3, true);
is("subject, who gets it and when are each a row", ["Subject", "Who gets it", "When"].every((term) => review.includes(`>${term}</dt>`)), true);
for (const [what, id] of [["subject", "mail-subject"], ["who gets it", "mail-send-to"], ["when", "mail-when"]] as const) {
  is(`"Change" for ${what} leads to its field`, review.includes(`changeAnswer("${id}")`) && review.includes(`<span className="sr-only"> ${what}</span>`), true);
}
is("each field it leads to has that id", studio.includes('id="mail-subject"') && studio.includes('id="mail-send-to"') && studio.includes('id="mail-when"'), true);
is("Change closes the review and moves the focus to the field", /function changeAnswer\(id: string\) \{\s*setConfirming\(false\);\s*requestAnimationFrame\(\(\) => document\.getElementById\(id\)\?\.focus\(\)\);/.test(studio), true);
is("the review is no live region (it would repeat at every key); its heading takes the focus when it opens", !studio.includes('id="mail-send-review" role="status"') && studio.includes('<h3 id="mail-send-review-title" tabIndex={-1}') && studio.includes('requestAnimationFrame(() => document.getElementById("mail-send-review-title")?.focus());'), true);
is("the send button is described by one short sentence, not the whole list", studio.includes('aria-describedby="mail-send-note"') && studio.includes('<p id="mail-send-note"'), true);
is("on a phone each answer takes its own line under its term", (review.match(/basis-full break-words sm:basis-0 sm:flex-1/g) ?? []).length, 3);
is("the audience is still checked again when sending starts, and the button still names how many", studio.includes("Eligibility is checked again when sending starts.") && studio.includes("`Yes, send it to ${n(reach)}`"), true);

const update = readFileSync("components/product-update-box.tsx", "utf8");
const waitlist = readFileSync("components/waitlist-panel.tsx", "utf8");
const launchReview = waitlist.slice(waitlist.indexOf('id={`waitlist-${productId}-review`}'), waitlist.indexOf("Put it on sale and tell the waitlist\"\n"));
is("before the waitlist's sale and email, a summary list: on sale, price, emails, note, postal address", launchReview.includes("<dl") && ["Goes on sale", "Price", "Emails", "Note", "Postal address"].every((term) => launchReview.includes(`>${term}</dt>`)), true);
is("the price shown is the product's own, as the email carries it", waitlist.includes("price: string;") && readFileSync("components/product-editor.tsx", "utf8").includes("price={formatMoney(product.priceCents, currency)}"), true);
is("the note and the address each have a Change that leads to their field", launchReview.includes("changeAnswer(`waitlist-${productId}-note`)") && launchReview.includes("changeAnswer(`waitlist-${productId}-address`)") && waitlist.includes("id={`waitlist-${productId}-note`}") && waitlist.includes("id={`waitlist-${productId}-address`}"), true);
is("the price says where it is changed, since it is the product's", launchReview.includes("Change it in the product's details above."), true);
is("the second press still names how many emails, in the singular for one", waitlist.includes('`Press again: on sale now, ${view.confirmed.toLocaleString("en-US")} ${view.confirmed === 1 ? "email" : "emails"}`'), true);
is("changing the note or the address closes the review, so nothing is sent unread", waitlist.includes("setNote(e.target.value); setConfirming(false);") && waitlist.includes("setAddress(e.target.value); setConfirming(false);"), true);
is("without a postal address the second press is not offered, and the review says why", waitlist.includes("(confirming && view.confirmed > 0 && !address.trim())") && waitlist.includes("None yet. Add one before it can go out."), true);
is("both reviews are a heading one level under their section", waitlist.includes("<h3 id={`waitlist-${productId}-review-title`}") && update.includes("<h3 id={`${id}-review-title`}"), true);

is("emailing buyers about an update asks first, with a summary list: product, who gets it, note", update.includes("<dl") && ["Product", "Who gets it", "Note"].every((term) => update.includes(`>${term}</dt>`)), true);
is("how many is not guessed: it is counted from the store's Stripe account when it is sent", update.includes("Everyone who bought it. They are counted from your Stripe account when it is sent."), true);
is("the note has a Change that closes the review and goes back to it", update.includes("Change<span className=\"sr-only\"> note</span>") && update.includes("setReviewing(false)"), true);
is("nothing is sent from the first press, which says so: only from the review's own button", update.includes("if (!reviewing) {") && update.includes("Yes, email every buyer") && update.includes('"Check before sending"'), true);
is("changing the note closes the review, so nothing is sent from an old one", update.includes("setNote(event.target.value); setReviewing(false);"), true);

const productEditor = readFileSync("components/product-editor.tsx", "utf8");
is("saving a new price on a product buyers can see asks first, showing the old price and the new one", productEditor.includes("const priceChanged = !product.hidden && !product.options.length && !draft.every && !draft.pwyw && newPrice !== null && newPrice !== product.priceCents;") && productEditor.includes(">Price</dt>") && productEditor.includes("`${formatMoney(product.priceCents, currency)} now, ${formatMoney(newPrice, currency)} once you save.`"), true);
is("a price that cannot be read is not reviewed: the save says what is wrong with it", productEditor.includes("const newPrice = readMoney(draft.price, currency);") && productEditor.includes("priceChanged && priceReview !== product.id"), true);
is("the price has a Change that leads to its field, and the review ends on its own confirm button", productEditor.includes("changePrice(product.id)") && /onClick=\{save\}>\s*Yes, save the new price/.test(productEditor), true);
is("the same amount written another way (29 and 29.00) is not a change: amounts are compared, not text", productEditor.includes("newPrice !== product.priceCents"), true);
is("only a single price paid once is reviewed, where the field is what buyers pay", productEditor.includes("!draft.every && !draft.pwyw"), true);
is("changing the price again closes the review", productEditor.includes("if (next.price !== draft.price) setPriceReview(null);"), true);

const requests = readFileSync("components/payment-requests-studio.tsx", "utf8");
is("a payment request is reviewed before it is sent: who, the total, what it is for, the due date, reminders, the note", requests.includes("<dl") && ["To", "Total", "What it is for", "Due date", "If it is not paid", "Note"].every((term) => requests.includes(`>${term}</dt>`)), true);
is("any edit after the review opens closes it: it holds only while the form is what was reviewed", requests.includes("const reviewing = reviewOf !== null && reviewOf === snapshot && reviewed !== null;"), true);
is("the review opens only when the server's own reading takes the form, and shows what it read", requests.includes("const read = readDraft({ email, name, lines, note, dueDate, autoReminders: reminders, consent }, currency);") && requests.includes("setReviewed(read.draft);") && requests.includes("money(reviewed.total)") && requests.includes("${line.quantity} × ${money(line.cents)} = ${money(line.quantity * line.cents)}"), true);
is("what the reading refuses is said, and the focus goes to that field (each line by its number)", requests.includes("setError(DRAFT_PROBLEMS[read.problem]);") && requests.includes("`pr-line-${read.line}`"), true);
is("a failed send is said beside its button and read at once; nothing can change while it sends", requests.includes('id="pr-send-error" tabIndex={-1}') && requests.includes('<fieldset disabled={busy !== ""}'), true);
is("each answer has a Change that leads to its field", ["pr-email", "pr-line-0", "pr-due", "pr-reminders", "pr-note"].every((id) => requests.includes(`changeAnswer("${id}")`)) && ["pr-email", "pr-due", "pr-reminders", "pr-note"].every((id) => requests.includes(`id="${id}"`)) && requests.includes("id={`pr-line-${i}`}"), true);
is("the first press opens the review, and only the review's own button sends", /onClick=\{\(\) => void send\(\)\}>\s*\{busy === "create" \? "Sending\.\.\." : "Yes, send the request"\}/.test(requests) && requests.includes("Check before sending") && requests.includes("if (busy || !reviewing) return;"), true);

const agreements = readFileSync("components/agreements-studio.tsx", "utf8");
is("an agreement is reviewed before its link goes: kind, who, title, text, total and payment request", agreements.includes("<dl") && ["Kind", "To", "Title", "Text", "Total", "Payment request"].every((term) => agreements.includes(`>${term}</dt>`)), true);
is("any edit after the review opens closes it", agreements.includes("const reviewing = reviewOf !== null && reviewOf === snapshot && reviewed !== null;"), true);
is("the review opens only when the server's own reading takes the form, for a new version too, and shows what it read", agreements.includes("const read = readDraft({ kind, email, name, title, body, lines, payRequest, consent }, currency, editing ? { kind: editing.kind, email: editing.email, name: editing.name } : undefined);") && agreements.includes("setReviewed(read.draft);") && agreements.includes("{reviewed.title}"), true);
is("a refused draft or a failed send is said, with the focus on it; nothing changes while it sends", agreements.includes("setError(DRAFT_PROBLEMS[read.problem]);") && agreements.includes('id="ag-send-error" tabIndex={-1}') && agreements.includes('<fieldset disabled={busy !== ""}'), true);
is("each answer has a Change that leads to its field", ["ag-kind", "ag-email", "ag-title", "ag-body", "ag-pay"].every((id) => agreements.includes(`changeAnswer("${id}")`) && agreements.includes(`id="${id}"`)), true);
is("the first press opens the review, and only the review's own button sends", agreements.includes("Check before sending") && agreements.includes("if (busy || !reviewing) return;") && agreements.includes('editing ? "Yes, send the new version" : "Yes, send for signature"'), true);
is("a send error is not said again once the form it was about is edited", [agreements, requests].every((f) => f.includes("(errorFor === null || errorFor === snapshot)") && f.includes("setErrorFor(snapshot);")), true);
is("opening a version again or canceling never brings back an old review", /function reset\(\) \{\s*setReviewOf\(null\);\s*setReviewed\(null\);/.test(agreements) && /async function startEdit[\s\S]{0,80}?setReviewOf\(null\);\s*setReviewed\(null\);/.test(agreements), true);
is("after an agreement is sent the focus goes back to the start of the form", agreements.includes('requestAnimationFrame(() => document.getElementById("ag-email")?.focus());'), true);
is("the payment request row offers Change only when its field is there", agreements.includes("{payChoices.length ? <dd><button"), true);
done();
