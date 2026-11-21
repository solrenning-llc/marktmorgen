/**
 * A creator can remove an offer with the same 44px minimum target used by the
 * other studio controls (310 [AX2], 274 [AX1]).
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

const editor = readFileSync("components/funnel-editor.tsx", "utf8");
const remove = editor.match(/<button[\s\S]{0,500}?onClick=\{\(\) => remove\(index\)\}[\s\S]{0,500}?aria-label=\{\`Remove offer \$\{index \+ 1\}\`\}[\s\S]{0,100}?>/)?.[0] ?? "";

part("Removing a funnel offer stays reachable by touch");
is("the real remove control is found by its handler and accessible name", remove.length > 0, true);
is("the remove control keeps its distinct offer number", remove.includes("Remove offer ${index + 1}"), true);
is("the remove control has a 44px square target", remove.includes("h-11 w-11"), true);
is("the remove control still calls the existing row removal", remove.includes("onClick={() => remove(index)}"), true);
done();
