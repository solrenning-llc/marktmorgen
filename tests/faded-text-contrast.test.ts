/**
 * Text is never faded below 7:1 (WCAG 1.4.6, AAA; AGENTS.md AX274 Part A
 * item 4), in two places where a fade had been put on the text itself:
 *
 *   - a hidden comment under a lesson (components/lesson-comments.tsx) was
 *     drawn at 60% opacity, its name, time and words included. On the
 *     store's ink that is about 4.8:1, so the creator moderating it, and the
 *     student who wrote it, read the comment through a fade. The "Hidden"
 *     badge beside the name already says it is hidden, in words, so only
 *     the decorative initial is faded now;
 *   - the store address field (components/handle-form.tsx), the first field
 *     a new creator meets, drew its "yourname" hint in --ink-soft at 60%:
 *     about 3.5:1 on white. It now uses --ink-mute, the color every other
 *     field's hint uses (.field::placeholder), 9.4:1.
 *
 * Both are rendered with the real components; the colors are read from
 * app/globals.css and the ratios computed with the WCAG formula. Not checked
 * here: creator-chosen store colors (the store's own theme check covers
 * them) and a real browser's rendering of the placeholder.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { LessonComments } from "@/components/lesson-comments";
import { HandleForm } from "@/components/handle-form";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { done, is, part } from "./check";

const css = readFileSync("app/globals.css", "utf8");
const token = (name: string) => {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!value) throw new Error(`no color token ${name}`);
  return value;
};
const luminance = (hex: string) => {
  const [r, g, b] = (hex.slice(1).match(/../g) ?? []).map((v) => parseInt(v, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const classesOf = (html: string, marker: string) => html.match(new RegExp(`<[a-z]+[^>]*${marker}[^>]*class="([^"]*)"|<[a-z]+[^>]*class="([^"]*)"[^>]*${marker}`))?.slice(1).find(Boolean)?.split(/\s+/) ?? null;

part("A hidden comment under a lesson");
{
  const comment = (id: string, hidden: boolean) => ({
    comment: { id, lesson: "intro", by: "student-key", name: "Dana", text: `Words of ${id}`, at: 1_800_000_000, parent: null, hidden },
    replies: [],
  });
  const html = renderToStaticMarkup(createElement(LessonComments, {
    threads: [comment("hiddenone001", true), comment("shownone0001", false)],
    reader: CREATOR_AUTHOR,
    storeName: "Maple",
    hidden: { handle: "maple", product: "course", lesson: "intro" },
    myName: "",
    notice: "",
    now: 1_800_000_100,
  }));
  is("the hidden comment is still shown to the creator, with its words", html.includes("Words of hiddenone001"), true);
  is("and with the Hidden badge in words", /cm-badge-warn[^>]*>[^<]+</.test(html), true);
  const hidden = classesOf(html, 'id="c-hiddenone001"');
  is("the hidden comment's own box is found", Array.isArray(hidden), true);
  is("its text is not faded (no opacity on the comment)", (hidden ?? []).filter((c) => c.startsWith("opacity-")), []);
  const faces = [...html.matchAll(/<span aria-hidden="true" class="([^"]*cm-face[^"]*)"/g)].map((m) => m[1].split(/\s+/));
  is("only the decorative initial of the hidden comment is faded", faces.map((f) => f.includes("opacity-60")), [true, false]);
}

part("The store address field's hint");
{
  const html = renderToStaticMarkup(createElement(HandleForm, {}));
  const field = classesOf(html, 'placeholder="yourname"');
  is("the field is found", Array.isArray(field), true);
  const hint = (field ?? []).filter((c) => c.startsWith("placeholder:text-"));
  is("the hint has one color, with no opacity on it", hint, ["placeholder:text-ink-mute"]);
  const ratio = contrast(token("ink-mute"), "#ffffff");
  is(`--ink-mute on white is at least 7:1 (${ratio.toFixed(2)})`, ratio >= 7, true);
  const before = contrast("#858b92", "#ffffff");
  is(`the old hint, --ink-soft at 60% on white, was under 4.5:1 (${before.toFixed(2)})`, before < 4.5, true);
  is("--ink-soft at 60% over white is that gray", ((parseInt(token("ink-soft").slice(1, 3), 16) * 0.6 + 255 * 0.4) | 0).toString(16), "85");
}

done();
