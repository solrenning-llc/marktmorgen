/**
 * A creator's own note after paying (added 10 October 2026): a few words, a
 * video and one button, on the thank-you page under what was bought and in
 * the confirmation email, so a buyer is told what to do first — watch the
 * welcome, join the group, book the onboarding call — by the person they
 * just paid. The rules, which the browser can read too; it is kept by
 * lib/thanks-note-store.ts.
 *
 * Plain text as everywhere here (lib/product-about.ts): a blank line is a new
 * paragraph, "- " a point, an https address a link, and no markup is read.
 * The video is one from YouTube, Vimeo or Loom, loaded only when pressed
 * (components/video-embed.tsx). The button goes to an https page, opens in a
 * new tab, and says where it goes.
 */
import { type Video, parseVideo, readVideo } from "@/lib/sales-page";
import { readLink } from "@/lib/product-link";

export const MAX_NOTE_HEADING = 100;
export const MAX_NOTE_BODY = 2_000;
export const MAX_NOTE_LABEL = 40;

/**
 * What the studio's page editor says where a product's note could not be read
 * (lib/thanks-note-store.ts readThanksNote threw): no note editor is shown, so
 * nothing typed can be saved over the note that is kept (app/studio/pages).
 */
export const NOTE_UNREAD = "Your note after paying could not be read just now, so it is not shown and nothing was changed. Reload, then try again.";

export type ThanksNote = {
  /** Empty is "A note from <store>", in the store's language. */
  heading: string;
  body: string;
  video: Video | null;
  button: { label: string; url: string } | null;
};

/** One line: control characters and runs of space made one space. */
function line(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** Paragraphs as typed, tidied. */
function text(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .split("\n")
    .map((part) => part.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** Whether a note says anything at all. */
export function hasNote(note: ThanksNote | null): note is ThanksNote {
  return note !== null && (note.body !== "" || note.video !== null || note.button !== null);
}

/** A note as stored, made safe to use; null when it says nothing. */
export function parseNote(raw: unknown): ThanksNote | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const button = value.button && typeof value.button === "object" ? (value.button as Record<string, unknown>) : null;
  const url = button && typeof button.url === "string" ? readLink(button.url) : null;
  const label = button ? line(button.label, MAX_NOTE_LABEL) : "";
  const note: ThanksNote = {
    heading: line(value.heading, MAX_NOTE_HEADING),
    body: text(value.body, MAX_NOTE_BODY),
    video: parseVideo(value.video),
    button: url?.ok && label ? { label, url: url.url } : null,
  };
  return hasNote(note) ? note : null;
}

export type NoteProblem = "video" | "link" | "label" | "empty";

/**
 * A note as the studio sends it — the video and the link as typed — read, or
 * which part is wrong, so a creator is never told "saved" about a note saved
 * differently.
 */
export function readNote(raw: unknown): ThanksNote | NoteProblem {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const typedVideo = typeof value.video === "string" ? value.video.trim() : "";
  const video = typedVideo ? readVideo(typedVideo) : null;
  if (typedVideo && !video) return "video";
  const label = line(value.label, MAX_NOTE_LABEL);
  const typedUrl = typeof value.url === "string" ? value.url.trim() : "";
  if (typedUrl && !label) return "label";
  if (label && !typedUrl) return "link";
  const url = typedUrl ? readLink(typedUrl) : null;
  if (url && !url.ok) return "link";
  const note: ThanksNote = {
    heading: line(value.heading, MAX_NOTE_HEADING),
    body: text(value.body, MAX_NOTE_BODY),
    video,
    button: url?.ok ? { label, url: url.url } : null,
  };
  return hasNote(note) ? note : "empty";
}
