/**
 * "Get product ideas" (758 [STN5], unit 2): five ideas for a product the
 * creator could make next, each with who it helps and why it fits the store,
 * written from the store's own words (lib/product-ideas.ts asks the model).
 * Rules the browser can read too: the sizes the request is priced at, the
 * words that keep an idea from being shown, what the studio box says, and
 * how the studio reads the answer back. Nothing here calls a model, reads
 * or writes anything.
 *
 * An idea that mentions prices or earnings is left out: a money figure, a
 * currency's sign, code or word, a rate per month or week, a percentage,
 * earnings, income, wealth or sales words, a guarantee or urgency, in the
 * languages a store sells in (IDEA_REFUSED, a list that cannot be complete,
 * behind the model's own instruction). Picking one only fills the name and the
 * short description of the new-product form; the creator changes them and
 * presses its own Add button, or does not.
 */
import { CURRENCIES } from "@/lib/money";

/** Ideas shown at the most, and asked of the model, so a refused one leaves room. */
export const PRODUCT_IDEAS_SHOWN = 5;
export const PRODUCT_IDEAS_ASKED = 8;

/** The products a store shows that the model is told about, the first ones of its list. */
export const IDEAS_PRODUCTS = 8;

/**
 * The bytes a request may carry, instructions and the store's words apart,
 * and the tokens it may write back: what one request is priced at
 * (tests/product-ideas.test.ts holds it at most a priced writing job on
 * every model a deployment may pick).
 */
export const IDEAS_SYSTEM_BYTES = 4_096;
export const IDEAS_PROMPT_BYTES = 8_192;
export const IDEAS_OUTPUT_TOKENS = 1_600;

/** Each part of an idea at the most; one longer is left out, never cut. The name and who it helps fill the form's own boxes. */
export const MAX_IDEA_TITLE = 70;
export const MAX_IDEA_WHO = 140;
export const MAX_IDEA_WHY = 200;

export type ProductIdea = { title: string; who: string; why: string };

/** A whole word or phrase, for words that may begin or end in a letter outside ASCII (where \b does not see a boundary). */
const word = (alternatives: string) => `(?:^|[^\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`;

/** A number followed by a rate of time: "5000 a month", "40/month", "40 al mes", "40 pro Monat". */
const RATE = `\\d[\\d.,\\s]*k?\\s*(?:${[
  "(?:a|an|per|each|every|/)\\s*(?:month|week|year|day|hour|mo|wk|yr|hr)s?",
  "monthly|weekly|yearly|annually|per annum",
  "(?:al|por|cada|a la)\\s+(?:mes|año|día|semana|hora)",
  "(?:ao|por|cada|à)\\s+(?:mês|ano|dia|semana|hora)",
  "(?:par|chaque|/)\\s*(?:mois|an|année|jour|semaine|heure)",
  "(?:pro|im|je|jeden|jede|/)\\s*(?:monat|jahr|tag|woche|stunde)",
  "(?:al|all'|per|ogni|a)\\s*(?:mese|anno|giorno|settimana|ora)",
  "(?:per|elke|/)\\s*(?:maand|jaar|dag|week|uur)",
].join("|")})(?![\\p{L}\\p{N}])`;

/**
 * What keeps an idea from being shown, in the languages a store sells in: a
 * currency sign (any of Unicode's), the code of every currency a store may
 * sell in (lib/money.ts) and currency words, a percentage, a rate per month
 * or week after a number, earnings, income, revenue, profit, money, wealth
 * and sales words with their stems, a guarantee, and urgency. Read after
 * NFKC, so a full-width or small-form sign is the sign (keptIdeas). Numbers,
 * deals and links are held to the store's own words separately (heldToFacts,
 * lib/store-assistant-rules.ts). Any such list can miss a wording: the
 * model's instruction comes first, and the box promises only what this keeps.
 */
export const IDEA_REFUSED = new RegExp(
  [
    "[\\p{Sc}%‰]",
    `\\b(?:${CURRENCIES.map((c) => c.code).join("|")})\\b`,
    `\\d[\\d.,\\s]*(?:kr|zł|sfr)(?![\\p{L}\\p{N}])`,
    RATE,
    // Currency words, in the store languages
    word("dollars?|d[oó]lar(?:es)?|dollar[oi]|bucks|quid|euros?|yen|francs?|franken|kronor|kroner|krona|krone|kronen|zlot(?:y|ys|ych)|złot\\p{L}*|pesos?|reais|cents?|centavos?|c[ée]ntimos?|centimes?|make bank"),
    // Wealth, income and sales, with stems, in the store languages
    word(
      "(?:get|getting|grow|become|be) rich|riches|wealthy|lucr\\p{L}*|rentab\\p{L}*|financial(?:ly)? (?:freedom|independence|security)|quit your (?:day )?job|side (?:business|income|gig)|pay(?:s|ing|out|outs|check|checks|day)?|paid|sales?|sell(?:s|ing)? more|best[- ]?sell\\p{L}*",
    ),
    word("gan(?:a|as|an|amos|ar|ando|ado|ada|e|es|en|ancias?)|ganh\\p{L}*|ventas?|vendas?|ventes?|verkauf\\p{L}*|vendite|verkoop\\p{L}*|hacerse rico|ficar rico|devenir riche|richesse|reich werden|reichtum|diventare ricco|ricchezza|rijk worden|rijkdom|riqueza|libertad financiera|liberdade financeira|libert[ée] financi[èe]re|finanzielle freiheit|libert[àa] finanziaria|financi[ëe]le vrijheid"),
    // English
    "\\b(?:earn\\w*|income|revenue|profit\\w*|money|cash|salary|paycheck|wealth\\w*|millionaire|six[- ]figures?|passive|side hustle|per ?cent|percent(?:age)?|guarantee\\w*|proven|risk[- ]free|promise\\w*|hurry|today only|right now|act now|last chance|limited|don'?t miss|before it'?s gone)\\b",
    // Spanish
    "\\b(?:ganar|ganancias?|ingresos?|dinero|beneficios? econ[oó]micos?|porcentaje|por ciento|garantizad[oa]s?|garant[ií]as?|ahora mismo|date prisa|limitad[oa]s?)\\b",
    // French
    "\\b(?:gagner|revenus?|b[ée]n[ée]fices?|argent|pourcentage|pour cent|garanti(?:e|es|s)?|d[ée]p[êe]chez|limit[ée]e?s?)\\b",
    // German
    "\\b(?:verdien\\w*|einkommen|ums[aä]tze?|gewinn\\w*|geld|prozent|garantiert|garantie|schnell zugreifen|begrenzt)\\b",
    // Italian
    "\\b(?:guadagn\\w*|reddito|ricavi|profitt\\w*|soldi|denaro|percentuale|per cento|garantit[oaie]|garanzia|limitat[oaie])\\b",
    // Dutch
    "\\b(?:verdienen|inkomen|omzet|winst|geld|procent|gegarandeerd|garantie|beperkt)\\b",
    // Portuguese
    "\\b(?:ganhar|ganhos?|renda|receitas? financeiras?|lucros?|dinheiro|porcentagem|por cento|garantid[oa]s?|garantias?|limitad[oa]s?)\\b",
  ].join("|"),
  "iu",
);

/** What the studio box says, in plain words, every sentence with no figure (AX274, 3.1.5). */
export const IDEAS_COPY = {
  opener: "Get product ideas with AI",
  hint: "Not sure what to sell next? Get ideas for a new product, made from your store's name, its line and what it sells now.",
  notesLabel: "What you know well, or who you help (you can leave this empty)",
  notesExample: "I teach sourdough to busy parents. People often ask me how to keep a starter alive.",
  ask: "Get product ideas",
  asking: "Getting ideas…",
  note: "These are ideas only. Nothing is saved or shown on your page until you press Add it. Ideas that mention prices or earnings are left out.",
  badge: "AI suggestions",
  who: "Who it helps:",
  why: "Why it fits your store:",
  use: "Use this idea",
  used: "The name and the short description are filled in. Read them, change anything, then add it.",
  undo: "Put back what you had",
  undone: "What you had is back.",
  allowance: "left this month. Each request uses one, even if it fails.",
  unknownAllowance: "We could not check your writing allowance just now. Reload the page to try again.",
  notes: "Your store has nothing yet to make ideas from. Write a few words about what you know or who you help, then try again.",
  used_up: "This month's writing help is used up. It starts again with your next billing month.",
  slow: "A few at a time: wait a minute, then try again.",
  failed: "No ideas came back just now. Nothing on this page changed. Started attempts count toward your monthly allowance. Try again in a moment.",
  off: "The writing help is not available right now.",
  forbidden: "Your role on this store cannot add products.",
  unconfirmed: "We could not confirm the ideas. Nothing on this page changed. Reload the page to check your writing allowance before you try again.",
} as const;

const COUNT_WORDS = ["One", "Two", "Three", "Four", "Five"] as const;

/** The polite status once ideas are ready: the real count, in words. */
export function ideasReadyWords(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1 || count > COUNT_WORDS.length) return "";
  return count === 1 ? "One idea is ready. It is listed below." : `${COUNT_WORDS[count - 1]} ideas are ready. They are listed below.`;
}

const fits = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** The route's answer as the studio reads it: one to five ideas, each with its three parts in their limits, or null. */
export function readIdeas(value: unknown): ProductIdea[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ideas = (value as { ideas?: unknown }).ideas;
  if (!Array.isArray(ideas) || ideas.length < 1 || ideas.length > PRODUCT_IDEAS_SHOWN) return null;
  const out: ProductIdea[] = [];
  for (const raw of ideas) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { title, who, why } = raw as Record<string, unknown>;
    if (!fits(title, MAX_IDEA_TITLE) || !fits(who, MAX_IDEA_WHO) || !fits(why, MAX_IDEA_WHY)) return null;
    out.push({ title, who, why });
  }
  return out;
}
