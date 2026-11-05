/**
 * Captions for a lesson's video: the rules.
 *
 * A creator who has the words of a video written down, timed, uploads that
 * file and the player shows a captions button. The file is one of the two
 * kinds every subtitle tool writes: WebVTT (.vtt), which is what a browser
 * reads, or SubRip (.srt), which is WebVTT with commas where the dots go and
 * a number above each caption. Whichever arrives, what is kept is WebVTT,
 * made here, so the video service is never handed a file as it came.
 *
 * Nothing is written for the creator: no speech is listened to. A file that
 * is not captions is refused rather than kept and shown as nothing.
 *
 * Nothing here touches the network; the studio's browser reads the same
 * rules the server holds a file to (lib/stream.ts).
 */

/** The most one captions file may weigh. Ten hours of speech, timed, is well under this. */
export const MAX_CAPTION_BYTES = 1_000_000;
/** The most languages one video carries. */
export const MAX_CAPTION_TRACKS = 12;

/**
 * The languages captions can be in: the code a browser knows the language
 * by, and its name as its own speakers write it, which is what a student
 * reads on the player's captions button.
 */
export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "sv", label: "Svenska" },
  { code: "da", label: "Dansk" },
  { code: "no", label: "Norsk" },
  { code: "fi", label: "Suomi" },
  { code: "cs", label: "Čeština" },
  { code: "ro", label: "Română" },
  { code: "hu", label: "Magyar" },
  { code: "el", label: "Ελληνικά" },
  { code: "tr", label: "Türkçe" },
  { code: "uk", label: "Українська" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "he", label: "עברית" },
  { code: "hi", label: "हिन्दी" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "th", label: "ไทย" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "zh", label: "中文" },
];

/** The name of a language captions can be in; null for any other code. */
export function captionLabel(code: unknown): string | null {
  return CAPTION_LANGUAGES.find((language) => language.code === code)?.label ?? null;
}

export type CaptionTrack = { lang: string; label: string };

export type CaptionProblem = "empty" | "too_big" | "format";

/** A time as either kind of file writes it: 01:02:03.456, 02:03.456, or with a comma. */
const TIME = String.raw`(?:\d{1,3}:)?[0-5]?\d:[0-5]\d[.,]\d{1,3}`;
const TIMING = new RegExp(String.raw`^(${TIME})[ \t]+-->[ \t]+(${TIME})(?:[ \t]+(.*))?$`);
/** Where a caption sits on the picture: the only settings kept from a timing line. */
const SETTING = /^(?:line|position|size|align|vertical):[A-Za-z0-9%,.:-]{1,20}$/;

function seconds(time: string): number {
  const parts = time.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** A time the way WebVTT wants it: hours always there, a dot, three digits. */
function stamp(time: string): string {
  const [whole, fraction = ""] = time.replace(",", ".").split(".");
  const parts = whole.split(":");
  while (parts.length < 3) parts.unshift("00");
  return `${parts.map((part) => part.padStart(2, "0")).join(":")}.${fraction.padEnd(3, "0").slice(0, 3)}`;
}

/**
 * The words of one caption, with nothing in them a player could take for
 * anything but words: bold, italic and underline are kept, every other tag
 * is taken out, and what is left of an angle bracket is written as text.
 */
function words(line: string): string {
  return line
    // A time inside the words, which lights them up one by one as they are sung.
    .replace(/<\d[\d:.]*>/g, "")
    .replace(/<\/?([a-zA-Z][^>]*)>/g, (tag, name: string) => (/^[biu]$/i.test(name.trim()) ? tag.toLowerCase().replace(/\s+/g, "") : ""))
    .replace(/<(?!\/?[biu]>)/g, "&lt;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/**
 * A captions file, as WebVTT, or why it is not one.
 *
 * Read block by block, a block being the lines between two empty ones. A
 * block with a timing line is a caption: its times, where it sits, and its
 * words. Recognized metadata — the header, a note, a style sheet, a region —
 * is left out, so the file kept holds captions and nothing else. Any other
 * untimed block is refused, never silently lost from a partial file. A timing
 * line that cannot be read, or that ends before it starts, refuses the
 * whole file: half a file of captions is worse than a clear no.
 */
export function toVtt(input: unknown): { ok: true; vtt: string; cues: number } | { ok: false; reason: CaptionProblem } {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  if (new TextEncoder().encode(input).length > MAX_CAPTION_BYTES) return { ok: false, reason: "too_big" };
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, reason: "empty" };

  const out: string[] = [];
  for (const [index, block] of text.split(/\n{2,}/).entries()) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) {
      const first = lines[0].replace(/[ \t]+$/, "");
      const header = index === 0 && lines.length === 1 && /^WEBVTT(?:[ \t]|$)/.test(first);
      const metadata = /^NOTE(?:[ \t]|$)/.test(first) || first === "STYLE" || first === "REGION";
      if (header || metadata) continue;
      return { ok: false, reason: "format" };
    }
    // Above the timing line there is at most a number, or a name for the caption.
    if (at > 1) return { ok: false, reason: "format" };
    const timing = TIMING.exec(lines[at].trim());
    if (!timing) return { ok: false, reason: "format" };
    const [, from, to, rest = ""] = timing;
    if (!(seconds(to) > seconds(from))) return { ok: false, reason: "format" };
    if (lines.slice(at + 1).some((line) => line.includes("-->"))) return { ok: false, reason: "format" };
    const said = lines
      .slice(at + 1)
      .map(words)
      .filter((line) => line.trim() !== "");
    // A caption with no words is a pause somebody timed: nothing to show.
    if (!said.length) continue;
    const settings = rest.split(/[ \t]+/).filter((setting) => SETTING.test(setting));
    out.push(`${stamp(from)} --> ${stamp(to)}${settings.length ? ` ${settings.join(" ")}` : ""}\n${said.join("\n")}`);
  }
  if (!out.length) return { ok: false, reason: "format" };
  return { ok: true, vtt: `WEBVTT\n\n${out.join("\n\n")}\n`, cues: out.length };
}
