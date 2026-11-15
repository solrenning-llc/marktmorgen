/**
 * The store address field, "marktmorgen.com/@ yourname", on a phone (issue #4312, creator funnel, Claude 1, 12/11/2026).
 * Found by walking main as a new creator at 390 px: the first field of the store showed
 * "marktmorge" on one line and "n.com/@" on the next, inside a squeezed box, because the prefix was a
 * flex item allowed to shrink to nothing while the field took the full width. Now the prefix keeps its
 * width, breaks after "marktmorgen.com/" when it must, and the field goes beside it when there is room or
 * under it when there is not. Measured in a browser on the same walk: 390 px one line; 320 px the prefix
 * whole with the field under it; 195 px (a 390 px phone at 200%) no horizontal scroll.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

for (const file of ["components/handle-form.tsx", "components/rename-form.tsx"]) {
  part(file);
  const source = readFileSync(file, "utf8");
  const box = source.slice(source.indexOf("data-address-field") - 200, source.indexOf("</div>", source.indexOf("data-address-field")));
  is("the box wraps instead of squeezing", /className="card[^"]*\bflex flex-wrap items-center\b[^"]*" data-address-field/.test(box), true);
  is("the prefix keeps its width and breaks after the slash first", /<span className="max-w-full shrink-0 [^"]*">marktmorgen\.com\/<wbr \/>@<\/span>/.test(box), true);
  const field = box.match(/<input[\s\S]*?className="([^"]*)"/)?.[1] ?? "";
  is("the field shares the line, or takes the next one, and never forces a scroll", [/^min-w-0 flex-\[1_1_6rem\] /.test(field), /\bw-full\b/.test(field)], [true, false]);
}

done();
