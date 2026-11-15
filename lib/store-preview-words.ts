/**
 * 488 [IT5] unit 3b: the words of the store preview on the home page (components/store-preview-form.tsx), in plain US
 * English. None promises a time it has not measured (219 [OP5] scope 7), none says the draft is published, and every
 * refusal says what the visitor can do next. Pure: no React, no network.
 */
export const PREVIEW_WORDS = {
  heading: "See your store before you sign up",
  intro: "Tell us what you make and who it is for. We write a first draft of your store: a line under your name, a few products and the questions buyers ask.",
  label: "What do you make, and who is it for?",
  example: "Example: I teach watercolor to beginners and sell a six-lesson course.",
  button: "Write my store draft",
  writing: "Writing your draft. This page will say when it is ready.",
  ready: "Your draft is ready. It is below.",
  notPublished: "This is a draft written with AI from your words. Nothing is published, and nothing goes live unless you sign up and choose to.",
  noPrice: "No price yet: you set it.",
  empty: "There was not enough to write a draft from. Add a sentence about what you make and try again.",
  answerHeading: "A few questions to make it fit you",
  answerButton: "Write it again with my answers",
  keptFor: "We keep this draft for 24 hours, in this browser only, so you can take it into your store when you sign up. Only the draft is kept, not what you typed.",
  deleteButton: "Delete this draft now",
  deleted: "Your draft was deleted.",
} as const;

/** The refusals the door can answer with (lib/store-preview-door.ts). */
export const PREVIEW_ERRORS = ["full", "address", "notes", "used", "expired", "automated", "invalid", "forbidden", "failed", "unknown"] as const;

const SIGN_UP = "You can still pick your name below and start your store.";

/** A refusal said in plain words, with a way on. Anything it does not know reads as a failure. */
export function previewRefusalWords(error: string): string {
  switch (error) {
    case "full":
      return `Store drafts are full for now. ${SIGN_UP}`;
    case "address":
      return `You have made today's store drafts from this connection. ${SIGN_UP}`;
    case "notes":
      return "Add a sentence about what you make and who it is for, then try again.";
    case "used":
      return `This draft has had its round of answers. ${SIGN_UP}`;
    case "expired":
      return "This draft is no longer open. Write a new one, or pick your name below.";
    case "automated":
    case "forbidden":
      return "This request could not be accepted from here. Reload the page and try again.";
    case "invalid":
      return "What you typed could not be read. Shorten it and try again.";
    default:
      return `The draft could not be written this time. Try again, or ${SIGN_UP.charAt(0).toLowerCase()}${SIGN_UP.slice(1)}`;
  }
}
