/**
 * AX274, WCAG 1.4.10 Reflow: at 320 px a field keeps a width a person can type
 * in. Chromium on 13 November 2026, /studio/memberships at 320 px: "The member's
 * email" was 31 px wide. Its label had flex-1 with min-w-0 and no basis, so in the
 * wrapping row the "Find their memberships" button stayed beside it and the field
 * shrank to nothing instead of the button moving to the next line.
 *
 * What must hold: the label has a basis (basis-56, 14rem), so on a narrow screen
 * the button wraps under the field and the field takes the row's width; on a wide
 * screen both still sit on one line.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const source = readFileSync("components/member-discount.tsx", "utf8");
const at = source.indexOf('htmlFor={`${id}-email`}');
const label = source.slice(source.lastIndexOf("<label", at), at);
const classes = (label.match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/);

part("The member's email field wraps instead of shrinking");
is("the label is found", label.length > 0, true);
is("it grows and may shrink in the row", classes.includes("flex-1") && classes.includes("min-w-0"), true);
is("it has a basis, so the button wraps under it on a narrow screen", classes.includes("basis-56"), true);

done();
