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
import type { Company } from "@/lib/crm-companies-rules";
import { done, is, part } from "./check";

const ann = "a".repeat(32);
const ghost = "b".repeat(32);
const north: Company = { id: "aaaaaaaaaa", name: "North School", website: "https://north.example.com/", note: "Buys seats each term", people: [ann, ghost], createdAt: 1 };
const draw = (companies: (Company & { addresses: Record<string, string> })[]) => renderToStaticMarkup(createElement(CompaniesEditor, { initial: companies, peopleBase: "/studio/people?store=s1" }));

part("The list");
const html = draw([{ ...north, addresses: { [ann]: "ann@example.com" } }]);
is("each company under its own heading, with its count", html.includes('<h2 id="companies-title"') && html.includes("Your companies (1)") && html.includes("<h3") && html.includes("North School</h3>"), true);
is("its site and note", html.includes("north.example.com") && html.includes("Buys seats each term"), true);
is("each person linked to their page by key, named by their address", html.includes(`href="/studio/people?store=s1&amp;who=${ann}"`) && html.includes(">ann@example.com</a>"), true);
is("someone not among the buyers is said to be so", html.includes("Someone not among the buyers read from your Stripe account"), true);
is("each button names its company", html.includes('aria-label="Change North School"') && html.includes('aria-label="Delete North School"'), true);
is("none yet, said how to add one", draw([]).includes("No companies yet. Add the first one above, or from a person&#x27;s page."), true);

part("Adding and changing");
is("every field labeled, the optional ones said to be, each with an example", ["Name", "Website (optional)", "Note (optional)"].every((label) => html.includes(`<span class="field-label">${label}</span>`)) && ["company-name-hint", "company-site-hint", "company-note-hint"].every((id) => html.includes(`aria-describedby="${id}"`)), true);
is("refusals said in an alert, what was done in a status", html.includes('role="alert"') && html.includes('role="status"'), true);
const screen = readFileSync("components/companies-editor.tsx", "utf8");
is("a delete keeps the people, and is undone with the same people", screen.includes("Its people are still in your store.") && screen.includes('for (const person of gone.people) await send({ action: "link", id: added.id, person }'), true);

part("The page");
const page = readFileSync("app/studio/companies/page.tsx", "utf8");
is("for those who see the people's pages", page.includes('"orders");'), true);
is("the people found among the buyers, never stored by address", page.includes("personAddresses(store, people)"), true);
is("said when Stripe or the companies cannot be read", page.includes("Stripe could not be read just now, so who works at each company is not shown.") && page.includes("Your companies could not be read just now. Nothing was changed."), true);
is("reached from the buyers page", readFileSync("app/studio/people/page.tsx", "utf8").includes('studioPath(store, "", "companies")') && readFileSync("app/studio/people/page.tsx", "utf8").includes("Companies you sell to"), true);

done();
