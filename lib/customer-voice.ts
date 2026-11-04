/**
 * What customers are saying (added 12 October 2026): the month's words from
 * a store's customers, sorted by a model into the few themes they repeat,
 * each with how many said it and their own words beside it.
 *
 * Read before it was built: ChartMogul AI pulls the reasons for cancelling
 * out of notes and emails; Contentsquare's Voice of Customer (Hotjar) writes
 * an AI summary of open answers with their sentiment; Baremetrics'
 * Cancellation Insights groups the reasons members give; Amplitude's
 * feedback agent groups feedback into themes and sends them on a schedule.
 * Here four lists the studio already keeps, each shown on its own, are read
 * together:
 *
 *   - what members wrote when canceling (lib/membership-numbers.ts);
 *   - questions a product page or the store's guide could not answer
 *     (lib/answers.ts);
 *   - the words of reviews (lib/reviews.ts);
 *   - what was searched for on the store and found nothing (lib/stats.ts).
 *
 * From the last 90 days. The model only sorts: it is handed the texts by
 * number and returns a short name for each theme and the numbers that belong
 * to it. The counts are worked out here from those numbers, and the
 * examples shown are the texts themselves, so nothing a creator reads under
 * a theme was written by the model except its name.
 *
 * Nobody is named. The texts go without a name, and any email address, phone
 * number or web address in them is taken out before they are sent.
 *
 * One of the month's AI jobs (lib/ai.ts, counted), on the smaller model,
 * made only when the creator asks, at most once a calendar month, and only
 * when there are at least MIN_TEXTS texts to sort.
 *
 *   nl:voice:<statsId>:<yyyy-mm>   the month's summary, about two months
 *   nl:voice:lock:<statsId>         one reading at a time, a minute
 */
import { answerModel, askModel, counted, jsonIn } from "@/lib/ai";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { membershipNumbers } from "@/lib/membership-numbers";
import { sellsMemberships } from "@/lib/membership-manage";
import { STORE_PAGE, missedQuestions } from "@/lib/answers";
import { studioReviews } from "@/lib/reviews";
import { readStats, studioStats } from "@/lib/stats";
import { readTitles } from "@/lib/catalog";
import type { Store } from "@/lib/store";

export type VoiceSource = "cancel" | "question" | "review" | "search";
export const VOICE_SOURCES: VoiceSource[] = ["cancel", "question", "review", "search"];

/** One text from a customer, as the model is handed it, by its number. */
export type VoiceItem = {
  id: number;
  source: VoiceSource;
  text: string;
  /** How many it stands for: one, or how many times a search found nothing. */
  n: number;
  /** The product it is about, by title, when there is one. */
  product?: string;
  /** A review's stars. */
  stars?: number;
};

export type VoiceTheme = {
  title: string;
  /** How many said it: the texts sorted under it, a search counted as many times as it was made. */
  count: number;
  sources: Partial<Record<VoiceSource, number>>;
  /** Up to three of the texts themselves. */
  examples: { source: VoiceSource; text: string; n: number; product?: string; stars?: number }[];
};

export type VoiceSummary = {
  /** When it was read, in seconds. */
  at: number;
  month: string;
  /** How many texts were read, by where they came from. */
  read: Partial<Record<VoiceSource, number>>;
  themes: VoiceTheme[];
  /**
   * The themes reviews are part of, picked before the themes above are cut to
   * MAX_THEMES (searches, counted as many times as they were made, can take
   * every place there), with up to three reviews as their examples. The
   * reviews page reads these. Missing on a summary made before they were kept.
   */
  reviewThemes?: VoiceTheme[];
  /** Texts that fit no theme said by two or more. */
  other: number;
};

export const DAYS = 90;
/** Fewer texts than this, and there is nothing worth sorting. */
export const MIN_TEXTS = 8;
/** The most texts sent: the newest of each list, so one month's job stays small. */
export const MAX_TEXTS = 160;
const MAX_TEXT = 300;
export const MAX_THEMES = 6;
const MAX_TITLE = 60;
const KEEP_SECONDS = 70 * 86_400;

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const voiceKey = (statsId: string, month: string) => `nl:voice:${statsId}:${month}`;
const lockKey = (statsId: string) => `nl:voice:lock:${statsId}`;

/** A text as it may be sent: one line, short, with addresses, phone numbers and links taken out. Pure. */
export function cleanVoice(value: string, max = MAX_TEXT): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** The texts of the last 90 days, newest first in each list, numbered from 1. */
export async function gatherVoice(store: Store, now = Date.now()): Promise<VoiceItem[]> {
  const since = Math.floor(now / 1000) - DAYS * 86_400;
  const items: Omit<VoiceItem, "id">[] = [];
  const titles = await readTitles(store).catch(() => new Map<string, string>());
  const titleOf = (id: string) => (id === STORE_PAGE ? "the store page" : titles.get(id));

  if (store.stripeAccountId && sellsMemberships(store)) {
    const numbers = await membershipNumbers(store).catch(() => null);
    for (const c of numbers?.leaving?.recent ?? []) {
      if (c.at >= since) items.push({ source: "cancel", text: c.text, n: 1 });
    }
  }
  for (const q of await missedQuestions(store, 50).catch(() => [])) {
    if (q.at >= since) items.push({ source: "question", text: q.question, n: 1, product: titleOf(q.productId) });
  }
  const reviews = await studioReviews(store.statsId, { queue: false, offset: 0, limit: 100 }).catch(() => ({ rows: [] }));
  for (const r of reviews.rows) {
    if (r.createdAt / 1000 >= since && r.text.trim()) items.push({ source: "review", text: r.text, n: 1, product: titleOf(r.productId), stars: r.rating });
  }
  const stats = await readStats(store, now).catch(() => null);
  if (stats) {
    for (const row of studioStats(store, stats, null, "none", []).searchMisses?.d90 ?? []) {
      if (row.name.trim()) items.push({ source: "search", text: row.name, n: Math.max(1, row.visits) });
    }
  }

  const out: VoiceItem[] = [];
  for (const item of items) {
    const text = cleanVoice(item.text);
    if (text.replace(/\[(email|link|number)\]/g, "").trim().length < 2) continue;
    out.push({ ...item, text, id: out.length + 1 });
    if (out.length >= MAX_TEXTS) break;
  }
  return out;
}

/** What the model is handed: each text by its number, where it came from, and nothing else. Pure. */
export function voicePrompt(items: VoiceItem[]): string {
  const where: Record<VoiceSource, string> = {
    cancel: "a member, when canceling",
    question: "a visitor's question the page could not answer",
    review: "a buyer's review",
    search: "words searched for on the store that found nothing",
  };
  return items
    .map((i) => `[${i.id}] (${where[i.source]}${i.product ? `, about ${cleanVoice(i.product, 80)}` : ""}${i.stars ? `, ${i.stars} of 5 stars` : ""}${i.n > 1 ? `, searched ${i.n} times` : ""}) ${i.text}`)
    .join("\n");
}

/**
 * The themes, from what the model returned: each with a short name and the
 * numbers of its texts. A number not handed to it, or already in an earlier
 * theme, is dropped; a theme left with fewer than two texts, or a name with a
 * figure in it, is dropped too. Counts and examples come from the texts. Pure.
 */
export function themesFrom(raw: Record<string, unknown> | null, items: VoiceItem[]): { themes: VoiceTheme[]; reviewThemes: VoiceTheme[]; other: number } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const used = new Set<number>();
  const themes: VoiceTheme[] = [];
  const reviewThemes: VoiceTheme[] = [];
  const examplesOf = (list: VoiceItem[]) =>
    [...list]
      .sort((a, b) => b.n - a.n || a.id - b.id)
      .slice(0, 3)
      .map((i) => ({ source: i.source, text: i.text, n: i.n, ...(i.product ? { product: i.product } : {}), ...(i.stars ? { stars: i.stars } : {}) }));
  const listed = Array.isArray(raw?.themes) ? (raw.themes as unknown[]) : [];
  for (const entry of listed) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { title?: unknown; ids?: unknown };
    const title = typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : "";
    if (!title || /\d/.test(title)) continue;
    const ids = (Array.isArray(value.ids) ? value.ids : []).map(Number).filter((id) => Number.isInteger(id) && byId.has(id) && !used.has(id));
    const mine = [...new Set(ids)].map((id) => byId.get(id)!);
    if (mine.length < 2) continue;
    for (const item of mine) used.add(item.id);
    const sources: Partial<Record<VoiceSource, number>> = {};
    for (const item of mine) sources[item.source] = (sources[item.source] ?? 0) + item.n;
    const count = mine.reduce((sum, item) => sum + item.n, 0);
    themes.push({ title, count, sources, examples: examplesOf(mine) });
    const reviews = mine.filter((item) => item.source === "review");
    if (reviews.length) reviewThemes.push({ title, count, sources, examples: examplesOf(reviews) });
  }
  themes.sort((a, b) => b.count - a.count);
  reviewThemes.sort((a, b) => (b.sources.review ?? 0) - (a.sources.review ?? 0) || b.count - a.count);
  const kept = themes.slice(0, MAX_THEMES);
  const inKept = kept.reduce((sum, t) => sum + t.count, 0);
  const all = items.reduce((sum, i) => sum + i.n, 0);
  return { themes: kept, reviewThemes: reviewThemes.slice(0, MAX_THEMES), other: Math.max(0, all - inKept) };
}

/** How many texts of each kind were read. Pure. */
export function readBySource(items: VoiceItem[]): Partial<Record<VoiceSource, number>> {
  const out: Partial<Record<VoiceSource, number>> = {};
  for (const item of items) out[item.source] = (out[item.source] ?? 0) + item.n;
  return out;
}

function parseSummary(raw: unknown): VoiceSummary | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as VoiceSummary;
    return value && Array.isArray(value.themes) && typeof value.month === "string" ? value : null;
  } catch {
    return null;
  }
}

/** This month's summary, or last month's while this month has none yet. */
export async function readVoice(store: Store, now = Date.now()): Promise<VoiceSummary | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const date = new Date(now);
  const last = monthOf(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  const [mine, before] = await redisPipeline([
    ["GET", voiceKey(store.statsId, monthOf(now))],
    ["GET", voiceKey(store.statsId, last)],
  ]);
  return parseSummary(mine) ?? parseSummary(before);
}

export type VoiceResult =
  | { ok: true; summary: VoiceSummary; fresh: boolean; left: number | null }
  | { ok: false; reason: "few" | "busy" | "off" | "used" | "failed"; texts?: number };

/**
 * This month's summary: the one already made, or, when there is none and
 * enough to sort, made now as one of the month's AI jobs.
 */
export async function makeVoice(store: Store, now = Date.now()): Promise<VoiceResult> {
  if (!store.statsId || !isRedisConfigured()) return { ok: false, reason: "off" };
  const month = monthOf(now);
  const [kept] = await redisPipeline([["GET", voiceKey(store.statsId, month)]]);
  const already = parseSummary(kept);
  if (already) return { ok: true, summary: already, fresh: false, left: null };
  const [claimed] = await redisPipeline([["SET", lockKey(store.statsId), "1", "NX", "EX", 60]]);
  if (claimed === null) return { ok: false, reason: "busy" };
  try {
    const items = await gatherVoice(store, now);
    if (items.length < MIN_TEXTS) return { ok: false, reason: "few", texts: items.length };
    const done = await counted(store, now, async () => {
      const system = [
        "You sort what an online store's customers wrote into the few themes they repeat.",
        "You are given numbered texts: words members wrote when canceling, questions a product page could not answer, reviews, and words searched for on the store that found nothing.",
        `Group texts that say the same thing into at most ${MAX_THEMES} themes. A theme needs at least two texts. Leave out texts that fit no theme. Each text goes in one theme at most.`,
        "Name each theme in plain American English, at most 8 words, saying what customers said or wanted (for example: \"Wants a printable version\", \"Price feels high for what is inside\"). No numbers in a name, no judgment of the customers, nothing that is not in the texts.",
        "Return only a JSON object: {\"themes\": [{\"title\": string, \"ids\": [numbers of its texts]}]}, the most repeated theme first.",
      ].join("\n\n");
      const reply = await askModel(store, system, voicePrompt(items), 900, answerModel());
      const json = reply ? jsonIn(reply) : null;
      if (!json) return null;
      const sorted = themesFrom(json, items);
      const summary: VoiceSummary = { at: Math.floor(now / 1000), month, read: readBySource(items), themes: sorted.themes, reviewThemes: sorted.reviewThemes, other: sorted.other };
      return summary;
    });
    if (!done.ok) return { ok: false, reason: done.reason === "notes" ? "failed" : done.reason };
    await redisPipeline([["SET", voiceKey(store.statsId, month), JSON.stringify(done.value), "EX", KEEP_SECONDS]]);
    return { ok: true, summary: done.value, fresh: true, left: done.left };
  } finally {
    await redisPipeline([["DEL", lockKey(store.statsId)]]).catch(() => {});
  }
}
