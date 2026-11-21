/**
 * "Pages in order", the studio's page funnels (components/page-funnel-editor.tsx;
 * AX274 Part A; WCAG 2.2 2.4.3 Focus Order). Seen in Chromium on 11 November
 * 2026, /studio/funnels, keyboard only: "New funnel" and a funnel's "Edit"
 * opened the form and were turned off or taken away under the focus, which
 * fell to the page's body; "Remove" gave way to "Remove it?" and the focus
 * fell there too, and so it did on "Keep it", on Cancel and after a save.
 *
 * Now the focus follows: into the form's first field when it opens; back to
 * the button that opened it when it closes (else New funnel, else the
 * section's heading); onto "Keep it", inside a group named by the question,
 * when Remove asks; back to Remove on Keep it; to New funnel, else the
 * heading, once a funnel is removed. Checked against the source here; where
 * the focus lands in a browser is in the pull request.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const src = readFileSync("components/page-funnel-editor.tsx", "utf8");
const button = (words: string) => {
  const at = src.indexOf(words);
  return at < 0 ? "" : src.slice(src.lastIndexOf("<button", at), at);
};

is("New funnel has an id and says it is where the focus comes back", /id="pf-new"/.test(button("New funnel\n")) && /returnTo\.current = "pf-new";/.test(button("New funnel\n")), true);
is("each Edit has an id and says it is where the focus comes back", /id=\{`pf-edit-\$\{funnel\.id\}`\}/.test(button("Edit\n")) && /returnTo\.current = `pf-edit-\$\{funnel\.id\}`;/.test(button("Edit\n")), true);
is("each Remove has an id", /id=\{`pf-remove-\$\{funnel\.id\}`\}/.test(button("Remove\n                    </button>")), true);
is("the question is a group named by its words", /role="group" aria-labelledby=\{`pf-remove-q-\$\{funnel\.id\}`\}/.test(src) && /<span id=\{`pf-remove-q-\$\{funnel\.id\}`\}>Remove it\?<\/span>/.test(src), true);
is("Keep it has an id and marks that the focus goes back to Remove", /id=\{`pf-keep-\$\{funnel\.id\}`\}/.test(button("Keep it\n")) && /keptRemove\.current = funnel\.id;/.test(button("Keep it\n")), true);
is("the section's heading can take the focus, the last place to go", /<h2 id="page-funnels-title" tabIndex=\{-1\}/.test(src), true);

const form = /useEffect\(\(\) => \{\s*if \(formOpen === wasOpen\.current\) return;\s*wasOpen\.current = formOpen;\s*if \(formOpen\) \{\s*document\.getElementById\("pf-name"\)\?\.focus\(\);\s*return;\s*\}\s*const back = returnTo\.current;\s*returnTo\.current = null;\s*focusFirst\(\[back, "pf-new", "page-funnels-title"\]\);\s*\}, \[formOpen\]\);/;
is("the form: its first field when it opens, back where it was opened from when it closes", form.test(src), true);
const ask = /useEffect\(\(\) => \{\s*const was = wasRemoving\.current;\s*wasRemoving\.current = removing;\s*if \(was === removing\) return;\s*if \(removing !== null\) \{\s*document\.getElementById\(`pf-keep-\$\{removing\}`\)\?\.focus\(\);\s*return;\s*\}\s*if \(was === null\) return;\s*if \(keptRemove\.current === was\) \{\s*keptRemove\.current = null;\s*document\.getElementById\(`pf-remove-\$\{was\}`\)\?\.focus\(\);\s*return;\s*\}\s*focusFirst\(\["pf-new", "page-funnels-title"\]\);\s*\}, \[removing\]\);/;
is("the question: Keep it when it asks, Remove on Keep it, New funnel or the heading once removed", ask.test(src), true);
is("focusFirst skips what is missing or turned off", /function focusFirst\(ids: \(string \| null\)\[\]\) \{[\s\S]*?if \(element && !\(element as HTMLButtonElement\)\.disabled\)/.test(src), true);

done();
