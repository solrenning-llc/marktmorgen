import { ABBREVIATIONS, type Abbreviation } from "@/lib/abbreviations";

/** An abbreviation in Marktmorgen's own words, with what it stands for (WCAG 3.1.4; lib/abbreviations.ts). */
export function Abbr({ of }: { of: Abbreviation }) {
  return <abbr title={ABBREVIATIONS[of]}>{of}</abbr>;
}
