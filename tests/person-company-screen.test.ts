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
is("the site's link says it opens a new tab", html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"') && html.includes("(opens in a new tab)"), true);
is("none, said as none", draw([south]).includes("Not linked to a company."), true);

part("Choosing one");
is("a labeled choice of the store's companies, or none", html.includes("Company</span>") && /<option value=""[^>]*>None<\/option>/.test(html) && html.includes(">South Studio</option>"), true);
is("a new one made in place, labeled, its effect said", html.includes("Or add a company") && html.includes('aria-describedby="company-add-hint"') && html.includes("this person is linked to it at once"), true);
is("no choice before the store has a company, only the way to add one", [draw([]).includes("<select"), draw([]).includes("Add and link")], [false, true]);
is("refusals said in an alert, what was done in a status", html.includes('role="alert"') && html.includes('role="status"'), true);
const screen = readFileSync("components/person-company.tsx", "utf8");
is("taking them off is undone by linking them back", screen.includes("setLeft(was)") && screen.includes("onClick={() => void link(left.id)}") && screen.includes("Undo"), true);
is("the browser gets the rules, never the storage", screen.includes('from "@/lib/crm-companies-rules"') && !screen.includes('from "@/lib/crm-companies"') && !readFileSync("lib/crm-companies-rules.ts", "utf8").includes("redis"), true);

part("On the person's page");
const page = readFileSync("app/studio/people/page.tsx", "utf8");
is("a named section with its heading", page.includes('aria-labelledby="company-title"') && page.includes('<h2 id="company-title"'), true);
is("read with the page, and said when it cannot be", page.includes("readCompanies(store.statsId).catch(() => null)") && page.includes("This person&apos;s company could not be read just now."), true);

done();
