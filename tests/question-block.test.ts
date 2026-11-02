/**
 * The Questions block on every feature page and every page for a kind of
 * creator (534 [FQ1] (i), unit 43; added 2 November 2026,
 * components/topic-page.tsx). Checked: each question is a native summary, so
 * its open or closed state is announced, under the block's own h2 named by
 * aria-labelledby; a plus when closed and a minus when open, both
 * decorative, instead of a plus turning into a cross; no movement at all, so
 * nothing to stop under prefers-reduced-motion; a target at least 44 pixels
 * high; the global focus ring reaches it; and the question, the answer and
 * the icons keep their contrast on white (7:1 for text, 3:1 for the icons).
 * The help center's and the home page's questions had the same plus turning
 * into a cross (the help center's with a 300 ms turn) and get the same plus
 * and minus, with no movement; the home page's summary no longer holds a
 * heading or ARIA over its own state, and hides the old Safari triangle.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const page = readFileSync("components/topic-page.tsx", "utf8");
const block = page.slice(page.indexOf('case "faq":'), page.indexOf('case "ladder":'));
const flat = block.replace(/\s+/g, " ");
const css = readFileSync("app/globals.css", "utf8");

part("Structure");
is("the block's h2 names its section", [flat.includes('<section className="" aria-labelledby={sectionId(block.title)}>'), flat.includes('<h2 id={sectionId(block.title)} className="t-section">{block.title}</h2>')], [true, true]);
is("each question a native summary inside its details, the answer beside it", [/<details key=\{item\.q\} className="group"> .*<summary [^>]*>\s?\{item\.q\}/.test(flat), flat.includes("{item.a}</p> </details>")], [true, true]);
is("no role or aria-expanded laid over the native state", /role=|aria-expanded/.test(block), false);

part("Icons and movement");
is("a plus when closed, a minus when open", [flat.includes('<Icon name="plus" size={18} className="shrink-0 text-violet-deep group-open:hidden" />'), flat.includes('<Icon name="minus" size={18} className="hidden shrink-0 text-violet-deep group-open:block" />')], [true, true]);
is("both decorative: no label, so the icon draws aria-hidden", /<Icon name="(plus|minus)"[^>]*label=/.test(block), false);
is("the icon component hides an unlabeled icon", readFileSync("components/icons.tsx", "utf8").includes("aria-hidden={label ? undefined : true}"), true);
is("no movement", /transition|rotate|animate|duration-/.test(block), false);

part("Target, focus and contrast");
is("at least 44 pixels high", /<summary className="[^"]*\bmin-h-11\b/.test(flat), true);
is("the focus ring drawn inside the box that clips it, over the global offset", [flat.includes("overflow-hidden"), /<summary className="[^"]*focus-visible:\[outline-offset:-3px\]!/.test(flat)], [true, true]);
is("the global focus ring reaches a summary", css.includes(":where(a, button, [role=\"button\"], input, select, textarea, summary):focus-visible"), true);
const hex = (name: string) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) ?? [])[1];
const lum = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (h: string) => (1 + 0.05) / (lum(h) + 0.05);
is("the question (ink) and the answer (ink-soft) at 7:1 or more on white", [ratio(hex("ink")) >= 7, ratio(hex("ink-soft")) >= 7, flat.includes("text-ink-soft")], [true, true, true]);
is("the icons (violet-deep) at 3:1 or more on white", ratio(hex("violet-deep")) >= 3, true);

part("The help center and the home page");
for (const [name, file] of [["help center", "app/help/page.tsx"], ["home page", "components/home-static.tsx"]] as const) {
  const src = readFileSync(file, "utf8");
  const summary = src.slice(src.indexOf("<summary"), src.indexOf("</summary>"));
  is(`${name}: a plus when closed, a minus when open, both decorative, no movement, 44 pixels high, no triangle of its own`, [
    /<Icon name="plus" size=\{16\} className="group-open:hidden" ?\/>/.test(summary),
    /<Icon name="minus" size=\{16\} className="hidden group-open:block" ?\/>/.test(summary),
    /<span aria-hidden="true" className="grid h-8 w-8/.test(summary),
    /rotate|transition|duration-|animate/.test(summary),
    /<summary [^>]*className="[^"]*\bmin-h-11\b/.test(summary),
    summary.includes("[&::-webkit-details-marker]:hidden"),
  ], [true, true, true, false, true, true]);
  is(`${name}: no heading inside the summary, no ARIA over its state`, [/<h[1-6]/.test(summary), /role=|aria-expanded|aria-controls/.test(src.slice(src.indexOf("<details"), src.indexOf("</details>")))], [false, false]);
  const wrap = src.slice(Math.max(0, src.indexOf("<details") - 400), src.indexOf("<details"));
  is(`${name}: the focus ring is not clipped`, !wrap.includes("overflow-hidden") || /<summary className="[^"]*focus-visible:\[outline-offset:-3px\]!/.test(summary), true);
}

done();
