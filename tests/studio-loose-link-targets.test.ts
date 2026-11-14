/**
 * AX274, WCAG 2.5.5 Target Size (Enhanced), AAA: a link that stands on its own
 * line, not inside a sentence, is at least 44 x 44 CSS px. Chromium on
 * 13 November 2026, at 320 and 1280 px: /studio/path's "How Path works" was
 * 126 x 27 px, and /studio/import's "Download an example file" 150 x 16 px. The
 * inline-link exception does not cover them: each is a link of its own, under a
 * trail or under a file picker.
 *
 * What must hold: each is an inline-flex box at least 44 px tall (min-h-11),
 * with its words, look and address unchanged.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const classOf = (source: string, before: string) => {
  const at = source.indexOf(before);
  const open = source.lastIndexOf("<", at);
  return at < 0 ? [] : (source.slice(open, at).match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/);
};

part("Loose links are 44 px targets");
for (const [file, words] of [
  ["app/studio/path/page.tsx", ">How Path works</Link>"],
  ["components/import-tool.tsx", "Download an example file"],
] as const) {
  const c = classOf(readFileSync(file, "utf8"), words);
  is(`${file}: "${words.replace(/<[^>]*>|>/g, "")}" is found`, c.length > 1, true);
  is(`${file}: it is at least 44 px tall`, c.includes("min-h-11") && c.includes("inline-flex") && c.includes("items-center"), true);
  is(`${file}: it keeps its underline`, c.includes("underline"), true);
}

done();
