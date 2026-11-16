/**
 * The campaigns' own parts in [brackets] (lib/funnel-starters.ts), read once
 * from every page a campaign makes, for the routes that refuse a page going
 * out with one (754 [STN1], unit 1). Kept apart from
 * lib/template-text-rules.ts so the page editor never carries the campaigns.
 */
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { bracketPartsIn, templateTextIn, type TemplateLeft } from "@/lib/template-text-rules";

/** Every string a campaign's pages hold, at any depth. */
function stringsOf(value: unknown, out: string[], depth = 0): string[] {
  if (typeof value === "string") out.push(value);
  else if (depth < 8 && Array.isArray(value)) for (const item of value) stringsOf(item, out, depth + 1);
  else if (depth < 8 && value && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, out, depth + 1);
  return out;
}

/** The campaigns' parts in [brackets], exactly as a page made from one holds them. */
export const STARTER_PROMPTS: readonly string[] = bracketPartsIn(FUNNEL_STARTERS.flatMap((starter) => stringsOf(starter.bundle.pages, [])));

/** The first part left for the creator to write on a page; null when there is none. */
export const templateLeft = (page: Parameters<typeof templateTextIn>[0]): TemplateLeft | null => templateTextIn(page, STARTER_PROMPTS);
