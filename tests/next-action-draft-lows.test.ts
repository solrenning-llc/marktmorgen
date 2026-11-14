/**
 * The six LOWs open on #3558 (reviews 6828531712 and the second out-of-family review at ba9a1d1bc6):
 * - threats in words passed readDraft ("ends unless", "have to cancel");
 * - harmless words were refused after the call was paid ("soon", "deal with", "offer a hand");
 * - a sender name was taken out of the text inside other words, so a one-letter name hid "free";
 * - invented facts about the member's account passed (a cause, a date, a retry, a paused account);
 * - Copy's hold was only aria-disabled in the markup: nothing tested that copy() refuses;
 * - "Close the draft" threw away a paid draft and its edits with no way back.
 * Pure functions and static markup only; no model, no network.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NEXT_DRAFT_COPY_HOLD, NextActionDraftClosed, copyHold } from "@/components/next-action-draft";
import { draftRequest, readDraft } from "@/lib/next-action-draft-rules";
import { done, is, part } from "./check";

const names = { storeName: "Calm Yoga", creatorName: "Ana" };
const said = (body: string, n = names) => {
  const r = readDraft({ subject: "About your membership", body: `Hi,\n\n${body}\n\nAna` }, n);
  return r.ok ? "ok" : r.why;
};

part("Threats are refused");
is("ends unless", said("Your membership ends unless you update your card. Update your card now."), "pressure");
is("have to cancel", said("I'll have to cancel your membership if this is not fixed."), "pressure");
is("cancel your access", said("We may cancel your access."), "pressure");

part("Harmless words are kept");
is("hear from you soon", said("I hope to hear from you soon."), "ok");
is("as soon as you can, kindly", said("Have a look when you can, as soon as you can is fine."), "ok");
is("help you deal with it", said("I'm happy to help you deal with it."), "ok");
is("offer a hand", said("I wanted to offer a hand."), "ok");
is("a special offer is still refused", said("Here is a special offer for you."), "offer");
is("a great deal is still refused", said("It is a great deal."), "offer");
is("a sale is still refused", said("There is a sale on."), "offer");

part("A name is taken out only as a whole word");
is("a one-letter sender name never hides free", said("You can get a free month.", { storeName: "Calm Yoga", creatorName: "e" }), "free");
is("a name holding a refused word is still taken out", said("Thanks for being part of Free Spirit Yoga.", { storeName: "Free Spirit Yoga", creatorName: "Ana" }), "ok");

part("Invented facts about the account are refused");
for (const sentence of [
  "Your membership has been paused until the card is updated.",
  "Your access is on hold for now.",
  "Stripe will try your card again in a few days.",
  "I noticed your March payment did not go through.",
  "Your card was declined because it expired last week.",
]) is(sentence, said(sentence) === "ok", false);
is("the plain note still passes", said("Your latest membership payment did not go through. The card on file may need a look. You can reply to this email with any question."), "ok");
is("the instructions say not to state why, when or what changed", draftRequest("failed_payments", { storeName: "Calm Yoga", creatorName: "Ana", rules: "" })?.system.includes("Do not say why the payment failed, when it will be tried again, or whether access has changed."), true);

part("Copy refuses until all three are checked");
is("none checked", copyHold([false, false, false]), NEXT_DRAFT_COPY_HOLD);
is("two checked", copyHold([true, true, false]), NEXT_DRAFT_COPY_HOLD);
is("all checked", copyHold([true, true, true]), null);
const screen = readFileSync("components/next-action-draft.tsx", "utf8");
const copyBody = screen.slice(screen.indexOf("async function copy()"), screen.indexOf("navigator.clipboard.writeText"));
is("copy() returns on copyHold before it writes to the clipboard", /const hold = copyHold\(checks\);\n\s+if \(hold\) \{[\s\S]*?return;\n\s+\}/.test(copyBody), true);

part("A closed draft can be shown again without a new call");
const closed = renderToStaticMarkup(createElement(NextActionDraftClosed, { id: "x", jobs: 1, busy: false, kept: true, onWrite: () => {}, onShowAgain: () => {} }));
is("Show the draft again is offered", closed.includes(">Show the draft again</button>"), true);
is("and it says it uses nothing", closed.includes("uses none of your AI uses"), true);
const fresh = renderToStaticMarkup(createElement(NextActionDraftClosed, { id: "x", jobs: 1, busy: false, kept: false, onWrite: () => {}, onShowAgain: () => {} }));
is("nothing kept: only Write a draft", [fresh.includes("Show the draft again"), fresh.includes("Write a draft with AI")], [false, true]);

done();
