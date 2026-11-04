/**
 * 639 [GL7](4), unit 3: the store's companies in the studio
 * (components/companies-editor.tsx, app/studio/companies/page.tsx). Each
 * with its people, linked to their pages by key and named by the address
 * found among the store's buyers, or said not to be there; added, changed
 * and deleted, the delete undone with the same people; every field labeled.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompaniesEditor } from "@/components/companies-editor";
import { type Company, MAX_COMPANIES } from "@/lib/crm-companies-rules";
import { done, is, part } from "./check";

const ann = "a".repeat(32);
const ghost = "b".repeat(32);
const north: Company = { id: "aaaaaaaaaa", name: "North School", website: "https://north.example.com/", note: "Buys seats each term", people: [ann, ghost], createdAt: 1 };
const draw = (companies: (Company & { addresses: Record<string, string> })[], addressesRead = true, addressesPartial = false) => renderToStaticMarkup(createElement(CompaniesEditor, { initial: companies, peopleBase: "/studio/people?store=s1", addressesRead, addressesPartial }));

part("The list");
const html = draw([{ ...north, addresses: { [ann]: "ann@example.com" } }]);
is("each company under its own heading, with its count", html.includes('<h2 id="companies-title"') && html.includes("Your companies (1)") && html.includes("<h3") && html.includes("North School</h3>"), true);
is("its site and note", html.includes("north.example.com") && html.includes("Buys seats each term"), true);
is("each person linked to their page by key, named by their address, the link saying where it goes (2.4.9)", html.includes(`href="/studio/people?store=s1&amp;who=${ann}"`) && html.includes('>ann@example.com<span class="sr-only">: open their page</span></a>'), true);
is("someone not among the buyers is said to be so, in plain words (3.1.5)", html.includes("A person we could not find among your Stripe buyers") && !html.includes("read from your Stripe account"), true);
is("when Stripe could not be read, nobody is said to be missing from the buyers", [draw([{ ...north, addresses: {} }], false).includes("A person whose address could not be read just now"), draw([{ ...north, addresses: {} }], false).includes("could not find among")], [true, false]);
is("each company's heading can take the focus, for an undo that puts it back", html.includes('<h3 tabindex="-1"') && html.includes('<h2 id="companies-title" tabindex="-1"'), true);
is("each button names its company", html.includes('aria-label="Change North School"') && html.includes('aria-label="Delete North School"'), true);
is("none yet, said how to add one", draw([]).includes("No companies yet. Add the first one above, or from a person&#x27;s page."), true);

part("Adding and changing");
is("every field labeled, the optional ones said to be, each with an example kept out of its name", [["name", "Name"], ["website", "Website (optional)"], ["note", "Note (optional)"]].every(([id, label]) => html.includes(`<label for="company-${id}" class="field-label">${label}</label>`) && html.includes(`id="company-${id}"`)) && ["company-name-hint", "company-site-hint", "company-note-hint"].every((id) => html.includes(`aria-describedby="${id}"`)), true);
is("refusals said in an alert, what was done in a status", html.includes('role="alert"') && html.includes('role="status"'), true);
is("no button switched off, so the focus never falls off one (C1, C3)", [html.includes("disabled="), html.includes("aria-disabled")], [false, false]);
const atMost = draw(Array.from({ length: MAX_COMPANIES }, (_, i) => ({ ...north, id: `c${String(i).padStart(9, "0")}`, name: `Company ${i}`, people: [], addresses: {} })));
is("at the most a store can keep, the add button says why it does nothing, beside it (C3)", atMost.includes('aria-disabled="true" aria-describedby="companies-full"') && atMost.includes(`<p id="companies-full" class="mt-2 text-sm text-ink">Your store has ${MAX_COMPANIES} companies`), true);
const screen = readFileSync("components/companies-editor.tsx", "utf8");

part("The AAA audit of 4 November 2026");
is("C1: busy buttons are said to be, never switched off, and do nothing then", !/(?<![-\w])disabled=\{/.test(screen) && (screen.match(/aria-disabled=\{busy \|\| undefined\}/g) ?? []).length === 3 && (screen.match(/if \(busy\) return;/g) ?? []).length === 3 && screen.includes("if (!gone || busy) return;"), true);
is("C1: the focus is moved by refs once the change is drawn, never by a timer", screen.includes("useEffect(() => {") && screen.includes("}, [focusAsk]);") && !/setTimeout|requestAnimationFrame/.test(screen), true);
is("C1: a delete takes the focus to Undo; an undo to the company put back; Cancel and a save to the Change button; an add to the name", screen.includes('focusAfterDrawing({ to: "undo" })') && screen.includes('focusAfterDrawing(back.added ? { to: "company", id: back.added } : { to: "list" })') && screen.includes('if (was) focusAfterDrawing({ to: "change", id: was })') && screen.includes('focusAfterDrawing(was ? { to: "change", id: was } : { to: "name" })'), true);
is("C2: a refusal names its field, marked invalid and described by the message beside it", screen.includes('const FIELD_OF: Partial<Record<string, Field>> = { name: "name", taken: "name", website: "website", note: "note" };') && ["name", "website", "note"].every((field) => screen.includes(`aria-invalid={errorField === "${field}" || undefined}`)) && screen.includes("`${hint} company-${field}-error`") && screen.includes('className="field-error'), true);
is("C3: an empty name is told at the field, not by a dead button", screen.includes(`if (!form.name.trim()) return refuse("Type the company's name.", "name");`), true);
is("C6: a delete and its undo are said once, in the status line, never also in a toast", screen.includes('send({ action: "remove", id: company.id }, null)') && screen.includes("people: gone.people }, null)") && screen.includes("if (done) toast(done);") && !screen.includes('"Company deleted."') && !screen.includes('"Company put back."'), true);
is("C7: a full store said in plain words", screen.includes("Your store has no room left for more records. Delete some you no longer need first.") && !screen.includes("data room"), true);

part("The independent review of the audit fixes");
is("HIGH 1: a refusal tied to a field is also said in the alert when the focus is already in that field, hidden there as it shows beside the field", screen.includes("=== document.activeElement);") && screen.includes('<span key={errorAsk} className={errorField') && screen.includes('"sr-only" : undefined}>') && screen.includes('{errorField && !spoken ? "" : error}') && screen.includes("setErrorAsk((n) => n + 1);"), true);
is("MEDIUM 3: correcting the field at fault takes its refusal away", ["name", "website", "note"].every((field) => screen.includes(`onChange={(event) => type("${field}", event.target.value)}`)) && screen.includes("if (errorField === field) clearError();"), true);
is("LIGHT 4: at the most a store can keep, a submit says why, shown once beside the button", screen.includes("if (full) return refuse(COMPANY_REFUSALS.full, null);") && screen.includes("(full && error === COMPANY_REFUSALS.full)"), true);
is("LIGHT 5: a reading of Stripe cut short is said beside someone not found", [draw([{ ...north, addresses: {} }], true, true).includes("A person we could not find among your Stripe buyers (the oldest buyers are not read)"), html.includes("oldest")], [true, false]);
is("the alert region is there before any refusal, its message drawn as a new node each time", html.includes('role="alert"><span></span></p>'), true);
is("a delete keeps the people, and is undone in one change with them, saying who had moved and stays", screen.includes("Its people are still in your store.") && screen.includes('send({ action: "restore", name: gone.name, website: gone.website, note: gone.note, people: gone.people }') && screen.includes("moved to another company since") && !screen.includes('action: "link", id: added.id'), true);
is("Change takes the focus to the form it opens, and the website field has its limit (review A6)", screen.includes('focusAfterDrawing({ to: "name", scroll: true })') && screen.includes("shown?.focus();") && screen.includes("maxLength={MAX_COMPANY_WEBSITE}"), true);

part("The page");
const page = readFileSync("app/studio/companies/page.tsx", "utf8");
is("for those who see the people's pages", page.includes('"orders");'), true);
is("the people found among the buyers, never stored by address", page.includes("personAddresses(store, people)"), true);
is("said when Stripe or the companies cannot be read", page.includes("Stripe could not be read just now, so who works at each company is not shown.") && page.includes("Your companies could not be read just now. Nothing was changed."), true);
is("the editor told when Stripe could not be read, or read only in part", page.includes("addressesRead={!people.size || Boolean(known)}") && page.includes("addressesPartial={known?.partial ?? false}"), true);
is("where it is said by a breadcrumb back to the buyers (2.4.8)", page.includes('<nav aria-label="Breadcrumb"') && page.includes('<li aria-current="page">Companies</li>') && page.includes('<Link href={studioPath(store, "", "people")} className="inline-flex min-h-11') && !page.includes('<p className="eyebrow">Buyers</p>'), true);
is("reached from the buyers page", readFileSync("app/studio/people/page.tsx", "utf8").includes('studioPath(store, "", "companies")') && readFileSync("app/studio/people/page.tsx", "utf8").includes("Companies you sell to"), true);

done();
