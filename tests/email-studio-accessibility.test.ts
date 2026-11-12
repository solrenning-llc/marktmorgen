/**
 * The studio's email page (/studio/email) and the list email it makes, held to
 * the owner's AAA rule (AX274) where the browser audit of every state found a
 * gap: each finding has a check here, so it cannot come back.
 *
 * - 2.5.5 Target Size (Enhanced): every control the audit measured under
 *   44 × 44 CSS px at 320, 390 and 1280 px gets the 44px minimum.
 * - 1.3.1 / 2.4.10: the cards' titles are headings, not bold paragraphs.
 * - 2.3.3 Animation from Interactions: no smooth scroll that ignores
 *   prefers-reduced-motion.
 * - 3.3.6 Error Prevention (All): removing a sequence asks first.
 * - 2.2.5 Re-authenticating: a session that ends while writing says how to
 *   log in again without leaving the page, so nothing written is lost.
 * - The email's HTML carries a title (its subject) and its character set.
 */
import { readFileSync } from "node:fs";
import { render } from "@/lib/mail";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const studio = readFileSync("components/email-studio.tsx", "utf8");
const page = readFileSync("app/studio/email/page.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");
const sequenceImport = readFileSync("components/sequence-import-box.tsx", "utf8");
const workflowTools = readFileSync("components/workflow-tools.tsx", "utf8");

/** From the nearest `<tag` before the place `text` matches, up to just after it: the first className in it is that element's. */
function openingBefore(source: string, text: RegExp, tag: string): string {
  const at = source.search(text);
  if (at < 0) return "";
  const start = source.lastIndexOf(`<${tag}`, at);
  return start < 0 ? "" : source.slice(start, at + 200);
}
const classes = (tag: string) => (tag.match(/className="([^"]*)"/)?.[1] ?? "").split(/\s+/);
const tall = (tag: string) => classes(tag).some((c) => c === "min-h-11" || c === "h-11");
const wide = (tag: string) => classes(tag).some((c) => c === "min-w-11" || c === "w-11");

async function main(): Promise<void> {
  part("2.5.5: controls the audit measured under 44 × 44 px");
  const controls: [string, RegExp, string][] = [
    ["Import addresses (the list's import opener)", />Import addresses</, "summary"],
    ["the import's file picker", /accept="\.csv,\.txt,text\/csv,text\/plain"/, "input"],
    ["the import's agreement box", /These people agreed to get emails from me/, "label"],
    ["Try a second subject line", /\/>\s*Try a second subject line/, "label"],
    ["the Now choice", /\/> Now\s*</, "label"],
    ["the At a time I choose choice", /\/> At a time I choose/, "label"],
    ["Not yet, under the review", />\s*Not yet\s*</, "button"],
    ["Start a new one instead", />\s*Start a new one instead\s*</, "button"],
    ["Close, under a sequence being edited", />\s*Close\s*<\/button>/, "button"],
    ["Pause, on a sequence", />\s*Pause\s*</, "button"],
    ["Preview and switch on, on a sequence", />\s*Preview and switch on\s*</, "button"],
    ["Runs, on a sequence", /"Hide runs" : "Runs"/, "button"],
    ["Remove this email or step", /"Remove this email" : "Remove this step"/, "button"],
    ["the sequence's On box", /<span>On\. Switched off, nobody new starts it/, "label"],
    ["More ways to choose (the audience's opener)", />More ways to choose: what they spent/, "summary"],
    ["Map of its steps", />Map of its steps</, "summary"],
  ];
  for (const [name, text, tag] of controls) is(`${name} is at least 44px tall`, tall(openingBefore(studio, text, tag)), true);
  is("Open, on a draft, is at least 44px wide", wide(openingBefore(studio, /"Open above" : "Open"/, "button")), true);
  is("Edit, on a sequence, is at least 44px wide", wide(openingBefore(studio, />\s*Edit\s*<\/button>/, "button")), true);
  is("Runs, on a sequence, is at least 44px wide", wide(openingBefore(studio, /"Hide runs" : "Runs"/, "button")), true);
  is("Close, under a sequence being edited, is at least 44px wide (39px measured)", wide(openingBefore(studio, />\s*Close\s*<\/button>/, "button")), true);
  // `.input` is not a class of this site, so the history's search and status filter were bare 20px controls.
  is("the site has no .input class", /(^|\n)\s*\.input\s*[{,:]/.test(css), false);
  is("the history's search and status use the site's 48px field", [/id="history-search"[^>]*className="field\b/.test(studio), /id="history-status"[^>]*className="field\b/.test(studio)], [true, true]);

  part("1.4.10 / 2.5.5: the sequence's file picker and the path preview's address fit 320 px");
  const sequenceFile = classes(openingBefore(sequenceImport, /accept="\.csv,text\/csv"/, "input"));
  is("the sequence's file picker is as wide as its box at most, and 44px tall", [sequenceFile.includes("w-full"), sequenceFile.includes("min-h-11")], [true, true]);
  const lookup = classes(openingBefore(workflowTools, /<span className="text-sm text-ink-soft">Or start from someone on your list/, "label"));
  is("the path preview's address keeps a 14rem basis, so its button wraps below it instead of squeezing it to 31px", [lookup.includes("basis-56"), lookup.includes("flex-1")], [true, false]);

  // A fieldset is as wide as its widest content by default; with text spacing (1.4.12) the date field's own width pushed the page 22px past 320.
  is("the When choices' fieldset can shrink to a 320px screen", /<fieldset className="[^"]*\bmin-w-0\b[^"]*">\s*<legend className="field-label">When<\/legend>/.test(studio), true);

  part("2.4.13: a date and time field keeps its focus bands while the focus is inside it");
  // On the calendar button the field matches neither :focus-visible nor :focus in Chromium, only :focus-within (measured).
  is("date and time fields show the bands on :focus-within, which still matches while the calendar button has the focus", /\.field:is\(\[type="date"\], \[type="time"\], \[type="datetime-local"\]\):focus-within\s*\{[^}]*outline: 3px solid var\(--violet-deep\)/.test(css), true);

  part("1.3.1 / 2.4.10: each card's title is a heading");
  for (const title of ["First, how your emails are signed", "Not set up yet", "This month", "How your emails are signed", "Your list"]) {
    is(`"${title}" is an h2`, new RegExp(`<h2 className="[^"]*">${title}</h2>`).test(studio), true);
  }
  is(`"Part of Pro" is an h2`, /<h2 className="[^"]*">Part of Pro<\/h2>/.test(page), true);

  part("2.3.3: opening a draft or writing an email again scrolls without motion when motion is reduced");
  is("no smooth scroll that ignores prefers-reduced-motion", /scrollIntoView\(\{ behavior: "smooth"/.test(studio), false);
  is("the scroll reads prefers-reduced-motion", /prefers-reduced-motion: reduce/.test(studio), true);

  part("3.3.6: removing a sequence asks first, as deleting a draft does");
  const removal = studio.slice(studio.lastIndexOf("onClick={async () => {", studio.indexOf('action: "flow-remove"')), studio.indexOf('action: "flow-remove"'));
  is("the removal asks before it calls the server", /window\.confirm\(/.test(removal), true);

  // Codex P's source contracts (tests/e2e/p-email-studio-accessibility.mjs --source-red, review on #2984), kept verbatim, with the
  // elements they name checked to exist so a stray string cannot satisfy them.
  part("2.4.3 / 3.2.1: focus follows what the creator opened and comes back when it closes");
  is("opening a saved email moves focus to its subject", /switchTo[\s\S]{0,1800}mail-subject[\s\S]{0,300}\.focus\(/.test(studio), true);
  is("opening a sequence moves focus to its name", /flow-name[\s\S]{0,1800}\.focus\(/.test(studio), true);
  is("closing a sequence returns focus to its opener", /flow-(?:new|edit)-[\s\S]{0,2200}\.focus\(/.test(studio), true);
  is("the subject field is the one with that id", /<input id="mail-subject" ref=\{subjectBox\}/.test(studio), true);
  is("the sequence's name field carries the id that is focused", /<input id="flow-name" className="field mt-2"/.test(studio), true);
  is("New sequence and Edit carry the ids focus goes back to", [/<button type="button" id="flow-new-sequence"[^\n]*\n\s*New sequence\s*<\/button>/.test(studio), /id=\{`flow-edit-\$\{f\.id\}`\}\s*onClick=\{\(\) => \{\s*openDraft\(f\);\s*\}\}\s*>\s*Edit\s*<\/button>/.test(studio)], [true, true]);
  is("2.3.3: the subject's focus keeps the reduced-motion scroll to the composer instead of jumping", /getElementById\("mail-subject"\)\?\.focus\(\{ preventScroll: true \}\)/.test(studio), true);

  part("2.2.5: a session that ends while writing loses nothing after logging in again");
  const signedOut = studio.match(/signed_out: "([^"]*)"/)?.[1] ?? "";
  is("the message says the email stays on the page and to log in again in a new tab", [/stays on this page/.test(signedOut), /new tab/.test(signedOut)], [true, true]);
  const feedback = studio.slice(studio.indexOf("function Feedback("), studio.indexOf("\n}\n", studio.indexOf("function Feedback(")));
  is("beside it, a link to log in that opens a new tab and says so", [/href="\/signin"/.test(feedback), /target="_blank"/.test(feedback), /<NewTab \/>/.test(feedback)], [true, true, true]);

  part("The list email's HTML: a title and a character set");
  redis.clear();
  globalThis.fetch = (async () => { throw new Error("No provider request expected"); }) as typeof fetch;
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  const store = (await storeForEmail("owner@example.com"))!;
  const made = render(store, "Bread & <butter> class", "Hello,\n\nIt is open.", "tok_synthetic");
  is("the title is the subject, escaped", made.html.includes("<title>Bread &amp; &lt;butter&gt; class</title>"), true);
  is("the character set is said", made.html.includes('<meta charset="utf-8">'), true);
  is("the language is still on the html element", /<html lang="en-US">/.test(made.html), true);
  is("and a text version still goes with it", made.text.startsWith("Hello,\n\nIt is open."), true);
  done();
}

void main();
