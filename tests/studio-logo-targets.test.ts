/**
 * Board #5285, the "(new)" row Claude 4 Y found on main while fixing #4610 (23/11 09:0x UTC): the studio pages that
 * draw their own header (the new store page, the paused page, and the studio's signed-in fallback header) wrapped the
 * 32 px logo mark in a bare link, so the "Marktmorgen, home" target was 32 px tall, under WCAG 2.5.5's 44 px. Each is
 * now an inline flex box at least 44 px tall and wide (min-h-11 min-w-11), with the mark centered, as
 * components/studio-header.tsx and app/signin/lost/confirm/page.tsx already draw it. Source-level check of the real files.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { done, is, part } from "./check";

const FILES = ["app/studio/new/page.tsx", "app/studio/paused/page.tsx", "app/studio/page.tsx"];

/** Every opening tag of a link labelled "Marktmorgen, home" in `source`, with its className. */
function logoLinks(source: string): string[][] {
  return [...source.matchAll(/<Link\b[^>]*aria-label="Marktmorgen, home"[^>]*>/g)].map((m) => (/className="([^"]*)"/.exec(m[0])?.[1] ?? "").split(/\s+/));
}

for (const file of FILES) {
  part(file);
  const links = logoLinks(readFileSync(join(process.cwd(), file), "utf8"));
  is("the logo link is found", links.length >= 1, true);
  links.forEach((classes, i) => {
    is(`link ${i + 1}: at least 44 px tall and wide (min-h-11, min-w-11)`, ["min-h-11", "min-w-11"].every((c) => classes.includes(c)), true);
    is(`link ${i + 1}: a flex box with the mark centered, so the size holds`, (classes.includes("inline-flex") || classes.includes("flex")) && classes.includes("items-center"), true);
  });
}

done();
