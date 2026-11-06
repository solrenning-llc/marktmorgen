/**
 * A label always visible (487 [IT4], item 4; added 1 November 2026;
 * docs/ease-patterns-audit.md): fields fixed in the first pass keep a label
 * a sighted person reads, tied to the field, not a name only a screen
 * reader hears.
 */
import { readFileSync } from "node:fs";
import { done, is } from "./check";

const podcast = readFileSync("components/podcast-editor.tsx", "utf8");
is("the episode's title has a visible label tied to it", podcast.includes('<label htmlFor={`${id}-title`} className="field-label">Episode title</label>') && podcast.includes("<input id={`${id}-title`}"), true);
is("and its notes", podcast.includes('<label htmlFor={`${id}-notes`} className="field-label">Episode notes</label>') && podcast.includes("<textarea id={`${id}-notes`}"), true);
is("no aria-label stands in for them any more", /aria-label="(Title|Notes)"/.test(podcast), false);

// Second pass: rows in a list keep a visible name of their own, not a placeholder that goes when typing starts.
const quiz = readFileSync("components/quiz-scoring.tsx", "utf8");
is("a quiz category's name is a visible label tied to its field", /<label className="flex min-w-0 flex-1 items-center gap-2">\s*<span className="shrink-0 text-sm text-ink-soft">\{`Category \$\{i \+ 1\}`\}<\/span>/.test(quiz) && !quiz.includes("aria-label={`Category ${i + 1}`}"), true);
const forms = readFileSync("components/forms-editor.tsx", "utf8");
is("a form option's name too", /<span className="shrink-0 text-sm text-ink-soft">\{`Option \$\{k \+ 1\}`\}<\/span>/.test(forms) && !forms.includes("aria-label={`Option ${k + 1}`}"), true);
const deals = readFileSync("components/deals-board.tsx", "utf8");
is("a pipeline stage's name too", /<span className="shrink-0 text-sm text-ink-soft">\{`Stage \$\{i \+ 1\}`\}<\/span>/.test(deals) && !deals.includes("aria-label={`Stage ${i + 1}`}"), true);
is("a custom field's name too, and the list is named by its visible heading", /<span className="text-sm text-ink-soft">\{`Field \$\{i \+ 1\}`\}<\/span>/.test(deals) && deals.includes('aria-labelledby="crm-fields-title"') && !deals.includes('<legend className="sr-only">Custom fields</legend>'), true);
const team = readFileSync("components/team-event-editor.tsx", "utf8");
const call = readFileSync("components/call-editor.tsx", "utf8");
is("a day's opening hours keep a spoken name that starts with the day and the word shown beside them", team.includes("aria-label={`${host.email}, ${name}, stretch ${index + 1}, from`}") && call.includes("aria-label={`${name}, stretch ${index + 1}, from`}"), true);
is("on a phone a stage's or an option's name and field take the whole line, never squeezed by the controls beside them", (deals.match(/basis-full items-center gap-2 sm:basis-0 sm:flex-1/g) ?? []).length === 1 && (forms.match(/basis-full items-center gap-2 sm:basis-0 sm:flex-1/g) ?? []).length === 1, true);
is("a custom field's kind and button line up with its field, not with its name", deals.includes("sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end"), true);

// The selects beside a row show a visible word that starts their spoken name (WCAG 2.5.3), as "Points" already does.
const labelled = (src: string, visible: string, aria: string) => new RegExp(`<label className="flex (?:min-w-0 max-w-full )?items-center gap-2 text-sm text-ink-soft">\\s*${visible}\\s*<select[\\s\\S]{0,120}?aria-label=\\{\`${aria}`).test(src);
is("an option's category has a visible label that starts its name", labelled(forms, "Category", "Category of option"), true);
is("an option's result too", labelled(forms, "Result", "Result option"), true);
is("an option's next question too", labelled(forms, "Next", "Next, after option"), true);
is("a stage's meaning too", labelled(deals, "Counts as", "Counts as, for stage"), true);
is("a custom field's kind and choices too", /<span className="text-sm text-ink-soft">Kind<\/span>/.test(deals) && /<span className="text-sm text-ink-soft">Choices, separated by commas<\/span>/.test(deals), true);
is("on a phone a long choice shrinks inside its row instead of making the page scroll sideways (1.4.10)", (forms.match(/flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-soft/g) ?? []).length === 3 && (forms.match(/field w-auto min-w-0 max-w-full flex-1/g) ?? []).length === 3, true);
done();
