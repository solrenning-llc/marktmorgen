/**
 * A whole funnel drafted with AI, and a summary of the creator's audience
 * from their own store's records (lib/funnel-ai-rules.ts has the rules). The
 * server side: reading the facts from the store, asking the model through
 * the same admission every draft goes through, and keeping only what the
 * rules allow.
 *
 * Admission is the writing help's own (lib/ai.ts): the month's jobs are
 * taken before any request (counted, weighted by funnelDraftJobs), each
 * request is bounded and reserves its reviewed spending ceiling before it is
 * sent (askModel), and an attempt that started stays counted even when it
 * fails. Nothing here saves anything: the draft goes back to the studio's
 * guided setup, which creates hidden pages and a disabled funnel only when
 * the creator presses its own button.
 */
import { type AiResult, askModel, counted, jsonIn, writingModel, writingRules } from "@/lib/ai";
import { idsOfKind, readListings } from "@/lib/catalog";
import { deliveryWords, missedQuestions, priceWords } from "@/lib/answers";
import { readAbout } from "@/lib/product-about";
import { summaryOf } from "@/lib/reviews";
import { average } from "@/lib/review-summary";
import { readStats } from "@/lib/stats";
import { isFree, type Store } from "@/lib/store";
import { productLink } from "@/lib/checkout-recovery";
import { storeBase } from "@/lib/purchase-email";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import { type FunnelType, choicesOf, pagesOf, slotProblem } from "@/lib/funnel-types";
import { MAX_FUNNEL_INTRO, readFunnelPageCopy, type FunnelPageCopy } from "@/lib/funnel-page-copy";
import { readFunnelFormDrafts, type FunnelDraftField, type FunnelFormDraft } from "@/lib/funnel-form-draft";
import { MAX_FIELDS, MAX_LABEL } from "@/lib/forms";
import { readDraftedSteps, type DraftedStep } from "@/lib/sequence-draft";
import { MAX_ANSWER, MAX_CTA_LABEL, MAX_FIT_ITEMS, MAX_HEADING, MAX_HEADLINE, MAX_ITEM, MAX_ITEM_DETAIL, MAX_QUESTION, MAX_STEPS, MAX_SUBHEADLINE, MAX_TEXT } from "@/lib/sales-page";
import {
  FUNNEL_AI_CALLS,
  FUNNEL_SEQUENCE_EMAILS,
  MAX_DRAFT_FAQ,
  MAX_FUNNEL_AUDIENCE,
  MAX_FUNNEL_OFFER,
  MAX_FUNNEL_PROOF,
  MAX_MISSING,
  MAX_MISSING_TEXT,
  MAX_OFFER_SUGGESTIONS,
  MAX_OFFER_WHY,
  SAMPLE_VIEWS,
  type FunnelAiDraft,
  type FunnelBlockCopy,
  type FunnelDiagnostic,
  type FunnelResearch,
  type FunnelSequenceDraft,
  type OfferSuggestion,
  type ResearchSource,
  followUpMoment,
  funnelDiagnostics,
  funnelDraftJobs,
  FUNNEL_RESEARCH_JOBS,
  knownNumbers,
  placeholdersIn,
  readFunnelBlockCopy,
  readResearch,
  withoutInventedNumbers,
} from "@/lib/funnel-ai-rules";

/** What the creator typed for this funnel. */
export type FunnelAsk = { audience: string; offer: string; proof: string; notes: string };

type ProductFact = {
  slot: string;
  role: string;
  id: string;
  title: string;
  price: string;
  delivery: string;
  summary: string;
  about: string;
  free: boolean;
  oneOff: boolean;
  draft: boolean;
  link: string;
  views: number | null;
  checkouts: number | null;
  reviews: { count: number; average: number } | null;
};

/** The store's own records a funnel is drafted from, read here, never sent by the browser. */
export type FunnelFacts = {
  type: FunnelType;
  picked: Record<string, string>;
  products: ProductFact[];
  /** Other products of the store that could be offered at checkout or after paying. */
  candidates: { id: string; title: string; price: string; link: string }[];
  /** What visitors asked these products' pages and the pages could not answer, newest first. */
  unanswered: { productId: string; question: string; at: number }[];
  storeLink: string;
  creator: string;
  storeName: string;
};

const MAX_CANDIDATES = 12;
const MAX_UNANSWERED = 8;
const ABOUT_IN_PROMPT = 900;

const clip = (value: unknown, max: number) =>
  (typeof value === "string" ? value : "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
const para = (value: unknown, max: number) =>
  (typeof value === "string" ? value : "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim();
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

/** What the creator typed, bounded as the box bounds it. */
export function readFunnelAsk(body: Record<string, unknown>): FunnelAsk {
  return {
    audience: para(body.audience, MAX_FUNNEL_AUDIENCE),
    offer: para(body.offer, MAX_FUNNEL_OFFER),
    proof: para(body.proof, MAX_FUNNEL_PROOF),
    notes: para(body.notes, MAX_AI_NOTES),
  };
}

/**
 * The products chosen for a type's steps, checked as the guided setup checks
 * them, and what the store knows about each. Read failures of numbers leave
 * them unknown (null), never zero.
 */
export async function readFunnelFacts(
  store: Store,
  type: FunnelType,
  chosen: Record<string, unknown>,
  now = Date.now(),
): Promise<{ ok: true; facts: FunnelFacts } | { ok: false; error: string; slot?: string }> {
  const free = new Set(idsOfKind(store, "free"));
  const calls = new Set(idsOfKind(store, "call"));
  const bundles = new Set(idsOfKind(store, "bundle"));
  const hidden = new Set(idsOfKind(store, "hidden"));
  const recurring = new Set(idsOfKind(store, "recurring"));
  const paid = new Set(idsOfKind(store, "paid"));
  const withOptions = new Set(store.catalog.items.filter((item) => item.options.length > 0).map((item) => item.id));
  const known = new Set(store.catalog.items.map((item) => item.id));
  const picked: Record<string, string> = {};
  for (const slot of choicesOf(type)) {
    const id = typeof chosen[slot.key] === "string" ? (chosen[slot.key] as string).slice(0, 40) : "";
    const problem = slotProblem(slot, id && known.has(id) ? { free: free.has(id), call: calls.has(id), bundle: bundles.has(id) } : null);
    if (problem) return { ok: false, error: `slot_${problem}`, slot: slot.key };
    if (Object.values(picked).includes(id)) return { ok: false, error: "slot_twice", slot: slot.key };
    picked[slot.key] = id;
  }
  const ids = Object.values(picked);
  const candidateIds = store.catalog.items
    .map((item) => item.id)
    .filter((id) => paid.has(id) && !hidden.has(id) && !calls.has(id) && !recurring.has(id) && !withOptions.has(id) && !ids.includes(id))
    .slice(0, MAX_CANDIDATES);
  const [listings, candidates, stats, missed] = await Promise.all([
    readListings(store, ids),
    readListings(store, candidateIds),
    readStats(store, now).catch(() => null),
    missedQuestions(store, 100).catch(() => []),
  ]);
  const products: ProductFact[] = [];
  for (const slot of choicesOf(type)) {
    const product = listings.find((p) => p.id === picked[slot.key]);
    if (!product) return { ok: false, error: "slot_missing", slot: slot.key };
    const [about, summary] = await Promise.all([
      product.about ? readAbout(store.statsId, product.id).catch(() => "") : Promise.resolve(""),
      summaryOf(store.statsId, product.id).catch(() => null),
    ]);
    const d30 = stats?.windows.d30;
    products.push({
      slot: slot.key,
      role: slot.label,
      id: product.id,
      title: product.title,
      price: priceWords(product, store.currency, store.tiers),
      delivery: deliveryWords(product, store.currency),
      summary: product.summary,
      about: para(about, ABOUT_IN_PROMPT),
      free: isFree(product),
      oneOff: !isFree(product) && !recurring.has(product.id) && !calls.has(product.id) && !withOptions.has(product.id),
      draft: hidden.has(product.id),
      link: productLink(store, product.id),
      views: d30 ? (d30.viewsByProduct[product.id] ?? 0) : null,
      checkouts: d30 ? (d30.checkoutsByProduct[product.id] ?? 0) : null,
      reviews: summary && summary.count > 0 ? { count: summary.count, average: average(summary) } : null,
    });
  }
  return {
    ok: true,
    facts: {
      type,
      picked,
      products,
      candidates: candidates.map((p) => ({ id: p.id, title: p.title, price: priceWords(p, store.currency, store.tiers), link: productLink(store, p.id) })),
      unanswered: missed.filter((row) => ids.includes(row.productId)).filter((row, i, all) => all.findIndex((r) => r.question === row.question) === i).slice(0, MAX_UNANSWERED),
      storeLink: storeBase(store),
      creator: clip(store.mail?.fromName || store.name, 60),
      storeName: clip(store.name, 80),
    },
  };
}

/** The deterministic checks every draft and research summary comes back with. */
export function diagnosticsFor(facts: FunnelFacts, ask: FunnelAsk): FunnelDiagnostic[] {
  return funnelDiagnostics({
    proof: ask.proof,
    products: facts.products.map((p) => ({ title: p.title, described: Boolean(p.summary.trim() || p.about.trim()), draft: p.draft, free: p.free, views: p.views, checkouts: p.checkouts })),
    unanswered: facts.unanswered.length,
  });
}

function productLines(facts: FunnelFacts): string {
  return facts.products
    .map((p) =>
      [
        `- Step "${p.role}" (id ${p.id}): ${clip(p.title, 120)}`,
        `  Price: ${clip(p.price, 160)}`,
        `  How it is delivered: ${clip(p.delivery, 240)}`,
        p.summary ? `  Summary: ${clip(p.summary, 240)}` : "",
        p.about ? `  Description, in the creator's words: ${clip(p.about, ABOUT_IN_PROMPT)}` : "",
        `  Its page: ${p.link}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

function askLines(ask: FunnelAsk): string {
  return [
    ask.audience ? `Who it is for, in the creator's words:\n${ask.audience}` : "",
    ask.offer ? `What they get, in the creator's words:\n${ask.offer}` : "",
    ask.proof ? `Proof you have, in the creator's words (the only proof that may be used):\n${ask.proof}` : "Proof you have: none given.",
    ask.notes ? `Anything else the creator wants:\n${ask.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const NO_INVENTION = [
  "Use only the proof the creator wrote under 'Proof you have', in their words, as a fact about them. If none is given, write no proof at all: no testimonial, review, quote, result, rating, or number of students, buyers, followers or sales.",
  "Write no number that the facts below do not contain. Never invent a statistic, a percentage, a market size or a comparison with anyone else.",
  "Never invent urgency or scarcity: no deadline, countdown, 'today only', 'limited spots' or 'only a few left'. A recorded training is called recorded, never live.",
  "Never write about the creator's life, credentials or story: you were not told them. Where a page needs a fact only the creator has, write a short instruction to them inside ⟦ and ⟧ instead, like ⟦Add one sentence about who you are⟧. Never put ⟦ ⟧ in a button.",
].join("\n");

function pagesRequest(facts: FunnelFacts, ask: FunnelAsk): { system: string; prompt: string } {
  const pages = pagesOf(facts.type);
  const fields = (blocks: string[]) =>
    [
      `"headline": at most 90 characters`,
      `"intro": one or two short paragraphs, at most 500 characters, what the visitor finds on this page and why it is for them`,
      blocks.includes("hero") ? `"sub": at most 200 characters, under the headline` : "",
      blocks.includes("text") ? `"text": {"heading": at most 60 characters, "body": at most 1,200 characters}` : "",
      blocks.includes("steps") ? `"steps": {"heading": at most 60 characters, "items": 3 to 5 of {"title": at most 80 characters, "detail": at most 160 characters}} — what happens next, in order` : "",
      blocks.includes("fit") ? `"fit": {"yes": 3 to 5 short lines, who it is for, "no": 2 to 4, who it is not for}` : "",
      blocks.includes("faq") ? `"faq": 3 to 5 of {"q": at most 120 characters, "a": at most 400 characters}, answered only from the facts` : "",
      blocks.includes("cta") ? `"cta": the button's words, at most 30 characters, no price` : "",
    ]
      .filter(Boolean)
      .join("; ");
  const system = [
    "You draft the pages of a creator's funnel: the words of each page it makes, the questions its form asks, and which of the creator's own products could be offered at checkout or right after paying.",
    writingRules("English"),
    NO_INVENTION,
    [
      "Return only a JSON object:",
      `"pages": {${pages.map((page) => `"${page.key}": {${fields(page.blocks)}}`).join(", ")}}${pages.length ? "" : " (an empty object: this funnel makes no pages)"}.`,
      pages.some((page) => page.form)
        ? `"forms": {${pages.filter((page) => page.form).map((page) => `"${page.key}": [2 to 6 of {"type": "short" | "long" | "email", "label": at most 120 characters, "required": true | false}]`).join(", ")}} — questions anyone would answer at that step; one of them asks for the email address; never ask for a password, payment details, health, or other sensitive personal information.`
        : "",
      `"offers": up to ${MAX_OFFER_SUGGESTIONS} of {"kind": "bump" (a box at the checkout of a paid step) or "after" (offered right after paying for a paid step), "for": the id of a paid step product, "offer": the id of a different product from "Other products", "why": at most 140 characters, from the facts}. Only where one clearly goes with the other; an empty list is fine.`,
      `"missing": up to ${MAX_MISSING} short notes of facts the creator should add for these pages to be complete.`,
    ]
      .filter(Boolean)
      .join("\n"),
  ].join("\n\n");
  const prompt = [
    `Store: ${facts.storeName}`,
    `Funnel: ${facts.type.label}. ${facts.type.hint}`,
    pages.length ? `Pages it makes:\n${pages.map((page) => `- "${page.key}": titled "${page.title}", blocks in order: ${page.blocks.join(", ")}`).join("\n")}` : "",
    facts.products.length ? `The products of its steps:\n${productLines(facts)}` : "",
    facts.candidates.length ? `Other products (may be offered):\n${facts.candidates.map((p) => `- id ${p.id}: ${clip(p.title, 120)} (${clip(p.price, 120)})`).join("\n")}` : "Other products: none.",
    facts.unanswered.length ? `Questions visitors asked these pages that the pages could not answer:\n${facts.unanswered.map((row) => `- ${clip(row.question, 200)}`).join("\n")}` : "",
    askLines(ask),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}

const MOMENT = {
  product: "the days after somebody got the product named below from the creator: how to make the most of it, then, only where it fits, the next step of the funnel",
  form: "the days after somebody sent the creator's form on the funnel's page with their email address: a thank you and what happens next, something useful, then, only where it fits, what the creator sells",
} as const;

function emailsRequest(facts: FunnelFacts, ask: FunnelAsk, moment: NonNullable<ReturnType<typeof followUpMoment>>): { system: string; prompt: string; links: string[] } {
  const links = [facts.storeLink, ...facts.products.map((p) => p.link), ...facts.candidates.map((p) => p.link)];
  const followed = moment.trigger === "product" ? facts.products.find((p) => p.id === moment.productId) : null;
  const system = [
    `You write ${FUNNEL_SEQUENCE_EMAILS} emails that go out by themselves, one after another, from a creator to one person who asked to hear from them, for ${MOMENT[moment.trigger]}.`,
    writingRules("English"),
    NO_INVENTION,
    "Write as the creator, in the first person. Each email does one thing and is short. Use only the web addresses listed, exactly as given, each on its own line. Sell gently: what a product is, who it is for and where it is, at the price given.",
    `Return only a JSON object: {"emails": [{"waitDays": number, "subject": string, "body": string}]} with exactly ${FUNNEL_SEQUENCE_EMAILS} emails. The first waits 0 days, each later one 1 to 7 days after the one before. Subjects at most 70 characters, no clickbait. Bodies plain text, at most 1,200 characters, signed with the creator's name. Do not add an unsubscribe line: one is added to every email.`,
  ].join("\n\n");
  const prompt = [
    `Creator: ${facts.creator}`,
    `Store: ${facts.storeName} ${facts.storeLink}`,
    `Funnel: ${facts.type.label}`,
    followed ? `The product this sequence follows: ${clip(followed.title, 120)} (${clip(followed.price, 120)}) ${followed.link}` : "",
    facts.products.length ? `The funnel's products:\n${productLines(facts)}` : "",
    facts.candidates.length ? `Other products:\n${facts.candidates.map((p) => `- ${clip(p.title, 120)} (${clip(p.price, 120)}) ${p.link}`).join("\n")}` : "",
    askLines(ask),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt, links };
}

/** Within a call's input bound, or refused before anything is counted. */
const fits = (request: { system: string; prompt: string }, bound: { inputBytes: number }) => bytes(request.system) + bytes(request.prompt) <= bound.inputBytes;

/** The model's pages, forms and offers, kept only where the rules allow. */
export function readPagesAnswer(json: Record<string, unknown> | null, facts: FunnelFacts, ask: FunnelAsk): Pick<FunnelAiDraft, "pageCopy" | "blockCopy" | "formDrafts" | "offers" | "missing"> | null {
  if (!json) return null;
  const known = knownNumbers(
    facts.storeName,
    facts.creator,
    ...facts.products.flatMap((p) => [p.title, p.price, p.delivery, p.summary, p.about]),
    ...facts.candidates.flatMap((p) => [p.title, p.price]),
    ...facts.unanswered.map((row) => row.question),
    ask.audience,
    ask.offer,
    ask.proof,
    ask.notes,
  );
  const words = (value: unknown, max: number) => withoutInventedNumbers(clip(value, max * 2), known).slice(0, max).trim();
  const body = (value: unknown, max: number) => withoutInventedNumbers(para(value, max * 2), known).slice(0, max).trim();
  const pages = record(json.pages);
  const pageCopy: Record<string, FunnelPageCopy> = {};
  const blockCopy: Record<string, FunnelBlockCopy> = {};
  for (const slot of pagesOf(facts.type)) {
    const page = record(pages[slot.key]);
    pageCopy[slot.key] = { headline: words(page.headline, MAX_HEADLINE) || slot.title, intro: body(page.intro, MAX_FUNNEL_INTRO) };
    const copy: FunnelBlockCopy = {};
    const has = (kind: string) => (slot.blocks as string[]).includes(kind);
    if (has("hero")) {
      const sub = words(page.sub, MAX_SUBHEADLINE);
      if (sub) copy.sub = sub;
    }
    if (has("text")) {
      const text = record(page.text);
      const content = body(text.body, MAX_TEXT);
      if (content) copy.text = { heading: words(text.heading, MAX_HEADING), body: content };
    }
    if (has("steps")) {
      const steps = record(page.steps);
      const items = list(steps.items)
        .map((item) => ({ title: words(record(item).title, MAX_ITEM), detail: words(record(item).detail, MAX_ITEM_DETAIL) }))
        .filter((item) => item.title)
        .slice(0, MAX_STEPS);
      if (items.length) copy.steps = { heading: words(steps.heading, MAX_HEADING), items };
    }
    if (has("fit")) {
      const fit = record(page.fit);
      const lines = (value: unknown) => list(value).map((item) => words(item, MAX_ITEM)).filter(Boolean).slice(0, MAX_FIT_ITEMS);
      const yes = lines(fit.yes);
      if (yes.length) copy.fit = { yes, no: lines(fit.no) };
    }
    if (has("faq")) {
      const faq = list(page.faq)
        .map((item) => ({ q: words(record(item).q, MAX_QUESTION), a: body(record(item).a, MAX_ANSWER) }))
        .filter((item) => item.q && item.a)
        .slice(0, MAX_DRAFT_FAQ);
      if (faq.length) copy.faq = faq;
    }
    if (has("cta")) {
      // A button never states a price (lib/sales-page.ts) and is never a direction.
      const cta = words(page.cta, MAX_CTA_LABEL).replace(/\s*\b(?:for|at|only)?\s*[$€£¥]\s*\d[\d.,]*/gi, "").trim();
      if (cta && !placeholdersIn(cta).length) copy.cta = cta;
    }
    if (Object.keys(copy).length) blockCopy[slot.key] = copy;
  }
  const forms = record(json.forms);
  const formDrafts: Record<string, FunnelFormDraft> = {};
  for (const slot of pagesOf(facts.type)) {
    if (!slot.form || !slot.blocks.includes("form")) continue;
    const fields: FunnelDraftField[] = [];
    for (const raw of list(forms[slot.key])) {
      const field = record(raw);
      const type = field.type === "short" || field.type === "long" || field.type === "email" ? field.type : null;
      const label = clip(field.label, MAX_LABEL);
      // A question is asked of a visitor: never a direction to the creator, never twice.
      if (!type || !label || placeholdersIn(label).length || fields.some((f) => f.label.toLowerCase() === label.toLowerCase())) continue;
      if (type === "email" && fields.some((f) => f.type === "email")) continue;
      fields.push({ type, label, required: field.required === true || type === "email" });
      if (fields.length >= Math.min(6, MAX_FIELDS)) break;
    }
    const wantsEmail = slot.form.fields.find((f) => f.type === "email");
    if (fields.length && wantsEmail && !fields.some((f) => f.type === "email")) fields.unshift({ ...wantsEmail });
    // Subscribing is the visitor's choice, offered only when the creator turns it on.
    formDrafts[slot.key] = { fields: fields.length ? fields : slot.form.fields.map((f) => ({ ...f })), offerList: false };
  }
  const paidSteps = new Set(facts.products.filter((p) => p.oneOff).map((p) => p.id));
  const others = new Set(facts.candidates.map((p) => p.id));
  const offers: OfferSuggestion[] = [];
  for (const raw of list(json.offers)) {
    const offer = record(raw);
    const kind = offer.kind === "bump" || offer.kind === "after" ? offer.kind : null;
    const forId = typeof offer.for === "string" ? offer.for : "";
    const offerId = typeof offer.offer === "string" ? offer.offer : "";
    if (!kind || !paidSteps.has(forId) || !others.has(offerId) || offers.some((o) => o.kind === kind && o.for === forId && o.offer === offerId)) continue;
    offers.push({ kind, for: forId, offer: offerId, why: words(offer.why, MAX_OFFER_WHY) });
    if (offers.length >= MAX_OFFER_SUGGESTIONS) break;
  }
  // What only the creator can add, said by the store whatever the model says.
  const theirs = pagesOf(facts.type).flatMap((slot) => [
    ...(slot.blocks.includes("video") ? [`Add your recorded video to “${slot.title}”.`] : []),
    ...(slot.blocks.includes("bio") ? [`Write a few sentences about yourself in the “About you” block of “${slot.title}”.`] : []),
  ]);
  if (facts.type.id === "quiz") theirs.push("Write the quiz's choices and results in Forms after the funnel is created.");
  const missing = [...theirs, ...list(json.missing).map((m) => words(m, MAX_MISSING_TEXT)).filter(Boolean)]
    .filter((m, i, all) => all.indexOf(m) === i)
    .slice(0, MAX_MISSING);
  // The same readers the guided setup's route reads with; anything they refuse is not offered.
  const checkedPages = readFunnelPageCopy(pageCopy, facts.type);
  const checkedBlocks = readFunnelBlockCopy(blockCopy, facts.type);
  const checkedForms = readFunnelFormDrafts(formDrafts, facts.type);
  if (!checkedPages || !checkedBlocks || !checkedForms) return null;
  return { pageCopy: checkedPages, blockCopy: checkedBlocks, formDrafts: checkedForms, offers, missing };
}

/** The model's follow-up emails: only the store's links, bounded waits, no invented numbers. */
export function readEmailsAnswer(json: Record<string, unknown> | null, facts: FunnelFacts, ask: FunnelAsk, links: readonly string[]): DraftedStep[] {
  const known = knownNumbers(facts.storeName, facts.creator, ...facts.products.flatMap((p) => [p.title, p.price, p.summary, p.about]), ...facts.candidates.flatMap((p) => [p.title, p.price]), ask.audience, ask.offer, ask.proof, ask.notes);
  return readDraftedSteps(json?.emails, FUNNEL_SEQUENCE_EMAILS, links)
    .map((step) => ({ ...step, subject: withoutInventedNumbers(step.subject, known), body: withoutInventedNumbers(step.body, known) }))
    .filter((step) => step.subject && step.body);
}

/**
 * A whole funnel's first draft: its pages' words, its form's questions,
 * offers from the creator's own products and, when asked for, the emails
 * that follow it. funnelDraftJobs(withEmails) of the month's jobs, taken
 * before either request is sent.
 */
export async function writeFunnelDraft(
  store: Store,
  facts: FunnelFacts,
  ask: FunnelAsk,
  withEmails: boolean,
  now = Date.now(),
): Promise<AiResult<FunnelAiDraft> | { ok: false; reason: "long" }> {
  const pages = pagesRequest(facts, ask);
  if (!fits(pages, FUNNEL_AI_CALLS.pages)) return { ok: false, reason: "long" };
  const moment = withEmails ? followUpMoment(facts.type, facts.picked) : null;
  const emails = moment ? emailsRequest(facts, ask, moment) : null;
  if (emails && !fits(emails, FUNNEL_AI_CALLS.emails)) return { ok: false, reason: "long" };
  const diagnostics = diagnosticsFor(facts, ask);
  return counted(
    store,
    now,
    async () => {
      const [pagesAnswer, emailsAnswer] = await Promise.all([
        askModel(store, pages.system, pages.prompt, FUNNEL_AI_CALLS.pages.outputTokens, writingModel()),
        emails ? askModel(store, emails.system, emails.prompt, FUNNEL_AI_CALLS.emails.outputTokens, writingModel()) : Promise.resolve(null),
      ]);
      const drafted = readPagesAnswer(pagesAnswer ? jsonIn(pagesAnswer) : null, facts, ask);
      if (!drafted) return null;
      let sequence: FunnelSequenceDraft | null = null;
      if (moment && emails) {
        const steps = readEmailsAnswer(emailsAnswer ? jsonIn(emailsAnswer) : null, facts, ask, emails.links);
        if (steps.length) sequence = moment.trigger === "product" ? { trigger: "product", productId: moment.productId, formSlot: null, steps } : { trigger: "form", productId: null, formSlot: moment.slot, steps };
      }
      const missing = withEmails && !sequence ? [...drafted.missing, "The follow-up emails could not be drafted this time. Write them in the Email Studio."].slice(0, MAX_MISSING) : drafted.missing;
      return { type: facts.type.id, ...drafted, missing, sequence, diagnostics };
    },
    funnelDraftJobs(Boolean(emails)),
  );
}

/**
 * The store's own records the research reads, each dated: what the creator
 * typed today, each step's product as saved, its verified reviews, its last
 * 30 days of visits, and the questions visitors asked that its page could
 * not answer, with when each was asked. Nothing from the web.
 */
export function researchSources(facts: FunnelFacts, ask: FunnelAsk, now = Date.now()): ResearchSource[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const sources: ResearchSource[] = [];
  const typed = askLines(ask);
  if (ask.audience || ask.offer || ask.proof || ask.notes) sources.push({ id: "A1", label: "What you typed for this funnel", date: today, detail: typed });
  facts.products.forEach((p, i) => {
    sources.push({ id: `P${i + 1}`, label: `“${p.title}” as saved in your store`, date: today, detail: [`Price: ${p.price}`, `Delivery: ${p.delivery}`, p.summary ? `Summary: ${p.summary}` : "", p.about ? `Description: ${p.about}` : ""].filter(Boolean).join("\n") });
    if (p.reviews) sources.push({ id: `R${i + 1}`, label: `Verified reviews of “${p.title}”`, date: today, detail: `${p.reviews.count} verified ${p.reviews.count === 1 ? "review" : "reviews"}, average ${p.reviews.average.toFixed(1)} of 5 stars.` });
    if (p.views !== null) sources.push({ id: `T${i + 1}`, label: `Visits to “${p.title}”, last 30 days`, date: today, detail: `Opened ${p.views} times${p.free ? "" : `; ${p.checkouts ?? 0} checkouts started`}.` });
  });
  facts.unanswered.forEach((row, i) => {
    const product = facts.products.find((p) => p.id === row.productId);
    sources.push({ id: `Q${i + 1}`, label: `A visitor's question the page of “${product?.title ?? "a product"}” could not answer`, date: row.at > 0 ? day(row.at) : today, detail: row.question });
  });
  return sources;
}

/** What the store itself says the summary cannot tell. */
export function researchLimits(facts: FunnelFacts): string[] {
  const views = facts.products.reduce((sum, p) => (p.views === null || sum === null ? null : sum + p.views), 0 as number | null);
  return [
    "Only your store's own records and what you typed were read. Nothing was searched on the web, so nothing here describes your market, competitors or trends.",
    views === null ? "Visit counts could not be read, so nothing here is based on traffic." : views < SAMPLE_VIEWS ? `These pages were opened ${views} times in the last 30 days in total: too few to say what visitors want.` : "Visits show what people opened, not why they bought or left.",
    "Reviews and questions come from people who already found your store, not from everyone you could reach.",
  ];
}

/**
 * Who the funnel is for and how its offer is positioned, from the dated
 * sources above only (F04). FUNNEL_RESEARCH_JOBS of the month's jobs.
 */
export async function writeFunnelResearch(store: Store, facts: FunnelFacts, ask: FunnelAsk, now = Date.now()): Promise<AiResult<FunnelResearch & { diagnostics: FunnelDiagnostic[] }> | { ok: false; reason: "long" }> {
  const sources = researchSources(facts, ask, now);
  const informative = sources.filter((s) => s.id !== "A1" && !s.id.startsWith("T") && !(s.id.startsWith("P") && !/Summary:|Description:/.test(s.detail)));
  if (!ask.audience && !ask.offer && !informative.length) return { ok: false, reason: "notes" };
  const system = [
    "You summarize who a creator's audience is and how their offer is positioned, for the funnel described, using ONLY the numbered sources given. They are the creator's own store records and the creator's own words.",
    writingRules("English"),
    "Never add a statistic, a percentage, a market size, a competitor, a trend, a quote or a fact that is not in the sources. Never guess at demographics. Where the sources are thin, say so instead of filling the gap.",
    `Return only a JSON object: {"audience": at most 400 characters, who these sources show the buyers are and what they want; "positioning": at most 400 characters, how the offer is described and what sets it apart in the sources' own terms; "claims": up to 8 of {"text": at most 200 characters, one statement, "source": the id of the one source that states it}; "uncertainty": up to 3 short notes on what the sources cannot tell}.`,
  ].join("\n\n");
  const prompt = [`Store: ${facts.storeName}`, `Funnel: ${facts.type.label}. ${facts.type.hint}`, "Sources:", ...sources.map((s) => `[${s.id}] ${s.label} (${s.date}):\n${clip(s.detail, 1_500)}`)].join("\n\n");
  if (!fits({ system, prompt }, FUNNEL_AI_CALLS.research)) return { ok: false, reason: "long" };
  const diagnostics = diagnosticsFor(facts, ask);
  return counted(
    store,
    now,
    async () => {
      const answer = await askModel(store, system, prompt, FUNNEL_AI_CALLS.research.outputTokens, writingModel());
      const research = readResearch(answer ? jsonIn(answer) : null, sources, researchLimits(facts));
      return research ? { ...research, diagnostics } : null;
    },
    FUNNEL_RESEARCH_JOBS,
  );
}
