/**
 * 630 [HN6](32): a visitor's question the creator answered in the inbox,
 * put on the store page's own questions (lib/store-faq.ts) in one step,
 * without saying who asked.
 *
 * The draft is the latest answer the store wrote and the visitor's message
 * just before it, with the visitor's name, email addresses, links and phone
 * numbers taken out. The creator sees both, can change them, and publishes
 * them; nothing is published on its own. A question or an answer longer
 * than the page keeps is refused, never cut, so no words are lost unseen.
 *
 * Pure rules, no imports beyond types and limits, so the inbox and the
 * server read the same ones.
 */
import { MAX_FAQ, MAX_FAQ_A, MAX_FAQ_Q, parseFaq, type FaqItem } from "@/lib/store-faq";

type Said = { from: "visitor" | "store"; text: string };

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
const NUMBER = /\+?\d[\d\s().-]{7,}\d/g;

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words with the visitor's name, addresses, links and phone numbers taken out; whether anything was. */
export function withoutWhoAsked(text: string, name: string): { text: string; cut: boolean } {
  let out = text.replace(EMAIL, " ").replace(LINK, " ").replace(NUMBER, " ");
  // Each part of their name of 3 letters or more, as a whole word, whatever its case.
  for (const word of new Set(name.split(/\s+/).filter((w) => w.length >= 3))) {
    out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1 ");
  }
  out = out
    .replace(/\(\s*[,;]?\s*\)/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([,.!?;:])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/^[ ,]+|[ ,]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, cut: out !== text.trim() };
}

export type FaqDraft = { q: string; a: string; cut: boolean };

/** The latest answer the store wrote and the visitor's message just before it, ready to check; null when none was answered. */
export function faqDraft(messages: readonly Said[], name: string): FaqDraft | null {
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].from !== "store") continue;
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].from !== "visitor") continue;
      const q = withoutWhoAsked(messages[j].text, name);
      const a = withoutWhoAsked(messages[i].text, name);
      const question = q.text.replace(/\s+/g, " ").trim();
      if (!question || !a.text) return null;
      return { q: question, a: a.text, cut: q.cut || a.cut };
    }
    return null;
  }
  return null;
}

export type FaqAddRefusal = "empty" | "long" | "full" | "same";

/** The store's questions with this one added at the end, or why it cannot be. */
export function faqAddition(current: readonly FaqItem[], raw: unknown): { ok: true; faq: FaqItem[] } | { ok: false; reason: FaqAddRefusal } {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const q = typeof v.q === "string" ? v.q.replace(/\s+/g, " ").trim() : "";
  const a = typeof v.a === "string" ? v.a.replace(/\r\n/g, "\n").trim() : "";
  if (!q || !a) return { ok: false, reason: "empty" };
  if (q.length > MAX_FAQ_Q || a.length > MAX_FAQ_A) return { ok: false, reason: "long" };
  if (current.length >= MAX_FAQ) return { ok: false, reason: "full" };
  if (current.some((item) => item.q.toLowerCase() === q.toLowerCase())) return { ok: false, reason: "same" };
  const faq = parseFaq([...current, { q, a }]);
  // parseFaq takes out control characters; what it keeps must still be this question, whole.
  if (faq.length !== current.length + 1) return { ok: false, reason: "empty" };
  return { ok: true, faq };
}

/** What the inbox says when a question cannot be added. */
export const FAQ_ADD_WORDS: Record<FaqAddRefusal, string> = {
  empty: "Write both the question and the answer.",
  long: `Shorten it: a question keeps up to ${MAX_FAQ_Q} characters and an answer up to ${MAX_FAQ_A}.`,
  full: `Your store page already shows ${MAX_FAQ} questions. Remove one under "Questions on your store page" in the studio, then add this one.`,
  same: "Your store page already has this question. Change its words, or edit the one there.",
};
