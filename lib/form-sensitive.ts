/**
 * 568 [GD2] (c): a creator's form never asks a visitor for what a scam asks for. A store's own forms collect
 * answers to the creator's questions; a password, a full card number, a card's security code or an identity
 * document's number are never among them (payment happens at Stripe's checkout, never in a form). Pure: it reads
 * the questions' own words, and flags; the studio refuses to save the form and names the field.
 *
 * Kept narrow on purpose: "gift card", "business card", a tax ID for an invoice, a postal "PIN code" or a
 * question about passwords are ordinary questions.
 */
import type { FormDef } from "@/lib/forms";

export type SensitiveKind = "password" | "card" | "code" | "id";

const RULES: readonly [SensitiveKind, RegExp][] = [
  ["card", /\b(?:(?:credit|debit)\s+card(?:\s+(?:number|no\.?|details))?|card\s+(?:number|no\.?|details)|cc\s+number)\b/i],
  ["code", /\b(?:cvv2?|cvc2?|cid\s+code|security\s+code|card\s+verification(?:\s+(?:code|value))?)\b/i],
  ["id", /\b(?:social\s+security(?:\s+number)?|ssn|passport\s+(?:number|no\.?)|driver'?s?\s+licen[cs]e\s+(?:number|no\.?)|national\s+id(?:entity)?(?:\s+(?:number|card))?|id\s+card\s+number|identity\s+(?:card\s+)?number)\b/i],
];

function asksForPassword(label: string): boolean {
  // This is only a classification copy; the creator's label is never rewritten.
  // Keep the other secret in "your password manager's password" detectable.
  const request = label.replace(/\bpass(?:word|code|phrase)s?\s+(?=(?:manager|hints?|safety|courses?|lessons?|chapters?)\b)/gi, "");
  // Explicit asks win over question wording, including "What's the password for Instagram?".
  if (/^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:enter|provide|type(?:\s+in)?|input|write|share|send|tell|give|choose|create|confirm|re[-\s]?enter)\s+(?:(?:the|a|an)\s+)?(?:[\p{L}\p{N}'’\-]+\s+){0,5}pass(?:word|code|phrase)s?\b/iu.test(request)) return true;
  if (/^(?:what(?:'s|\s+is)|which\s+is|where(?:'s|\s+is))\s+(?:the\s+)?pass(?:word|code|phrase)s?\s+(?:for|to)\s+(?:(?:your|my)\s+)?[\p{L}\p{N}'’\-]+/iu.test(request)) return true;
  // Exempt complete habit questions, not an arbitrary question prefix that
  // could hide a second request for the secret later in the same field.
  const about = /^(?:(?:do|did|does|have|has)\s+you\s+(?:reuse|change|reset|forget|forgot|remember|store|save|use)|how\s+(?:often|frequently)\s+(?:do|did|does)\s+you\s+(?:reuse|change|reset|rotate)|what\s+makes)\s+(?:your|my)\s+pass(?:word|code|phrase)s?\s*(?:(?:strong|secure|safe)|(?:last|this)\s+(?:month|week|year))?\s*[?.]?$/i.test(request);
  if (!about && /\b(?:your|my)\b(?:\s+[\p{L}\p{N}'’\-]+){0,5}\s+pass(?:word|code|phrase)s?\b/iu.test(request)) return true;

  // Punctuation is a separator in ordinary credential labels ("Email, password"
  // and "Gmail — password"), not a reason to let the secret through.
  const normalized = request.replace(/[,:;|.–—():&/+]/g, " ").replace(/\s+/g, " ").trim();
  // Short complete questions about a sign-in process do not ask the visitor
  // to disclose a secret. Explicit questions for the actual password matched above.
  const topicQuestion = /^(?:how|what|why|which|when|where|who|do|did|does|would|could|can|have|has|should|describe|feedback|opinion|thoughts|experience|review)\b/i.test(normalized);
  const credentialPair = /\b(?:e-?mail|user\s*name|username|login)\b(?:\s+[\p{L}\p{N}'’\-]+){0,3}\s+pass(?:word|code|phrase)s?\b|\bpass(?:word|code|phrase)s?\b(?:\s+[\p{L}\p{N}'’\-]+){0,3}\s+\b(?:e-?mail|user\s*name|username|login)\b/iu.test(normalized);
  if (credentialPair && !topicQuestion) return true;

  // A short field name may name a service, or use "email and password" with
  // a courtesy suffix. Narrow exceptions below keep ordinary password questions.
  const fieldName = request.replace(/(\bpass(?:word|code|phrase)s?)\s*\([^)]*\)(?=\s*(?:please|here|below)?\s*[:*?]?$)/gi, "$1")
    .replace(/[,:;|.–—():&/+]/g, " ").replace(/\s+/g, " ").trim();
  return !/^(?:how|what|why|which|when|where|who|do|did|does|would|could|can|have|has|should|rate|describe|feedback|opinion|thoughts|experience|review)\b/i.test(fieldName) &&
    /^(?:(?:[\p{L}\p{N}'’\-]+|[&/+])\s+){0,3}pass(?:word|code|phrase)s?\s*(?:please|here|below)?\s*[:*?]?$/iu.test(fieldName) ||
    /^(?:(?:a|the|new|current|account|email|login)\s+)*pass(?:word|code|phrase)s?\b/i.test(request);
}

/** Why each kind is never asked, in the studio's words. */
export const SENSITIVE_WHY: Readonly<Record<SensitiveKind, string>> = {
  password: "A form never asks for a password: no real store needs one, and scams do.",
  card: "A form never asks for a card number: buyers pay at checkout, where Stripe takes the card safely.",
  code: "A form never asks for a card's security code: only the payment page may, and it never keeps it.",
  id: "A form never asks for an identity number such as a Social Security or passport number: a store has no need for it, and keeping one is a risk to the buyer.",
};

/**
 * What one label asks for, or null. The same rules as a form's questions, for any other place a visitor is
 * asked to type something (631 [AA1] (d): code the AI generates, lib/generated-code-check.ts).
 */
export function sensitiveKindOf(text: string): SensitiveKind | null {
  const label = text.trim();
  if (asksForPassword(label)) return "password";
  for (const [what, rule] of RULES) if (rule.test(label)) return what;
  return null;
}

/** The first question that asks for one of them, with its words and its kind; null when none does. */
export function sensitiveFieldOf(form: Pick<FormDef, "fields">): { label: string; what: SensitiveKind } | null {
  for (const field of form.fields) {
    const label = field.label.trim();
    const what = sensitiveKindOf(label);
    if (what) return { label, what };
  }
  return null;
}
