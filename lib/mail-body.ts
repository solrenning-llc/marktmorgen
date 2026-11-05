/**
 * The body of a creator's email: what they write, and how it is drawn
 * (moved out of lib/mail.ts on 13 October 2026, when the designer came).
 *
 * An email stays text the creator can read and edit, and every way of making
 * one — the box, the designer, the writing help, a template — writes the same
 * text. Each paragraph (lines with a blank line between) is one block:
 *
 *   # A heading                       a heading
 *   [Get the guide](https://…)        a button, on a line of its own
 *   ---                               a line across
 *   ![what it shows](https://…)       a picture kept for the email (lib/mail-picture-rules.ts)
 *   - a point                         a list, one point a line
 *   anything else                     a paragraph; web addresses in it become links
 *
 * A button leads only to an https address, as a link in a paragraph does,
 * and carries the email's tag the same way (lib/mail-links.ts). Nothing here
 * reports an open: there is no pixel, and a button is a link.
 *
 * Templates (MAIL_TEMPLATES) lay out blocks with the parts to write marked
 * ⟦like this⟧. An email still holding one is never sent or saved to go out
 * (hasPlaceholder): a template's words are directions, never words sent in
 * the creator's name.
 *
 * Pure and browser-safe: the designer draws its preview with the same
 * function that draws the email.
 */
import { MAX_MAIL_PICTURES, readPicture, withoutPictures } from "@/lib/mail-picture-rules";
import { contrast, lookColours } from "@/lib/store-look";

export const MAX_MAIL_HEADING = 120;
export const MAX_MAIL_BUTTON = 60;

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const URL_PATTERN = /(https:\/\/[^\s<>"')\]]+)/g;
const BULLET = /^[-•]\s+/;
/** The full stop or comma that ends a sentence, which the pattern above takes for part of the address. */
const TRAILING = /[.,;:!?]+$/;
const HEADING = /^#\s+(.+)$/;
const BUTTON = /^\[([^\]\n]{1,60})\]\((https:\/\/[^\s<>"')]+)\)$/;
const DIVIDER = /^-{3,}$/;
const PLACEHOLDER = /⟦[^⟧\n]*⟧/;

/** Whether an email still holds a part of a template left to write. */
export function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

/**
 * `goesTo` is where a link leads when that is not the address as written:
 * the same address with the email's tag on it (lib/mail-links.ts). The reader
 * always sees what the creator typed.
 */
function linked(text: string, goesTo?: (href: string) => string): string {
  return text
    .split(URL_PATTERN)
    .map((part, i) => {
      if (i % 2 === 0) return escape(part).replace(/\n/g, "<br>");
      // "…at https://example.com/plan." — the full stop belongs to the sentence.
      const tail = part.match(TRAILING)?.[0] ?? "";
      const href = tail ? part.slice(0, -tail.length) : part;
      return `<a href="${escape(goesTo ? goesTo(href) : href)}" style="color:#4c1d95;text-decoration:underline">${escape(href)}</a>${escape(tail)}`;
    })
    .join("");
}

/** One block of an email, as the designer edits it. */
export type MailBlock =
  | { kind: "heading"; text: string }
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "button"; label: string; href: string }
  | { kind: "picture"; line: string }
  | { kind: "divider" };

/** An email's text as blocks: one a paragraph, read the way it is drawn. */
export function parseMailBlocks(body: string): MailBlock[] {
  const out: MailBlock[] = [];
  for (const chunk of body.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const block = chunk.trim();
    if (!block) continue;
    const lines = block.split("\n");
    if (lines.length === 1) {
      const line = lines[0].trim();
      const heading = line.match(HEADING);
      if (heading) {
        out.push({ kind: "heading", text: heading[1].trim() });
        continue;
      }
      const button = line.match(BUTTON);
      if (button && button[1].trim()) {
        out.push({ kind: "button", label: button[1].trim(), href: button[2] });
        continue;
      }
      if (DIVIDER.test(line)) {
        out.push({ kind: "divider" });
        continue;
      }
      if (readPicture(line)) {
        out.push({ kind: "picture", line });
        continue;
      }
    }
    if (lines.every((line) => BULLET.test(line.trim()))) {
      out.push({ kind: "list", items: lines.map((line) => line.trim().replace(BULLET, "")) });
      continue;
    }
    out.push({ kind: "text", text: block });
  }
  return out;
}

/** Blocks back to an email's text, a blank line between each; an empty block is left out. */
export function serializeMailBlocks(blocks: MailBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading": {
          const text = block.text.replace(/\s+/g, " ").trim().slice(0, MAX_MAIL_HEADING);
          return text ? `# ${text}` : "";
        }
        case "text":
          return block.text.replace(/\n{2,}/g, "\n").trim();
        case "list":
          return block.items.map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean).map((item) => `- ${item}`).join("\n");
        case "button": {
          const label = block.label.replace(/[[\]\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MAIL_BUTTON);
          const href = block.href.trim();
          if (!label && !href) return "";
          return `[${label || "Open"}](${href})`;
        }
        case "picture":
          return block.line;
        case "divider":
          return "---";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Whether a button's address is one an email may lead to. */
export function buttonHrefOk(href: string): boolean {
  return /^https:\/\/[^\s<>"')]+$/.test(href.trim());
}

/** Keep readable store colors only when their edge is also visible on the white card. */
function buttonColours(accent: string): { fill: string; ink: string } {
  const fill = /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#4c1d95";
  const whiteContrast = contrast(fill, "#ffffff");
  const visibleEdge = whiteContrast >= 3;
  if (visibleEdge && whiteContrast >= 7) return { fill, ink: "#ffffff" };
  if (visibleEdge && contrast(fill, "#1c1917") >= 7) return { fill, ink: "#1c1917" };
  const colors = lookColours({ theme: "light", accent: fill });
  return { fill: colors.accent, ink: colors.onAccent };
}

/**
 * The creator's text as HTML: headings, paragraphs, lists, links, buttons,
 * lines across and the pictures kept for it, nothing else. `accent` is the
 * starting colour of a button, adjusted only when its text cannot reach 7:1.
 */
export function bodyHtml(body: string, goesTo?: (href: string) => string, accent = "#4c1d95"): string {
  const colors = buttonColours(accent);
  const out: string[] = [];
  let pictures = 0;
  for (const block of parseMailBlocks(body)) {
    switch (block.kind) {
      case "heading":
        out.push(`<h2 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:#1c1917">${escape(block.text)}</h2>`);
        break;
      case "button": {
        const href = goesTo ? goesTo(block.href) : block.href;
        out.push(
          `<p style="margin:8px 0 24px"><a href="${escape(href)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${colors.fill};color:${colors.ink};font-weight:700;text-decoration:none">${escape(block.label)}</a></p>`,
        );
        break;
      }
      case "divider":
        out.push(`<hr style="margin:24px 0;border:0;border-top:1px solid #e7e5e4">`);
        break;
      case "picture": {
        const picture = pictures < MAX_MAIL_PICTURES ? readPicture(block.line) : null;
        if (picture) {
          pictures += 1;
          out.push(
            `<p style="margin:0 0 16px"><img src="${escape(picture.url)}" alt="${escape(picture.alt)}" width="512" style="display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:12px"></p>`,
          );
        } else {
          out.push(`<p style="margin:0 0 16px">${linked(block.line, goesTo)}</p>`);
        }
        break;
      }
      case "list":
        out.push(`<ul style="margin:0 0 16px;padding-left:22px">${block.items.map((item) => `<li style="margin:0 0 6px">${linked(item, goesTo)}</li>`).join("")}</ul>`);
        break;
      case "text": {
        // A paragraph that mixes lines and points keeps both, in order.
        let para: string[] = [];
        let list: string[] = [];
        const flush = () => {
          if (para.length) out.push(`<p style="margin:0 0 16px">${linked(para.join("\n"), goesTo)}</p>`);
          if (list.length) out.push(`<ul style="margin:0 0 16px;padding-left:22px">${list.map((l) => `<li style="margin:0 0 6px">${linked(l, goesTo)}</li>`).join("")}</ul>`);
          para = [];
          list = [];
        };
        for (const line of block.text.split("\n")) {
          const picture = pictures < MAX_MAIL_PICTURES ? readPicture(line) : null;
          if (picture) {
            flush();
            pictures += 1;
            out.push(
              `<p style="margin:0 0 16px"><img src="${escape(picture.url)}" alt="${escape(picture.alt)}" width="512" style="display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:12px"></p>`,
            );
            continue;
          }
          if (BULLET.test(line)) {
            if (para.length) flush();
            list.push(line.replace(BULLET, ""));
          } else {
            if (list.length) flush();
            para.push(line);
          }
        }
        flush();
        break;
      }
    }
  }
  return out.join("");
}

/**
 * The email as plain text, for readers whose app shows no pictures or no
 * HTML: a heading as its words, a button as its words and its address, a
 * line across as a dash, a picture as its description.
 */
export function bodyText(body: string): string {
  return withoutPictures(
    parseMailBlocks(body)
      .map((block) => {
        switch (block.kind) {
          case "heading":
            return block.text;
          case "button":
            return `${block.label}: ${block.href}`;
          case "divider":
            return "—";
          case "picture":
            return block.line;
          case "list":
            return block.items.map((item) => `- ${item}`).join("\n");
          case "text":
            return block.text;
        }
      })
      .join("\n\n"),
  );
}

/**
 * Emails to start from. Each is only an order of blocks with what to write
 * marked ⟦like this⟧: no sentence in it is sent until the creator has
 * replaced it (hasPlaceholder), and none of it claims anything.
 */
export const MAIL_TEMPLATES: { id: string; label: string; hint: string; blocks: MailBlock[] }[] = [
  {
    id: "news",
    label: "Newsletter",
    hint: "A heading, a few paragraphs, a picture and a link to read more.",
    blocks: [
      { kind: "heading", text: "⟦What this issue is about⟧" },
      { kind: "text", text: "⟦A first paragraph: what happened, or what you have been thinking about.⟧" },
      { kind: "text", text: "⟦A second paragraph: what it means for the reader.⟧" },
      { kind: "divider" },
      { kind: "text", text: "⟦One more thing worth their time.⟧" },
      { kind: "button", label: "⟦Read more⟧", href: "https://" },
    ],
  },
  {
    id: "launch",
    label: "Something new",
    hint: "What it is, who it is for, what is in it, and one button to its page.",
    blocks: [
      { kind: "heading", text: "⟦The name of what you made⟧" },
      { kind: "text", text: "⟦What it is, in one or two sentences.⟧" },
      { kind: "list", items: ["⟦What is in it⟧", "⟦What else is in it⟧", "⟦Who it is for⟧"] },
      { kind: "button", label: "⟦See it⟧", href: "https://" },
      { kind: "text", text: "⟦A last line: when it is available, and anything that changes then.⟧" },
    ],
  },
  {
    id: "welcome",
    label: "Welcome",
    hint: "For someone who just joined: who you are, what they will get, where to start.",
    blocks: [
      { kind: "heading", text: "⟦Welcome, and what happens now⟧" },
      { kind: "text", text: "⟦Who you are, in a few sentences.⟧" },
      { kind: "text", text: "⟦What they will get from you, and how often.⟧" },
      { kind: "button", label: "⟦Where to start⟧", href: "https://" },
    ],
  },
  {
    id: "spotlight",
    label: "One product",
    hint: "A picture of one product, why you made it, and a button to its page.",
    blocks: [
      { kind: "heading", text: "⟦The product's name⟧" },
      { kind: "text", text: "⟦Why you made it, and the problem it solves.⟧" },
      { kind: "button", label: "⟦See it⟧", href: "https://" },
    ],
  },
  // Seasonal (624 [SZ8](29)): the occasion is the creator's to name, and only
  // what is true is asked for: the real prices, an end date only if the sale
  // has one. Nothing in them hurries the reader (tests/mail-body.test.ts).
  {
    id: "sale",
    label: "A sale (Black Friday, a season's end)",
    hint: "What is on sale, its price before and during the sale, and the day it ends if you set one.",
    blocks: [
      { kind: "heading", text: "⟦What is on sale⟧" },
      { kind: "text", text: "⟦Why there is a sale now: Black Friday, a birthday, the end of a season.⟧" },
      { kind: "list", items: ["⟦A product, its sale price and its usual price⟧", "⟦Another product, its sale price and its usual price⟧"] },
      { kind: "text", text: "⟦The day the sale ends, as set in your store. Leave this out if it has no end.⟧" },
      { kind: "button", label: "⟦See the sale⟧", href: "https://" },
    ],
  },
  {
    id: "year-end",
    label: "End of the year",
    hint: "A thank-you, what you made this year, and what comes next. No sale needed.",
    blocks: [
      { kind: "heading", text: "⟦Thank you for this year⟧" },
      { kind: "text", text: "⟦What you made or learned this year, in a few sentences.⟧" },
      { kind: "list", items: ["⟦Something you are glad you made⟧", "⟦Something readers asked for, and what you did⟧"] },
      { kind: "text", text: "⟦What comes next year, if you know.⟧" },
      { kind: "button", label: "⟦Read more⟧", href: "https://" },
    ],
  },
  {
    id: "back-to-school",
    label: "Back to learning",
    hint: "For a new school year or season: what they can learn with you, and where to start.",
    blocks: [
      { kind: "heading", text: "⟦A new season to learn something⟧" },
      { kind: "text", text: "⟦Who this is for, and what they can learn with you.⟧" },
      { kind: "list", items: ["⟦A course or guide, and what it teaches⟧", "⟦Another one, and what it teaches⟧"] },
      { kind: "button", label: "⟦Where to start⟧", href: "https://" },
    ],
  },
];
