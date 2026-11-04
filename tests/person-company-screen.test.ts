/**
 * 639 [GL7](4), unit 2: the company a person works at, on their page in the
 * studio (components/person-company.tsx, app/studio/people/page.tsx). Said
 * in words, chosen from the store's companies or made in place, every field
 * labeled, a link that says it opens a new tab, taking them off undone, and
 * nothing in the browser that reaches the database.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonCompany } from "@/components/person-company";
import type { Company } from "@/lib/crm-companies-rules";
import { done, is, part } from "./check";

const PERSON = "a".repeat(32);
const north: Company = { id: "aaaaaaaaaa", name: "North School", website: "https://north.example.com/", note: "Buys seats each term", people: [PERSON], createdAt: 1 };
const south: Company = { id: "bbbbbbbbbb", name: "South Studio", website: "", note: "", people: [], createdAt: 2 };
const draw = (companies: Company[]) => renderToStaticMarkup(createElement(PersonCompany, { person: PERSON, initial: companies }));

part("Where they work");
const html = draw([north, south]);
is("said in words, with the company's site and note", html.includes("Works at <span") && html.includes("North School</span>") && html.includes(">north.example.com<") && html.includes("Buys seats each term"), true);
is("the site's link says it opens a new tab, where everyone sees it", html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"') && html.includes("<span> (opens in a new tab)</span></a>") && !html.includes('sr-only"> (opens in a new tab)'), true);
is("none, said as none", draw([south]).includes("Not linked to a company."), true);

part("Choosing one");
is("a labeled choice of the store's companies, or none", html.includes("Company</span>") && /<option value=""[^>]*>None<\/option>/.test(html) && html.includes(">South Studio</option>"), true);
is("a new one made in place, labeled, its example and effect said in a hint that stays while typing (3.3.2)", html.includes('<label for="company-add" class="field-label">Or add a company</label>') && html.includes('id="company-add"') && html.includes('aria-describedby="company-add-hint"') && html.includes("Example: North School. This person is linked to it when you add it.") && !html.includes("placeholder="), true);
is("no button or choice switched off, so the focus never falls off one (C1, C3)", [html.includes("disabled="), draw([]).includes("disabled=")], [false, false]);
is("no choice before the store has a company, only the way to add one", [draw([]).includes("<select"), draw([]).includes("Add and link")], [false, true]);
is("refusals said in an alert, what was done in a status", html.includes('role="alert"') && html.includes('role="status"'), true);
const screen = readFileSync("components/person-company.tsx", "utf8");
is("taking them off is undone by linking them back", screen.includes("setLeft(was)") && screen.includes("onClick={() => void undo()}") && screen.includes("const back = left;") && screen.includes("Undo"), true);

part("The AAA audit of 4 November 2026");
is("C1: busy controls are said to be, never switched off, and do nothing then", !/(?<![-\w])disabled=\{/.test(screen) && (screen.match(/aria-disabled=\{busy \|\| undefined\}/g) ?? []).length === 4 && screen.includes("onChange={(event) => {\n                  if (busy) return;") && screen.includes("if (!left || busy) return;") && (screen.match(/if \(busy\) return;/g) ?? []).length === 3, true);
is("C1: the focus is moved by refs once the change is drawn, never by a timer", screen.includes("}, [focusAsk]);") && !/setTimeout|requestAnimationFrame/.test(screen), true);
is("C1: taking them off takes the focus to Undo; the undo to the choice; adding back to the field", screen.includes('focusAfterDrawing("undo")') && screen.includes('if (await link(back.id, `Linked to ${back.name} again.`)) focusAfterDrawing("choice");') && screen.includes('focusAfterDrawing("name");'), true);
is("C2: a name refused is told beside the field, marked invalid and described by it", screen.includes('answer.error === "name" || answer.error === "taken") ? "name" : null') && screen.includes('aria-invalid={errorField === "name" || undefined}') && screen.includes('"company-add-hint company-add-error"') && screen.includes('id="company-add-error" className="field-error'), true);
is("C3: Save with nothing changed, and Add with nothing typed, say what to do", screen.includes("Choose another company, or None, first.") && screen.includes('"Choose a company first."') && screen.includes(`return refuse("Type the company's name.", "name");`) && screen.includes('aria-describedby={errorField === "choice" ? "company-choice-error" : undefined}'), true);
is("C6: taking them off is said once, in the status line; adding and linking in one toast", screen.includes('send({ action: "unlink", person }, null)') && screen.includes('send({ action: "add", name: typed }, null)') && !screen.includes('"Taken off the company."'), true);
is("C7: a full store said in plain words", screen.includes("Your store has no room left for more records. Delete some you no longer need first.") && !screen.includes("data room"), true);
is("the browser gets the rules, never the storage", screen.includes('from "@/lib/crm-companies-rules"') && !screen.includes('from "@/lib/crm-companies"') && !readFileSync("lib/crm-companies-rules.ts", "utf8").includes("redis"), true);

part("On the person's page");
const page = readFileSync("app/studio/people/page.tsx", "utf8");
is("a named section with its heading", page.includes('aria-labelledby="company-title"') && page.includes('<h2 id="company-title"'), true);
is("read with the page, and said when it cannot be", page.includes("readCompanies(store.statsId).catch(() => null)") && page.includes("This person&apos;s company could not be read just now."), true);

is("add and link uses the id the server made, never one guessed from the list (review A5)", (() => { const code = readFileSync("components/person-company.tsx", "utf8"); return code.includes("await link(made.added, ") && !code.includes("!companies.some((old) => old.id === c.id)"); })(), true);
done();
