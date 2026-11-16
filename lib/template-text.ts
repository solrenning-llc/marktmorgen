/**
 * The campaigns' own parts in [brackets] (lib/funnel-starters.ts), read once
 * from every page a campaign makes, for the routes that refuse a page going
 * out with one (754 [STN1], unit 1). Kept apart from
 * lib/template-text-rules.ts so the page editor never carries the campaigns.
 */
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { bracketPartsIn, stringsIn, templateTextIn, type TemplateLeft } from "@/lib/template-text-rules";

/** The campaigns' parts in [brackets], exactly as a page made from one holds them. */
export const STARTER_PROMPTS: readonly string[] = bracketPartsIn(FUNNEL_STARTERS.flatMap((starter) => stringsIn(starter.bundle.pages)));

/** The first part left for the creator to write on a page; null when there is none. */
export const templateLeft = (page: Parameters<typeof templateTextIn>[0]): TemplateLeft | null => templateTextIn(page, STARTER_PROMPTS);
