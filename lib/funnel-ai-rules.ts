/**
 * A whole funnel drafted with AI (added 17 October 2026), as rules the
 * studio's browser reads too. The part that asks the model is
 * lib/funnel-ai.ts; the structures it fills are the guided setup's own
 * (lib/funnel-types.ts, lib/funnel-page-copy.ts, lib/funnel-form-draft.ts),
 * so a drafted funnel is created by the same route, with the same checks, as
 * one typed by hand: hidden pages, a disabled funnel, nothing published.
 *
 * ClickFunnels' "Build with AI" writes a funnel from a conversation and has a
 * research mode that proposes an audience. What this one adds for a creator
 * who has to stand behind every word:
 *
 *   - It drafts from the creator's own records: the products chosen for each
 *     step, as saved, with their real prices; the audience, offer and proof
 *     typed in the box. It never invents a testimonial, a result, a number, a
 *     deadline or a quantity left, and a sentence carrying a number that none
 *     of those facts carries is removed before the creator sees it.
 *   - Where a fact only the creator has is needed, the draft says so in a
 *     placeholder ⟦like this⟧. A page still holding one cannot be shown to
 *     visitors (app/api/store/site-page), and a sequence still holding one
 *     cannot be saved (lib/flows.ts), so a direction is never published as
 *     the creator's words.
 *   - The research mode reads only the store's own dated records, never the
 *     web, and every statement it keeps cites one of them.
 *   - What it costs is said before it runs, in the same monthly AI uses as
 *     every other draft, weighted by each request's spending hold
 *     (funnelDraftJobs); each request also reserves that hold from the
 *     plan's monthly AI budget before it is sent (lib/ai.ts, askModel).
 *
 * Pure and browser-safe.
 */
import { type FunnelType, pagesOf } from "@/lib/funnel-types";
import { type FunnelPageCopy, readFunnelPageCopy } from "@/lib/funnel-page-copy";
import { type FunnelFormDraft, readFunnelFormDrafts } from "@/lib/funnel-form-draft";
import { MAX_ANSWER, MAX_CTA_LABEL, MAX_FIT_ITEMS, MAX_HEADING, MAX_ITEM, MAX_ITEM_DETAIL, MAX_QUESTION, MAX_STEPS, MAX_SUBHEADLINE, MAX_TEXT } from "@/lib/sales-page";
import { numbersIn } from "@/lib/block-rewrite-rules";
import { replaceUntilStable } from "@/lib/plain-text";
import { isAiSequenceDraft } from "@/lib/ai-response";
import type { DraftedStep } from "@/lib/sequence-draft";
import { WRITING_JOB_MICRO_USD, WRITING_JOB_REFERENCE, aiRequestHoldMicroUsd } from "@/lib/spend-cost-table";

// ------------------------------------------------------------------ cost

/**
 * A request's weight in the month's writing jobs: the most it can cost, as
 * the spending hold computes it before the fetch (lib/spend-cost-table.ts,
 * aiRequestHoldMicroUsd, at the writing model's rates), divided by the
 * priced writing job and rounded up. It is weighed by its own bounds, never
 * by what it happened to use, so a draft's weight is known, and said, before
 * it runs.
 */
export type AiCallBound = { outputTokens: number; inputBytes: number };

/** How many of the month's jobs one request of these bounds counts as: at least one. */
export function jobsForCall(call: AiCallBound): number {
  const hold = aiRequestHoldMicroUsd(WRITING_JOB_REFERENCE.model, { inputBytes: call.inputBytes, blocks: 1, media: null, maxTokens: call.outputTokens });
  if (hold === null || !Number.isSafeInteger(call.inputBytes) || call.inputBytes < 1) return Number.NaN;
  return Math.max(1, Math.ceil(hold / WRITING_JOB_MICRO_USD));
}

/**
 * The requests a draft makes, each refused before it is counted when its
 * instructions and facts would be longer than its bound (lib/funnel-ai.ts).
 * The pages, forms and offers in one request; the follow-up emails in a
 * second, only when asked for; the research in one of its own.
 */
export const FUNNEL_AI_CALLS = {
  pages: { outputTokens: 4_500, inputBytes: 16_384 },
  emails: { outputTokens: 3_000, inputBytes: 12_288 },
  research: { outputTokens: 2_000, inputBytes: 12_288 },
} as const satisfies Record<string, AiCallBound>;

/** The month's AI uses a funnel draft takes, said before it runs. */
export function funnelDraftJobs(withEmails: boolean): number {
  return jobsForCall(FUNNEL_AI_CALLS.pages) + (withEmails ? jobsForCall(FUNNEL_AI_CALLS.emails) : 0);
}

/** The month's AI uses the research summary takes. */
export const FUNNEL_RESEARCH_JOBS = jobsForCall(FUNNEL_AI_CALLS.research);

/** What the creator types, at most. */
export const MAX_FUNNEL_AUDIENCE = 600;
export const MAX_FUNNEL_OFFER = 600;
export const MAX_FUNNEL_PROOF = 600;

/** Emails in the follow-up sequence drafted with a funnel. */
export const FUNNEL_SEQUENCE_EMAILS = 3;
/** Offers suggested for checkout or after paying, at most. */
export const MAX_OFFER_SUGGESTIONS = 4;
export const MAX_OFFER_WHY = 200;
/** Facts the draft says the creator should add, at most. */
export const MAX_MISSING = 6;
export const MAX_MISSING_TEXT = 200;
/** Questions answered on one drafted page, at most. */
export const MAX_DRAFT_FAQ = 6;

// ------------------------------------------------------------------ honesty checks

/** A part left for the creator to write, as email templates mark it (lib/mail-body.ts). */
export const PLACEHOLDER_PATTERN = /⟦[^⟧\n]*⟧/g;

const ADDRESS = /https?:\/\/\S+/g;

export function placeholdersIn(text: string): string[] {
  return text.match(PLACEHOLDER_PATTERN) ?? [];
}

/**
 * The text without any sentence that carries a number none of the facts
 * carries. Numbers inside a placeholder are directions, not claims, and are
 * not read. Whole sentences go, so nothing is left half-saying something.
 */
export function withoutInventedNumbers(text: string, known: ReadonlySet<string>): string {
  if (!text) return "";
  const kept: string[] = [];
  for (const paragraph of text.split("\n")) {
    // A sentence ends at a stop followed by a space, so "$27.00" and an address stay whole.
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    // An address is where a link leads, not a claim: its digits are not read.
    const ok = sentences.filter((sentence) => [...numbersIn(sentence.replace(PLACEHOLDER_PATTERN, "").replace(ADDRESS, ""))].every((n) => known.has(n)));
    kept.push(ok.join(" ").trim());
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Every number a set of facts carries, as numbersIn reads them, and a price's whole units too ("$27.00" is also "$27"). */
export function knownNumbers(...facts: string[]): Set<string> {
  const known = new Set<string>();
  for (const raw of facts.flatMap((fact) => fact.match(/\d[\d.,]*/g) ?? [])) {
    const number = raw.replace(/[.,]+$/, "");
    known.add(number.replace(/[.,]/g, ""));
    known.add(number.replace(/[.,]\d{1,2}$/, "").replace(/[.,]/g, ""));
  }
  return known;
}

// ------------------------------------------------------------------ the draft

/**
 * The words a drafted page's blocks start with, beyond its headline and
 * introduction (FunnelPageCopy): each only where the page's type has that
 * block (lib/funnel-types.ts), each held to the block's own limits.
 */
export type FunnelBlockCopy = {
  /** The hero's line under the headline. */
  sub?: string;
  /** The page's first text block. */
  text?: { heading: string; body: string };
  steps?: { heading: string; items: { title: string; detail: string }[] };
  fit?: { yes: string[]; no: string[] };
  faq?: { q: string; a: string }[];
  /** The button's words. */
  cta?: string;
};

const BLOCK_FIELDS: Record<keyof FunnelBlockCopy, string> = { sub: "hero", text: "text", steps: "steps", fit: "fit", faq: "faq", cta: "cta" };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const str = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value);
const textList = (value: unknown, maxItems: number, max: number): value is string[] => Array.isArray(value) && value.length <= maxItems && value.every((item) => str(item, max) && item.trim() !== "");

/** Strict reader for setup input: any key, field or length out of place refuses the whole. */
export function readFunnelBlockCopy(raw: unknown, type: FunnelType): Record<string, FunnelBlockCopy> | null {
  if (raw === undefined) return {};
  if (!record(raw)) return null;
  const result: Record<string, FunnelBlockCopy> = {};
  for (const [key, value] of Object.entries(raw)) {
    const slot = pagesOf(type).find((page) => page.key === key);
    if (!slot || !record(value) || !only(value, Object.keys(BLOCK_FIELDS))) return null;
    for (const field of Object.keys(value) as (keyof FunnelBlockCopy)[]) {
      if (!(slot.blocks as string[]).includes(BLOCK_FIELDS[field])) return null;
    }
    const copy: FunnelBlockCopy = {};
    if (value.sub !== undefined) {
      if (!str(value.sub, MAX_SUBHEADLINE)) return null;
      copy.sub = value.sub.trim();
    }
    if (value.text !== undefined) {
      const text = value.text;
      if (!record(text) || !only(text, ["heading", "body"]) || !str(text.heading, MAX_HEADING) || typeof text.body !== "string" || text.body.length > MAX_TEXT) return null;
      copy.text = { heading: text.heading.trim(), body: text.body.replace(/\r\n?/g, "\n").trim() };
    }
    if (value.steps !== undefined) {
      const steps = value.steps;
      if (!record(steps) || !only(steps, ["heading", "items"]) || !str(steps.heading, MAX_HEADING) || !Array.isArray(steps.items) || steps.items.length > MAX_STEPS) return null;
      const items: { title: string; detail: string }[] = [];
      for (const item of steps.items) {
        if (!record(item) || !only(item, ["title", "detail"]) || !str(item.title, MAX_ITEM) || !item.title.trim() || !str(item.detail, MAX_ITEM_DETAIL)) return null;
        items.push({ title: item.title.trim(), detail: item.detail.trim() });
      }
      copy.steps = { heading: steps.heading.trim(), items };
    }
    if (value.fit !== undefined) {
      const fit = value.fit;
      if (!record(fit) || !only(fit, ["yes", "no"]) || !textList(fit.yes, MAX_FIT_ITEMS, MAX_ITEM) || !textList(fit.no, MAX_FIT_ITEMS, MAX_ITEM)) return null;
      copy.fit = { yes: fit.yes.map((item) => item.trim()), no: fit.no.map((item) => item.trim()) };
    }
    if (value.faq !== undefined) {
      if (!Array.isArray(value.faq) || value.faq.length > MAX_DRAFT_FAQ) return null;
      const faq: { q: string; a: string }[] = [];
      for (const item of value.faq) {
        if (!record(item) || !only(item, ["q", "a"]) || !str(item.q, MAX_QUESTION) || !item.q.trim() || typeof item.a !== "string" || item.a.length > MAX_ANSWER || !item.a.trim()) return null;
        faq.push({ q: item.q.trim(), a: item.a.replace(/\r\n?/g, "\n").trim() });
      }
      copy.faq = faq;
    }
    if (value.cta !== undefined) {
      // A button is never a placeholder: it is pressed, not read.
      if (!str(value.cta, MAX_CTA_LABEL) || placeholdersIn(value.cta).length) return null;
      copy.cta = value.cta.trim();
    }
    result[key] = copy;
  }
  return result;
}

/** One of the creator's own products, suggested for checkout (a bump) or right after paying. Never set up by itself. */
export type OfferSuggestion = { kind: "bump" | "after"; for: string; offer: string; why: string };

/**
 * The follow-up emails, for the moment the funnel's journey starts them
 * (followUpMoment). Saved only when the creator chooses, switched off, as a
 * sequence in the Email Studio.
 */
export type FunnelSequenceDraft = {
  trigger: "product" | "form";
  /** The product whose getting starts it, for "product". */
  productId: string | null;
  /** The funnel page whose form starts it, for "form": its form exists once the funnel is created. */
  formSlot: string | null;
  steps: DraftedStep[];
};

/** A check made from the store's own records before anything is written: never a causal claim. */
export type FunnelDiagnostic = { code: "no_proof" | "thin_product" | "draft_product" | "unanswered" | "small_sample" | "traffic"; text: string };

export type FunnelAiDraft = {
  type: string;
  pageCopy: Record<string, FunnelPageCopy>;
  blockCopy: Record<string, FunnelBlockCopy>;
  formDrafts: Record<string, FunnelFormDraft>;
  offers: OfferSuggestion[];
  sequence: FunnelSequenceDraft | null;
  /** Facts the draft says the creator should add. */
  missing: string[];
  diagnostics: FunnelDiagnostic[];
};

/** The slot the follow-up sequence starts from: a free product got, else a form sent, else the last product got. */
export function followUpMoment(type: FunnelType, picked: Readonly<Record<string, string>>): { trigger: "product"; slot: string; productId: string } | { trigger: "form"; slot: string } | null {
  const products = type.slots.filter((slot) => slot.kind === "product");
  const free = products.find((slot) => slot.kind === "product" && slot.wants === "free" && picked[slot.key]);
  if (free) return { trigger: "product", slot: free.key, productId: picked[free.key] };
  const form = pagesOf(type).find((page) => page.form && page.blocks.includes("form") && page.form.fields.some((field) => field.type === "email"));
  if (form) return { trigger: "form", slot: form.key };
  const last = [...products].reverse().find((slot) => picked[slot.key]);
  return last ? { trigger: "product", slot: last.key, productId: picked[last.key] } : null;
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The whole draft, checked before the studio maps any of it into the setup. */
export function isFunnelAiDraft(value: unknown, type: FunnelType): value is FunnelAiDraft {
  if (!record(value) || value.type !== type.id) return false;
  if (readFunnelPageCopy(value.pageCopy, type) === null || value.pageCopy === undefined) return false;
  if (readFunnelBlockCopy(value.blockCopy, type) === null || value.blockCopy === undefined) return false;
  const forms = readFunnelFormDrafts(value.formDrafts, type);
  if (forms === null || value.formDrafts === undefined || Object.values(forms).some((form) => form.offerList)) return false;
  if (!Array.isArray(value.offers) || value.offers.length > MAX_OFFER_SUGGESTIONS) return false;
  for (const offer of value.offers) {
    if (!record(offer) || (offer.kind !== "bump" && offer.kind !== "after") || typeof offer.for !== "string" || !ID.test(offer.for) || typeof offer.offer !== "string" || !ID.test(offer.offer) || offer.for === offer.offer || !str(offer.why, MAX_OFFER_WHY)) return false;
  }
  if (value.sequence !== null) {
    const sequence = value.sequence;
    if (!record(sequence) || !isAiSequenceDraft(sequence.steps) || (sequence.steps as unknown[]).length > FUNNEL_SEQUENCE_EMAILS) return false;
    if (sequence.trigger === "product" ? !(typeof sequence.productId === "string" && ID.test(sequence.productId) && sequence.formSlot === null) : sequence.trigger === "form" ? !(sequence.productId === null && pagesOf(type).some((page) => page.key === sequence.formSlot && page.form)) : true) return false;
  }
  if (!textList(value.missing, MAX_MISSING, MAX_MISSING_TEXT)) return false;
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 12 || !value.diagnostics.every((d) => record(d) && typeof d.code === "string" && str(d.text, 400))) return false;
  return true;
}

/**
 * What the store's own records say before any draft is written (F54's first
 * step: deterministic, sample-aware, never a guess at why). A page opened
 * fewer than SAMPLE_VIEWS times in 30 days is too few to read anything into.
 */
export const SAMPLE_VIEWS = 30;

export type DiagnosticFacts = {
  proof: string;
  products: { title: string; described: boolean; draft: boolean; free: boolean; views: number | null; checkouts: number | null }[];
  unanswered: number;
};

export function funnelDiagnostics(facts: DiagnosticFacts): FunnelDiagnostic[] {
  const out: FunnelDiagnostic[] = [];
  if (!facts.proof.trim()) out.push({ code: "no_proof", text: "No proof was given, so the draft has no testimonials, results or numbers about buyers. Add verified reviews, or things people said in public with a link, once you have them." });
  for (const product of facts.products) {
    if (!product.described) out.push({ code: "thin_product", text: `“${product.title}” has no summary or description yet, so the draft can only use its name, price and how it is delivered.` });
    if (product.draft) out.push({ code: "draft_product", text: `“${product.title}” is a draft. A funnel passes over it until you publish it.` });
    if (product.views === null) continue;
    if (product.views < SAMPLE_VIEWS) out.push({ code: "small_sample", text: `“${product.title}” was opened ${product.views.toLocaleString("en-US")} ${product.views === 1 ? "time" : "times"} in the last 30 days: too few to judge how its page converts.` });
    else if (product.checkouts !== null && !product.free) out.push({ code: "traffic", text: `“${product.title}” was opened ${product.views.toLocaleString("en-US")} times in the last 30 days and ${product.checkouts.toLocaleString("en-US")} checkouts were started. This counts visits; it does not say why people did or did not buy.` });
  }
  if (facts.unanswered > 0) out.push({ code: "unanswered", text: `Visitors asked ${facts.unanswered.toLocaleString("en-US")} ${facts.unanswered === 1 ? "question" : "questions"} your pages could not answer. The draft is given them, so its questions and answers can cover them.` });
  return out.slice(0, 12);
}

// ------------------------------------------------------------------ research

/** One of the store's own records the research reads, dated by when it was read or happened. */
export type ResearchSource = { id: string; label: string; date: string; detail: string };

export type FunnelResearch = {
  audience: string;
  positioning: string;
  /** Each statement kept cites one source by id. */
  claims: { text: string; source: string }[];
  /** What the summary cannot tell, said by the store as well as by the model. */
  uncertainty: string[];
  sources: ResearchSource[];
  /** It never searches the web: said, not left to be assumed. */
  webSearch: false;
};

export const MAX_RESEARCH_CLAIMS = 8;
export const MAX_RESEARCH_TEXT = 600;
export const MAX_CLAIM_TEXT = 240;
const SOURCE_ID = /^[A-Z][0-9]{1,2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The model's summary, kept only where the sources hold it: a statement
 * citing a source that was not given, or carrying a number its source does
 * not, is dropped; a sentence of the summary with a number no source carries
 * is dropped. Dates and sources are the store's, never the model's.
 */
export function readResearch(raw: Record<string, unknown> | null, sources: readonly ResearchSource[], uncertain: readonly string[]): FunnelResearch | null {
  if (!raw) return null;
  const all = knownNumbers(...sources.map((s) => `${s.label} ${s.detail}`));
  const clean = (value: unknown, max: number) => withoutInventedNumbers((typeof value === "string" ? value : "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(), all).slice(0, max);
  const claims = (Array.isArray(raw.claims) ? raw.claims : [])
    .map((claim) => (record(claim) ? claim : {}))
    .map((claim) => {
      const source = sources.find((s) => s.id === claim.source);
      if (!source) return null;
      const text = typeof claim.text === "string" ? claim.text.replace(/\s+/g, " ").trim().slice(0, MAX_CLAIM_TEXT) : "";
      if (!text || [...numbersIn(text)].some((n) => !knownNumbers(`${source.label} ${source.detail}`).has(n))) return null;
      return { text, source: source.id };
    })
    .filter((claim): claim is { text: string; source: string } => claim !== null)
    .slice(0, MAX_RESEARCH_CLAIMS);
  const audience = clean(raw.audience, MAX_RESEARCH_TEXT);
  const positioning = clean(raw.positioning, MAX_RESEARCH_TEXT);
  const theirs = (Array.isArray(raw.uncertainty) ? raw.uncertainty : []).map((u) => clean(u, 240)).filter(Boolean).slice(0, 4);
  if (!audience && !positioning && !claims.length) return null;
  return { audience, positioning, claims, uncertainty: [...uncertain, ...theirs].slice(0, 8), sources: [...sources], webSearch: false };
}

export function isFunnelResearch(value: unknown): value is FunnelResearch {
  if (!record(value) || value.webSearch !== false || !str(value.audience, MAX_RESEARCH_TEXT) || !str(value.positioning, MAX_RESEARCH_TEXT)) return false;
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 30) return false;
  const ids = new Set<string>();
  for (const source of value.sources) {
    if (!record(source) || typeof source.id !== "string" || !SOURCE_ID.test(source.id) || ids.has(source.id) || !str(source.label, 200) || typeof source.date !== "string" || !DAY.test(source.date) || typeof source.detail !== "string" || source.detail.length > 4_000) return false;
    ids.add(source.id);
  }
  if (!Array.isArray(value.claims) || value.claims.length > MAX_RESEARCH_CLAIMS || !value.claims.every((c) => record(c) && str(c.text, MAX_CLAIM_TEXT) && typeof c.source === "string" && ids.has(c.source))) return false;
  return textList(value.uncertainty, 8, 400);
}

/** A price in a button's words, with the "for", "at" or "only" before it. */
const BUTTON_PRICE = /\s*\b(?:for|at|only)?\s*[$€£¥]\s*\d[\d.,]*/gi;

/**
 * A button's words without a price (a button never states one: lib/sales-page.ts).
 * Taken out until none is left, so a price that taking another out puts back
 * together ("Get it$5.$9" leaves "Get it$9" after one pass) goes too.
 */
export function withoutButtonPrice(label: string): string {
  return replaceUntilStable(label, BUTTON_PRICE, "").trim();
}
