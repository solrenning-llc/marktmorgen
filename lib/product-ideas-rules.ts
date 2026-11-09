/**
 * "Get product ideas" (758 [STN5], unit 2): five ideas for a product the
 * creator could make next, each with who it helps and why it fits the store,
 * written from the store's own words (lib/product-ideas.ts asks the model).
 * Rules the browser can read too: the sizes the request is priced at, the
 * words that keep an idea from being shown, what the studio box says, and
 * how the studio reads the answer back. Nothing here calls a model, reads
 * or writes anything.
 *
 * An idea never carries a promise of earnings: no money figure, no
 * percentage, no earnings or income words, no guarantee and no urgency, in
 * any language a store sells in. Picking one only fills the name and the
 * short description of the new-product form; the creator changes them and
 * presses its own Add button, or does not.
 */

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

/**
 * What keeps an idea from being shown, in every language a store sells in:
 * a currency sign or code, a percentage, earnings, income, revenue, profit
 * or money, a guarantee, and urgency. Numbers, deals and links are held to
 * the store's own words separately (heldToFacts, lib/store-assistant-rules.ts).
 */
export const IDEA_REFUSED = new RegExp(
  [
    "[$€£¥₹%]",
    "\\b(?:usd|eur|gbp|cad|aud|chf|sek|nok|dkk|pln|jpy)\\b",
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
  note: "These are ideas only. Nothing is saved or shown on your page until you press Add it. Ideas never include prices or earnings.",
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
