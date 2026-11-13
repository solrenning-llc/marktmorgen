/**
 * The store address prefix, "marktmorgen.com/@", never breaks in the middle
 * of a word on a phone (issue #4312; WCAG 1.4.10 Reflow, 1.4.8 Visual
 * Presentation). The studio page sets overflow-wrap: anywhere on <main>, so a
 * prefix that may shrink next to a full-width field was drawn as
 * "marktmorge / n.com/@" at 390 px. What is checked, on the real markup of
 * both forms that show the prefix (the first address and a new address):
 *
 *   - the prefix keeps its words: it opts out of overflow-wrap: anywhere and
 *     its two parts never break inside;
 *   - its only break is after "marktmorgen.com/";
 *   - it never shrinks below its own width, and never grows past the row;
 *   - the row wraps, so the field goes under the prefix when there is no room
 *     beside it, and the field is not set to the row's full width, which
 *     would push it under the prefix on every screen.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import * as handleForm from "@/components/handle-form";
import { done, is } from "./check";

const classesOf = (tag: string): string[] => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);

function check(form: string, html: string) {
  const prefix = /<span[^>]*>(?:<span[^>]*>)?marktmorgen\.com\/[\s\S]*?@<\/span>(?:<\/span>)?/.exec(html)?.[0] ?? "";
  const open = /^<span[^>]*>/.exec(prefix)?.[0] ?? "";
  const prefixClasses = classesOf(open);
  is(`${form}: the prefix opts out of overflow-wrap: anywhere`, prefixClasses.includes("[overflow-wrap:normal]"), true);
  is(`${form}: the prefix never shrinks below its own width`, prefixClasses.includes("shrink-0"), true);
  is(`${form}: the prefix never grows past the row`, prefixClasses.includes("max-w-full"), true);
  is(
    `${form}: the prefix breaks only after "marktmorgen.com/", never inside a word`,
    /<span class="whitespace-nowrap">marktmorgen\.com\/<\/span><wbr\/><span class="whitespace-nowrap">@<\/span>/.test(prefix),
    true,
  );
  const row = /<div class="card[^"]*"[^>]*>(?=\s*<span[^>]*>(?:<span[^>]*>)?marktmorgen\.com)/.exec(html)?.[0] ?? "";
  is(`${form}: the row wraps, so the field goes under the prefix on a narrow screen`, classesOf(row).includes("flex-wrap"), true);
  // Up to the field's class, without stopping at the "=>" of its handler in the source.
  const input = /<input(?:(?!<input)[\s\S])*?id="(?:store|new)-handle"(?:(?!\/>)[\s\S])*?class="[^"]*"/.exec(html)?.[0] ?? "";
  const inputClasses = classesOf(input);
  is(
    `${form}: the field takes the room beside the prefix, not the whole row`,
    inputClasses.includes("flex-1") && !inputClasses.includes("w-full") && inputClasses.some((c) => c.startsWith("basis-")),
    true,
  );
}

check("Your address", renderToStaticMarkup(createElement(handleForm.HandleForm)));

// The rename form opens only on a click, so its open markup is read from the
// source, with the shared prefix drawn in place: the same prefix and the same
// row and field rules.
const shared = (handleForm as { AddressPrefix?: () => ReturnType<typeof createElement> }).AddressPrefix;
const renameMarkup = readFileSync("components/rename-form.tsx", "utf8")
  .replace(/<AddressPrefix \/>/, shared ? renderToStaticMarkup(createElement(shared)) : "")
  .replace(/className="([^"]*)"/g, 'class="$1"')
  .replace(/\n\s*/g, " ");
check("New address", renameMarkup);

done();
