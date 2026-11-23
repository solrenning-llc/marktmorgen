/**
 * #5285 row #3758 (Claude 3's LEVE 6807539747 on #3758, WCAG 2.5.5 Target Size, AAA; AX274): three quiet text
 * buttons of the studio's start page got a 44 px height (min-h-11), but their 44 px width came only from their
 * labels ("Change" 53 px, "Revoke" 50 px, "Restore" 52.5 px, measured on #3758). A shorter or translated label (for
 * example "Edit", 26 px) would fall below it. Each now has min-w-11 too, with its words centred in the extra room,
 * so the floor does not depend on the text, as #3757 already does.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";

/** The class string of a constant (`const quiet = "..."`). */
function constantClass(file: string, name: string): string {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(`const ${name} = "`);
  if (at < 0) throw new Error(`const ${name} not found in ${file}`);
  const start = at + `const ${name} = "`.length;
  return source.slice(start, source.indexOf('"', start));
}

/** The className of the button whose handler is `handler`. */
function buttonClass(file: string, handler: string): string {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(handler);
  if (at < 0) throw new Error(`${handler} not found in ${file}`);
  const open = source.lastIndexOf("<button", at);
  const start = source.indexOf('className="', open) + 'className="'.length;
  return source.slice(start, source.indexOf('"', start));
}

part("Each quiet button is at least 44 by 44 px whatever its label");
const buttons: [string, string][] = [
  ["the licence keys' quiet buttons (Change, Revoke, Restore)", constantClass("components/licence-key-editor.tsx", "quiet")],
  ["the delivery card's text links", constantClass("components/shipping-editor.tsx", "link")],
  ["the sales goal's edit button", buttonClass("components/sales-goal-card.tsx", "onClick={() => setEditing(true)}")],
];
for (const [name, classes] of buttons) {
  const list = classes.split(/\s+/);
  is(`${name}: 44 px tall (min-h-11)`, list.includes("min-h-11"), true);
  is(`RED: ${name}: 44 px wide whatever the label (min-w-11)`, list.includes("min-w-11"), true);
}
done();
