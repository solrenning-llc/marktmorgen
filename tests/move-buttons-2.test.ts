/**
 * Moving a block in the email designer (components/mail-designer.tsx, the
 * "Design" mode of every email and sequence step; AX274 Part A; WCAG 2.2
 * 2.4.3, 4.1.3). The blocks are keyed by their place, so after "Move block 2
 * up" the focus stayed on the button at place 2, which now belongs to the
 * other block; nothing was said; and "up" on the first block and "down" on
 * the last were turned off. Now the focus follows the block to its new place,
 * each move is said in a polite status line, and the end buttons stay
 * focusable (aria-disabled) and say the block is already first or last, as in
 * #3791 and #3792 (lib/move-words.ts, components/said-line.tsx).
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const src = readFileSync("components/mail-designer.tsx", "utf8");
const up = src.slice(src.lastIndexOf("<button", src.indexOf("aria-label={`Move block ${i + 1} up`}")), src.indexOf(">", src.indexOf("aria-label={`Move block ${i + 1} up`}")));
const down = src.slice(src.lastIndexOf("<button", src.indexOf("aria-label={`Move block ${i + 1} down`}")), src.indexOf(">", src.indexOf("aria-label={`Move block ${i + 1} down`}")));

is("each Move button has an id by place and direction", up.includes("id={`${moveIds}-move-${i}-up`}") && down.includes("id={`${moveIds}-move-${i}-down`}"), true);
is("none is turned off at an end", [up, down].some((b) => /(?<![-\w])disabled=\{/.test(b)), false);
is("each is marked unavailable at its end instead", /aria-disabled=\{i === 0 \|\| undefined\}/.test(up) && /aria-disabled=\{i === blocks\.length - 1 \|\| undefined\}/.test(down), true);
is("the focus follows the block to its new place, on the same button", src.includes("requestAnimationFrame(() => document.getElementById(`${moveIds}-move-${to}-${by < 0 ? \"up\" : \"down\"}`)?.focus());"), true);
is("each move is said, with the shared words", src.includes("say(movedWords(name, to, blocks.length));") && src.includes('say(endWords(name, by < 0 ? "first" : "last"));'), true);
is("a polite status line is drawn", src.includes("<SaidLine said={said} />") && /const \[said, say\] = useSaid\(\);/.test(src), true);

done();
