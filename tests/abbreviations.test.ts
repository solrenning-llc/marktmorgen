/**
 * WCAG 3.1.4 Abbreviations (AAA, AX274): a way to find what an abbreviation stands for. The studio wrote API, CSV,
 * CRM, DNS, HTML, PDF and UTC bare in its own words. Abbr (components/abbr.tsx) draws <abbr title> with the
 * expansion from one list (lib/abbreviations.ts), so the same letters always expand the same way. Here, the ten
 * studio files no open pull request touched on 13 November 2026 mark the first time each one appears in their own
 * words; the rest are listed in docs/a11y-language-backlog-2026-11-13.md.
 */
import { readFileSync } from "node:fs";
import { done, is, part } from "./check";
import { ABBREVIATIONS } from "@/lib/abbreviations";

part("One list says what each stands for");
for (const [short, long] of [
  ["API", "application programming interface"],
  ["CSV", "comma-separated values"],
  ["CRM", "customer relationship management"],
  ["DNS", "Domain Name System"],
  ["HTML", "HyperText Markup Language"],
  ["PDF", "Portable Document Format"],
  ["UTC", "Coordinated Universal Time"],
] as const) {
  is(`${short} stands for ${long}`, ABBREVIATIONS[short], long);
}

part("Each file marks the first time it writes one");
for (const [file, shorts] of [
  ["components/bundle-editor.tsx", ["PDF"]],
  ["components/buy-button-editor.tsx", ["HTML"]],
  ["components/custom-range.tsx", ["UTC", "CSV"]],
  ["components/deals-unavailable.tsx", ["CRM"]],
  ["components/domain-editor.tsx", ["DNS"]],
  ["components/form-answers.tsx", ["PDF"]],
  ["components/form-response-deal.tsx", ["CRM"]],
  ["components/payment-comparison.tsx", ["UTC"]],
  ["components/server-events-editor.tsx", ["API"]],
  ["components/team-two-step-switch.tsx", ["API"]],
] as const) {
  const text = readFileSync(file, "utf8");
  for (const short of shorts) is(`${file}: <Abbr of="${short}" />`, text.includes(`<Abbr of="${short}" />`), true);
  is(`${file}: imports Abbr`, text.includes('import { Abbr } from "@/components/abbr";'), true);
}
done();
