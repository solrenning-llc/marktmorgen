/**
 * A funnel of pages (added 12 October 2026): the store's own pages and its
 * products' pages, walked in an order the creator sets, from one address.
 *
 *   marktmorgen.com/@chef/go/launch  ->  a page that gives a guide for an
 *   email  ->  a video page  ->  the course's sales page  ->  after paying,
 *   the offers the course already has  ->  a last page of the creator's own
 *
 * Until this, every piece existed and nothing joined them: a landing page
 * could name one paid product next, a sales page led to its own checkout, and
 * the offers after paying ended on the store's thank-you page. Stan sells
 * funnels of up to 20 pages on its $99 plan; ClickFunnels' builder is the
 * whole of what it sells. This joins the pieces the store already has,
 * instead of being a second page builder beside them.
 *
 * Three rules keep it something a visitor can trust, and they are kept here so
 * the studio and every page apply the same ones:
 *
 *   - A step is a page that exists on its own: one of the store's own pages
 *     (lib/site-page-rules.ts) or a product's page. Nothing is drawn only for
 *     the funnel, so a visitor who leaves it has seen nothing they cannot open
 *     again, and nothing priced differently from the store.
 *   - Paying is never skipped and never added: a product step is its product's
 *     own page, with its own checkout, and the next step is offered after the
 *     thank-you page has handed over what was bought, never instead of it.
 *   - A visitor is never trapped. A paid step says "No thanks, continue", and
 *     a step that cannot be shown right now (a page kept back, a product taken
 *     off) is passed over rather than leading to nothing.
 *
 * Kept in a record of its own per store (lib/page-funnel-store.ts), read only
 * by a page opened with a funnel's mark (`?f=<id>`), its entry address and the
 * studio. Pure and browser-safe.
 */
import { SLUG_PATTERN, slugFrom } from "@/lib/site-page-rules";
import { type LiveShare, type SplitOption, liveShares, parseSplit, pickShare, splitVersion } from "@/lib/funnel-split-rules";

/** A page a visitor can land on: one of the store's own pages, or a product's page. */
export type FunnelPlace = {
  /** One of the store's own pages, or a product's page. */
  kind: "page" | "product";
  /** The page's id (lib/site-page-rules.ts) or the product's. */
  id: string;
};

/**
 * A "Split test" step (526 [FN2]; rules in lib/funnel-split-rules.ts): each
 * visitor goes to one of two to four of the store's pages or products, drawn
 * afresh at each visit by the shares. Its id names the step so its counts per
 * version can be kept apart later; which version a visitor saw needs no mark
 * of its own, because each page is in a funnel once, so the page they are on
 * says it.
 */
export type SplitStep = { kind: "split"; id: string; options: SplitOption[] };

export type PageFunnelStep = FunnelPlace | SplitStep;

export type PageFunnel = {
  id: string;
  /** What the creator calls it in the studio. Never shown to a visitor. */
  name: string;
  /** Its address: /@handle/go/<slug>. */
  slug: string;
  steps: PageFunnelStep[];
  /** Off keeps the draft; its funnel entry address is unavailable. */
  on: boolean;
  /** When its steps were last changed, in seconds: its numbers count from then. */
  since: number;
};

/** Funnels in one store, and pages in one funnel: the most Stan allows in one, twenty. */
export const MAX_PAGE_FUNNELS = 10;
export const MAX_FUNNEL_PAGES = 20;
export const MAX_FUNNEL_NAME = 60;
export const MAX_FUNNEL_SLUG = 40;
export const FUNNEL_ID = /^[a-z0-9]{10}$/;
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;
/** A split step's id: ten letters and digits, like a funnel's. */
export const SPLIT_ID = FUNNEL_ID;

/** The pages a step can land a visitor on: itself, or a split's destinations. */
export const stepPlaces = (step: PageFunnelStep): FunnelPlace[] =>
  step.kind === "split" ? step.options.map(({ kind, id }) => ({ kind, id })) : [{ kind: step.kind, id: step.id }];

/** Every page a funnel can land a visitor on, in order: each counts against MAX_FUNNEL_PAGES. */
export const funnelPlaces = (funnel: Pick<PageFunnel, "steps">): FunnelPlace[] => funnel.steps.flatMap(stepPlaces);

/** The mark a funnel's pages carry in their address, `?f=<id>`, read safely. */
export function funnelMark(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && FUNNEL_ID.test(value) ? value : "";
}

/** The mark read off the address of the page a form was sent from (the Referer), as lib/came-from.ts reads its tags. */
export function markFromReferer(referer: string | null, ownHost: string): string {
  if (!referer) return "";
  try {
    const url = new URL(referer);
    if (url.hostname.toLowerCase() !== ownHost.toLowerCase()) return "";
    return funnelMark(url.searchParams.get("f"));
  } catch {
    return "";
  }
}

const oneLine = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** An address made from a name, as a page's is. */
export const funnelSlugFrom = (name: string) => slugFrom(name).slice(0, MAX_FUNNEL_SLUG).replace(/-+$/g, "");

/** Why an address cannot be a funnel's, or null when it can. */
export function funnelSlugProblem(slug: string, others: readonly Pick<PageFunnel, "id" | "slug">[], self = ""): "slug" | "taken" | null {
  if (!slug || slug.length > MAX_FUNNEL_SLUG || !SLUG_PATTERN.test(slug)) return "slug";
  if (others.some((funnel) => funnel.slug === slug && funnel.id !== self)) return "taken";
  return null;
}

/**
 * Steps as stored or sent, made safe: the right shapes, each page or product
 * once across the whole funnel and its splits, twenty pages at most, a split's
 * destinations each counted as a page.
 */
export function parseSteps(raw: unknown): PageFunnelStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PageFunnelStep[] = [];
  const used = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    let step: PageFunnelStep | null = null;
    if (value.kind === "split") {
      const read = parseSplit(value);
      const id = typeof value.id === "string" && SPLIT_ID.test(value.id) ? value.id : "";
      if (read && id && !out.some((s) => s.kind === "split" && s.id === id)) step = { kind: "split", id, options: read.options };
    } else {
      const kind = value.kind === "page" || value.kind === "product" ? value.kind : null;
      const id = typeof value.id === "string" && STEP_ID.test(value.id) ? value.id : "";
      if (kind && id) step = { kind, id };
    }
    if (!step) continue;
    // Each page once: a funnel walks forward, and knowing where a visitor is
    // from the page they are on is what makes "next" mean one thing.
    const places = stepPlaces(step).map((place) => `${place.kind}:${place.id}`);
    if (places.some((place) => used.has(place))) continue;
    if (used.size + places.length > MAX_FUNNEL_PAGES) break;
    places.forEach((place) => used.add(place));
    out.push(step);
  }
  return out;
}

/** Funnels as stored, made safe to use: each id and address once, ten at most, each with at least one step. */
export function parsePageFunnels(raw: unknown): PageFunnel[] {
  if (!Array.isArray(raw)) return [];
  const out: PageFunnel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const id = typeof value.id === "string" && FUNNEL_ID.test(value.id) ? value.id : "";
    const name = oneLine(value.name, MAX_FUNNEL_NAME);
    const slug = typeof value.slug === "string" ? value.slug : "";
    const steps = parseSteps(value.steps);
    if (!id || !name || !steps.length || out.some((f) => f.id === id) || funnelSlugProblem(slug, out) !== null) continue;
    const since = typeof value.since === "number" && Number.isInteger(value.since) && value.since > 0 ? value.since : 0;
    out.push({ id, name, slug, steps, on: value.on !== false, since });
    if (out.length >= MAX_PAGE_FUNNELS) break;
  }
  return out;
}

/** Whether two lists of steps are the same pages in the same order: when they are not, the numbers start again. */
export function sameSteps(a: readonly PageFunnelStep[], b: readonly PageFunnelStep[]): boolean {
  // A split's other shares or destinations are another test: its numbers start again too.
  const same = (x: PageFunnelStep, y: PageFunnelStep) =>
    x.kind === "split" || y.kind === "split"
      ? x.kind === "split" && y.kind === "split" && x.id === y.id && x.options.length === y.options.length && x.options.every((o, i) => o.kind === y.options[i].kind && o.id === y.options[i].id && o.share === y.options[i].share)
      : x.kind === y.kind && x.id === y.id;
  return a.length === b.length && a.every((step, i) => same(step, b[i]));
}

/** Where a page or product sits in a funnel, or -1: a split's destination is at its split's place. */
export function stepIndex(funnel: Pick<PageFunnel, "steps">, kind: FunnelPlace["kind"], id: string): number {
  return funnel.steps.findIndex((step) => stepPlaces(step).some((place) => place.kind === kind && place.id === id));
}

/**
 * The version (a-d) a page is in a split step, or null when the step is not
 * a split or the page is not one of its destinations. Each page is in a
 * funnel once, so the page a visitor is on names the version they saw.
 */
export function placeVersion(step: PageFunnelStep, place: FunnelPlace | null | undefined): string | null {
  if (step.kind !== "split" || !place) return null;
  const at = step.options.findIndex((option) => option.kind === place.kind && option.id === place.id);
  return at < 0 ? null : splitVersion(at);
}

/**
 * The first step after `from` that can be shown right now, or -1 when there
 * is none: a step that cannot be (`open` says which page can) is passed over,
 * never a dead end; a split can be shown while one of its destinations can.
 * `from` -1 asks for the first step of all.
 */
export function nextOpen(funnel: Pick<PageFunnel, "steps">, from: number, open: (place: FunnelPlace) => boolean): number {
  for (let i = Math.max(-1, from) + 1; i < funnel.steps.length; i += 1) {
    if (stepPlaces(funnel.steps[i]).some(open)) return i;
  }
  return -1;
}

/**
 * The destination of a split a visitor goes to: the shares of those that can
 * be shown now (lib/funnel-split-rules.ts, liveShares), and the draw in
 * [0, 1) the caller took for this one visit. Null when none can be shown.
 */
export function splitPick(step: SplitStep, open: (place: FunnelPlace) => boolean, draw: number): LiveShare | null {
  return pickShare(liveShares(step.options, open), draw);
}

/** A funnel's address, `?f=<id>` added to a step's own address, keeping anything already on it. */
export function withMark(path: string, funnelId: string): string {
  const [base, hash = ""] = path.split("#");
  const joined = `${base}${base.includes("?") ? "&" : "?"}f=${funnelId}`;
  return hash ? `${joined}#${hash}` : joined;
}

/**
 * Why a product cannot be a step, or null when it can: one that has no page
 * of its own (a draft) or that is bought somewhere else than its page (a call,
 * booked for a time on its own page) cannot.
 */
export function productStepProblem(product: { hidden: boolean; call?: unknown } | null): "gone" | "hidden" | "call" | null {
  if (!product) return "gone";
  if (product.hidden) return "hidden";
  if (product.call) return "call";
  return null;
}

/** What a creator is told about a step that is being passed over. */
export const STEP_WHY: Record<"gone" | "hidden" | "call" | "page-gone" | "page-back", string> = {
  gone: "This product was deleted. Visitors go on to the next step.",
  hidden: "This product is a draft, so it has no page yet. Visitors go on to the next step until you publish it.",
  call: "A call is booked on a page of its own, so it cannot be a step. Visitors go on to the next step.",
  "page-gone": "This page was deleted. Visitors go on to the next step.",
  "page-back": "This page is kept from visitors. They go on to the next step until it is out.",
};

/** A new funnel's id: ten letters and digits, like a page's. */
export function newFunnelId(random: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 10 }, () => letters[random(letters.length)]).join("");
}

/** One funnel as the studio sends it, checked, with the store's other funnels to keep addresses apart. */
export function readFunnelInput(
  raw: unknown,
  others: readonly PageFunnel[],
  nowSeconds: number,
): { ok: true; funnel: PageFunnel } | { ok: false; error: "name" | "slug" | "taken" | "steps" | "split" | "full" } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "steps" };
  const value = raw as Record<string, unknown>;
  const asked = typeof value.id === "string" && FUNNEL_ID.test(value.id) ? value.id : "";
  const existing = asked ? others.find((f) => f.id === asked) ?? null : null;
  if (!existing && others.length >= MAX_PAGE_FUNNELS) return { ok: false, error: "full" };
  const name = oneLine(value.name, MAX_FUNNEL_NAME);
  if (!name) return { ok: false, error: "name" };
  const slug = typeof value.slug === "string" && value.slug.trim() ? value.slug.trim().toLowerCase() : funnelSlugFrom(name);
  const slugIssue = funnelSlugProblem(slug, others, existing?.id ?? "");
  if (slugIssue) return { ok: false, error: slugIssue };
  const sent = Array.isArray(value.steps) ? value.steps : [];
  // A split test sent without an id is a new one: it is given its own.
  const listed: unknown[] = [];
  let places = 0;
  for (const entry of sent) {
    const split = entry && typeof entry === "object" && (entry as { kind?: unknown }).kind === "split" ? (entry as Record<string, unknown>) : null;
    if (!split) {
      listed.push(entry);
      places += 1;
      continue;
    }
    const rules = parseSplit(split);
    if (!rules || (split.id !== undefined && (typeof split.id !== "string" || !SPLIT_ID.test(split.id)))) return { ok: false, error: "split" };
    listed.push({ ...split, id: typeof split.id === "string" ? split.id : newFunnelId() });
    places += rules.options.length;
  }
  const steps = parseSteps(listed);
  // Nothing typed is dropped quietly: a step that did not survive reading is a refusal.
  if (!steps.length || steps.length !== listed.length || places > MAX_FUNNEL_PAGES) {
    return { ok: false, error: "steps" };
  }
  const id = existing?.id ?? newFunnelId();
  const since = existing && sameSteps(existing.steps, steps) && existing.since > 0 ? existing.since : nowSeconds;
  return { ok: true, funnel: { id, name, slug, steps, on: value.on !== false, since } };
}
