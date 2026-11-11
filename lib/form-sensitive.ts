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

const SECRET = String.raw`pass(?:word|code|phrase)s?`;
const WORD = String.raw`[\p{L}\p{N}'’\-]+`;
// A word after which the secret is the topic of the sentence, not the thing asked for ("Tell us about your password").
const NOT_TOPIC = String.raw`(?!(?:about|of|on|with|regarding|around|concerning)\b)`;
// Explicit asks win over question wording, including "Could you share your Gmail password?".
const EXPLICIT = new RegExp(String.raw`^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|(?:do|would)\s+you\s+mind\s+)?(?:enter|provide|type(?:\s+in)?|input|write|share|send|tell|give|choose|create|confirm|re[-\s]?enter|entering|providing|typing|sharing|sending|telling|giving)\s+(?:(?:the|a|an)\s+)?(?:${NOT_TOPIC}${WORD}\s+){0,5}${SECRET}\b`, "iu");
// "What's the password for Instagram?"
const PASSWORD_FOR = new RegExp(String.raw`^(?:what(?:'s|\s+is)|which\s+is|where(?:'s|\s+is))\s+(?:the\s+)?${SECRET}\s+(?:for|to)\s+(?:(?:your|my)\s+)?${WORD}`, "iu");
// "What is the password?", "What is the Instagram password?", "Which is your password?": the secret itself, as the
// whole answer. Never "What is a password?" or "What is the best password?", which ask about passwords.
const PASSWORD_IS = new RegExp(String.raw`^(?:what(?:'s|\s+is|\s+are)|which\s+(?:is|are)|where(?:'s|\s+is|\s+are))\s+(?!(?:a|an)\b)(?:(?!(?:good|best|strong|strongest|secure|safe|weak|weakest|ideal|perfect|typical|common)\b)${WORD}\s+){0,3}${SECRET}$`, "iu");
// "Your Instagram password", "Please send me your password": the secret named as the visitor's own.
const OWN_SECRET = new RegExp(String.raw`\b(?:your|my)\b(?:\s+${NOT_TOPIC}${WORD}){0,5}\s+${SECRET}\b`, "iu");
// Words that open a question, a review or an opinion: credential pairs are only refused outside them (below).
const TOPIC_QUESTION = /^(?:how|what|why|which|when|where|who|do|did|does|would|could|can|have|has|should|describe|feedback|opinion|thoughts|experience|review)\b/i;
// A sentence that asks about something (a survey question), not for it: a real question word only. Never "can",
// "could" or "would" ("Can I get your password?"), "how about" or "what about" ("How about your password?"),
// nor "describe" ("Describe your password").
const ABOUT_QUESTION = /^(?!(?:how|what)\s+about\b)(?:how|what|why|which|when|where|who|do|did|does|have|has|should)\b/i;
// A sentence that asks the visitor to type or hand over something ("Type it here").
const REQUEST_VERB = /^(?:(?:please|kindly|now|then|and|also)\s+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:enter|provide|type|input|write|share|send|tell|give|confirm|re[-\s]?enter|put|paste|fill)\b/i;

function asksForPassword(label: string): boolean {
  // This is only a classification copy; the creator's label is never rewritten.
  // Keep the other secret in "your password manager's password" detectable.
  const request = label.replace(/\bpass(?:word|code|phrase)s?\s+(?=(?:manager|hints?|safety|courses?|lessons?|chapters?|habits?|rules?|polic(?:y|ies)|strength|hygiene|tips?|advice)\b)/gi, "");
  // Each sentence on its own, so a survey question cannot hide a request after it ("Do you reuse your passwords?
  // Enter your password") and a request is never excused by the question before it.
  const sentences = request.split(/[?!.:;\n]+/).map((part) => part.trim()).filter(Boolean);
  for (const sentence of sentences) {
    if (EXPLICIT.test(sentence) || PASSWORD_FOR.test(sentence) || PASSWORD_IS.test(sentence)) return true;
    // Naming the visitor's own secret is a request, unless the sentence is a question about something
    // ("How do you remember your passwords?", "Which of your apps needs a new password most often?").
    if (!ABOUT_QUESTION.test(sentence) && OWN_SECRET.test(sentence)) return true;
  }
  // A question about the secret followed by a request for "it" ("Do you have your password handy? Type it here").
  if (OWN_SECRET.test(request) && sentences.some((sentence) => REQUEST_VERB.test(sentence))) return true;

  // Punctuation is a separator in ordinary credential labels ("Email, password"
  // and "Gmail — password"), not a reason to let the secret through.
  const normalized = request.replace(/[,:;|.–—():&/+]/g, " ").replace(/\s+/g, " ").trim();
  // Short complete questions about a sign-in process do not ask the visitor
  // to disclose a secret. Explicit questions for the actual password matched above.
  const topicQuestion = TOPIC_QUESTION.test(normalized);
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
