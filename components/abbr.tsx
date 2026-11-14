import { ABBREVIATIONS, type Abbreviation } from "@/lib/abbreviations";

/** An abbreviation in Marktmorgen's own words, with what it stands for (WCAG 3.1.4; lib/abbreviations.ts). */
export function Abbr({ of }: { of: Abbreviation }) {
  return <abbr title={ABBREVIATIONS[of]}>{of}</abbr>;
}

/** Where an abbreviation of the list stands in a text: the letters alone, or with a plural "s" after them. */
function firstAt(text: string, short: string): number {
  const found = new RegExp(`\\b${short}(?=s?\\b)`).exec(text);
  return found ? found.index : -1;
}

/**
 * A text with each abbreviation of the list drawn as <Abbr> the first time it appears, unless it already appeared
 * in `before` (the words shown above it in the same part of a page). Everything else stays the text it was.
 */
export function withAbbr(text: string, before = ""): React.ReactNode {
  const marks = (Object.keys(ABBREVIATIONS) as Abbreviation[])
    .filter((short) => firstAt(before, short) < 0)
    .map((short) => ({ short, at: firstAt(text, short) }))
    .filter((mark) => mark.at >= 0)
    .sort((a, b) => a.at - b.at || b.short.length - a.short.length);
  if (marks.length === 0) return text;
  const out: React.ReactNode[] = [];
  let from = 0;
  for (const { short, at } of marks) {
    if (at < from) continue;
    if (at > from) out.push(text.slice(from, at));
    out.push(<Abbr key={`${short}-${at}`} of={short} />);
    from = at + short.length;
  }
  out.push(text.slice(from));
  return out;
}

type HelpItem = { q: string; a: string[] };

/**
 * A help center question (`paragraph` null) or one paragraph of its answer, with each abbreviation expanded the first
 * time its section uses it (WCAG 3.1.4): what came before is every earlier question and answer of the section, then
 * this question and the paragraphs above this one.
 */
export function helpAbbr(section: { items: HelpItem[] }, item: HelpItem, paragraph: string | null): React.ReactNode {
  const before: string[] = [];
  for (const one of section.items) {
    if (one !== item) {
      before.push(one.q, ...one.a);
      continue;
    }
    if (paragraph === null) break;
    before.push(one.q);
    for (const earlier of one.a) {
      if (earlier === paragraph) break;
      before.push(earlier);
    }
    break;
  }
  return withAbbr(paragraph ?? item.q, before.join("\n"));
}
