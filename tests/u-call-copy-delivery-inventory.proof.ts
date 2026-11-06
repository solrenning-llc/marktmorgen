/**
 * Inventory evidence for paid-call copy that promises email delivery.
 *
 * tests/u-call-faq-delivery-copy.proof.ts already exercises the real booking
 * path: a paid booking is confirmed when the provider refuses both booking
 * messages. This companion test keeps every matching public and studio claim
 * in one correction envelope. It intentionally leaves all product files
 * untouched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { callBeginnerQuestions } from "@/lib/call-faq";
import { done, is, part } from "./check";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const editor = read("components/call-editor.tsx");
const features = read("lib/feature-pages.ts");
const faq = callBeginnerQuestions()[0]?.a ?? "";

function doesNotPromise(label: string, source: string, promise: string): void {
  is(label, source.includes(promise), false);
}

part("Controls that the correction must preserve");
is("the FAQ still identifies the paid-call answer", callBeginnerQuestions()[0]?.q, "What is a paid call here?");
is("the FAQ still explains that a calendar file is attempted", faq.includes("calendar file"), true);
is("the editor still gives buyers a purchases-page route", editor.includes("the buyer&apos;s purchases page"), true);
is("the feature page still says the booking appears in both records", features.includes("Upcoming calls, and in the buyer's list of purchases"), true);
is("the feature page still says Google itself sends no email", features.includes("Google emails nobody"), true);

part("Beginner FAQ");
doesNotPromise(
  "the FAQ does not promise both booking messages",
  faq,
  "The buyer gets an email with a calendar file. You get one too",
);

part("Public calls feature page");
doesNotPromise(
  "the calls introduction does not promise both booking messages",
  features,
  "Then the buyer and you get an email; on a team call, the host gets yours",
);
doesNotPromise(
  "the booking step does not promise both booking messages",
  features,
  "The buyer gets an email with a calendar file and the link to meet, or a note that you will send it. You get one too",
);
doesNotPromise(
  "the Google feature does not promise the link arrives in our email",
  features,
  "the link comes in our emails and calendar file",
);
doesNotPromise(
  "the Google FAQ does not promise the link arrives in our booking email",
  features,
  "buyers get the link in our booking email, reminders and calendar file",
);
doesNotPromise(
  "the coaches page does not promise both booking messages",
  features,
  "each of you gets an email about the booking",
);

part("Call editor guidance");
doesNotPromise(
  "the meeting guidance does not promise links arrive in our emails",
  editor,
  "Buyers get its join link in our emails and calendar file",
);
doesNotPromise(
  "the live-session guidance does not promise the buyer message",
  editor,
  "Each buyer gets the session's link, or a note that you will send it, and a calendar file the moment they have paid",
);
doesNotPromise(
  "the live-session guidance does not promise the creator message",
  editor,
  "You get one email per booking",
);
doesNotPromise(
  "the weekly-call guidance does not promise both booking messages",
  editor,
  "The buyer gets an email with a calendar file. You get one too, or the host does on a team call",
);

done();
