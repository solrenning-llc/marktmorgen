/**
 * A funnel as one portable file (added 17 October 2026): its pages, their
 * blocks, the forms they ask, the order of its steps and their settings, in
 * a versioned format another store can bring in as a draft.
 *
 * ClickFunnels shares a funnel by link and the copy becomes the other
 * account's own. This does the same between Marktmorgen stores, and from a
 * file, with three rules that keep it safe to accept from anybody:
 *
 *   - Nothing of the sender's comes across but the words and the shape. No
 *     picture or file (they are the sender's storage), no customer, contact,
 *     answer, review, order, number or price, and no product: each product the
 *     funnel names becomes a placeholder ("x1") that the receiver maps to one
 *     of their own products, or leaves out. When it is shared with another
 *     store, what is about the sender in person goes too: the about text, the
 *     refund promise, the videos, the deadline and the things said about the
 *     sender elsewhere. The receiver is told what to fill in.
 *   - It is read strictly. The format and its schema version must be known, a
 *     block must be one a store's own page may hold, a block or a field that
 *     is not in the format is refused rather than dropped, sizes are capped,
 *     and nothing that looks like a script or markup is accepted, even though
 *     pages never read text as markup (lib/sales-page.ts).
 *   - What comes in is a draft: its pages kept back from visitors and out of
 *     the menu, the funnel off, until the receiver has made it theirs.
 *
 * Pure and browser-safe: the studio's preview and the routes read the same
 * rules. lib/funnel-bundle-store.ts reads a store's funnel and writes one in.
 */
import {
  BLOCK_ID_PATTERN,
  MAX_BLOCKS,
  MAX_PAGE_BYTES,
  PAGE_STYLES,
  emptyBlock,
  newBlockId,
  parsePage,
  picturePaths,
  type BlockKind,
  type PageBlock,
  type PageStyle,
  type SalesPage,
} from "@/lib/sales-page";
import { MAX_SITE_PAGES, MAX_SITE_TITLE, SITE_KINDS, SLUG_PATTERN, MAX_SLUG, type SitePage } from "@/lib/site-page-rules";
import { MAX_FUNNEL_NAME, MAX_FUNNEL_PAGES, type PageFunnelStep } from "@/lib/page-funnel";
import { MAX_FORMS, newFormId, parseForm, tierIssues, type FormDef } from "@/lib/forms";
import { sensitiveFieldOf } from "@/lib/form-sensitive";

export const BUNDLE_FORMAT = "marktmorgen-funnel";
/** The version of the format written now. A file of a later version is refused with a word of its own, so an older app never half-reads it. */
export const BUNDLE_SCHEMA = 1;
/** Forms in one funnel, and the products it may name. */
export const MAX_BUNDLE_FORMS = 10;
export const MAX_BUNDLE_PRODUCTS = 20;
export const MAX_PRODUCT_LABEL = 80;

/** A placeholder for one of the sender's products, mapped by the receiver to one of theirs. */
export type BundleProduct = { ref: string; label: string; wants: "free" | "paid" };
export type BundleStep = { kind: PageFunnelStep["kind"]; ref: string };
/** One of the funnel's pages: its blocks refer to products and forms by placeholder. */
export type BundlePage = { ref: string; title: string; slug: string; target: string; style: PageStyle; blocks: PageBlock[] };
/** A form a page asks, without its id or its answers; a result's product is a placeholder. */
export type BundleForm = { ref: string } & Omit<FormDef, "id" | "updatedAt">;

export type FunnelBundle = {
  format: typeof BUNDLE_FORMAT;
  schema: typeof BUNDLE_SCHEMA;
  name: string;
  steps: BundleStep[];
  pages: BundlePage[];
  forms: BundleForm[];
  products: BundleProduct[];
};

const PRODUCT_REF = /^x[1-9][0-9]?$/;
const PAGE_REF = /^p[1-9][0-9]?$/;
const FORM_REF = /^f[1-9][0-9]?$/;

/** Text that is never accepted in a file, wherever it sits: tags that run or embed something, and addresses that run code. */
const UNSAFE = /<\s*\/?\s*(script|iframe|object|embed|style|link|meta|svg|img|form|input|base)\b|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|\bon[a-z]+\s*=/i;

/** Whether any string anywhere in a value carries something UNSAFE. */
export function hasUnsafeText(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "string") return UNSAFE.test(value);
  if (Array.isArray(value)) return value.some((item) => hasUnsafeText(item, depth + 1));
  if (value && typeof value === "object") return Object.entries(value).some(([key, item]) => UNSAFE.test(key) || hasUnsafeText(item, depth + 1));
  return false;
}

/** The fields each kind of block may carry in a file: those its empty block has, the screens it shows on, and a hero's two extras. */
function allowedKeys(kind: BlockKind): Set<string> {
  const keys = new Set(Object.keys(emptyBlock(kind, "aaaa")));
  keys.add("screens");
  if (kind === "hero") {
    keys.add("layout");
    keys.add("button");
  }
  return keys;
}

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

// ---- Writing one -----------------------------------------------------------

/** What a store's funnel is made of, as read for a file (lib/funnel-bundle-store.ts gathers it). */
export type BundleSource = {
  name: string;
  steps: PageFunnelStep[];
  pages: Map<string, { meta: SitePage; page: SalesPage }>;
  forms: Map<string, FormDef>;
  products: Map<string, { title: string; free: boolean; call: boolean }>;
};

/** What was left out of a file, counted so the sender is told. */
export type LeftOut = {
  pictures: number;
  videos: number;
  bios: number;
  guarantees: number;
  countdowns: number;
  quotes: number;
  reviewPicks: number;
  /** Steps whose page or product no longer exists. */
  steps: number;
  /** Product cards or button targets naming a product the store no longer has. */
  products: number;
  /** Form blocks naming a form the store no longer has. */
  forms: number;
};

const emptyLeft = (): LeftOut => ({ pictures: 0, videos: 0, bios: 0, guarantees: 0, countdowns: 0, quotes: 0, reviewPicks: 0, steps: 0, products: 0, forms: 0 });

/**
 * A store's funnel as a file. `mode` "share" leaves out what is about the
 * sender in person (above); "own" is a copy for the same creator, which
 * keeps it: inside the same store, or (18 October 2026) into another store
 * of the same account, where all of it is still theirs. Pictures are left out either way: a picture belongs to the one
 * page that shows it (lib/sales-page-store.ts) and is deleted with it.
 */
export function buildBundle(source: BundleSource, mode: "share" | "own"): { bundle: FunnelBundle; left: LeftOut; productIds: Record<string, string> } {
  const left = emptyLeft();
  const products: BundleProduct[] = [];
  const productIds: string[] = [];
  const productRef = (id: string): string => {
    const known = source.products.get(id);
    if (!id || !known) return "";
    const at = productIds.indexOf(id);
    if (at >= 0) return products[at].ref;
    if (products.length >= MAX_BUNDLE_PRODUCTS) return "";
    const ref = `x${products.length + 1}`;
    productIds.push(id);
    // The sender's product title, which their store page already shows, to say what each placeholder stood for.
    products.push({ ref, label: known.title.replace(/\s+/g, " ").trim().slice(0, MAX_PRODUCT_LABEL) || "A product", wants: known.free ? "free" : "paid" });
    return ref;
  };
  const forms: BundleForm[] = [];
  const formIds: string[] = [];
  const formRef = (id: string): string => {
    const form = source.forms.get(id);
    if (!id || !form) return "";
    const at = formIds.indexOf(id);
    if (at >= 0) return forms[at].ref;
    if (forms.length >= MAX_BUNDLE_FORMS) return "";
    const ref = `f${forms.length + 1}`;
    formIds.push(id);
    const { id: _id, updatedAt: _at, ...rest } = form;
    void _id;
    void _at;
    forms.push({ ref, ...rest, outcomes: rest.outcomes.map((outcome) => ({ ...outcome, product: outcome.product ? productRef(outcome.product) : "" })) });
    return ref;
  };

  const steps: BundleStep[] = [];
  const pages: BundlePage[] = [];
  for (const step of source.steps.slice(0, MAX_FUNNEL_PAGES)) {
    if (step.kind === "product") {
      // A call is booked on a page of its own and never a step; checked first, so it is not named in the file for nothing.
      const ref = source.products.get(step.id)?.call ? "" : productRef(step.id);
      if (!ref || steps.some((s) => s.kind === "product" && s.ref === ref)) {
        left.steps += 1;
        continue;
      }
      steps.push({ kind: "product", ref });
      continue;
    }
    const found = source.pages.get(step.id);
    if (!found || pages.length >= MAX_SITE_PAGES) {
      left.steps += 1;
      continue;
    }
    const blocks: PageBlock[] = [];
    for (const original of found.page.blocks.filter((block) => SITE_KINDS.includes(block.kind))) {
      const block = { ...original, id: newBlockId() } as PageBlock;
      delete block.saved;
      if (block.kind === "pictures") {
        left.pictures += block.items.length;
        block.items = [];
      }
      if (block.kind === "feature" && block.picture) {
        left.pictures += 1;
        block.picture = null;
      }
      if (block.kind === "product") {
        const ref = productRef(block.product);
        if (block.product && !ref) left.products += 1;
        block.product = ref;
      }
      if (block.kind === "form") {
        const ref = formRef(block.form);
        if (block.form && !ref) left.forms += 1;
        block.form = ref;
      }
      if (mode === "share") {
        if (block.kind === "countdown") {
          left.countdowns += 1;
          continue;
        }
        if ((block.kind === "hero" || block.kind === "video") && block.video) {
          left.videos += 1;
          block.video = null;
          if (block.kind === "hero" && block.media === "video") block.media = "none";
        }
        if (block.kind === "bio" && block.body) {
          left.bios += 1;
          block.body = "";
        }
        if (block.kind === "guarantee" && block.body) {
          left.guarantees += 1;
          block.body = "";
        }
        if (block.kind === "quotes" && block.items.length) {
          left.quotes += block.items.length;
          block.items = [];
        }
        if (block.kind === "reviews" && block.first.length) {
          left.reviewPicks += block.first.length;
          block.first = [];
        }
      }
      blocks.push(block);
    }
    const target = found.meta.target ? productRef(found.meta.target) : "";
    if (found.meta.target && !target) left.products += 1;
    const ref = `p${pages.length + 1}`;
    pages.push({ ref, title: found.meta.title, slug: found.meta.slug, target, style: found.page.style, blocks });
    steps.push({ kind: "page", ref });
  }
  return {
    bundle: { format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name: source.name.slice(0, MAX_FUNNEL_NAME), steps, pages, forms, products },
    left,
    // Which of the store's products each placeholder stands for: for a copy inside the store, never written into the file.
    productIds: Object.fromEntries(products.map((p, i) => [p.ref, productIds[i]])),
  };
}

/** The sentences that tell the sender what their file leaves out. */
export function leftOutWords(left: LeftOut): string[] {
  const n = (count: number, one: string, many: string) => (count === 1 ? one : many.replace("#", String(count)));
  const out: string[] = [];
  if (left.pictures) out.push(n(left.pictures, "1 picture stays on your page; pictures are never shared.", "# pictures stay on your pages; pictures are never shared."));
  if (left.videos) out.push(n(left.videos, "1 video is left out: the receiver adds their own.", "# videos are left out: the receiver adds their own."));
  if (left.bios) out.push("Your about text is left out: the receiver writes their own.");
  if (left.guarantees) out.push("Your guarantee is left out: the receiver writes their own promise.");
  if (left.countdowns) out.push(n(left.countdowns, "1 countdown is left out: your deadline is yours.", "# countdowns are left out: your deadlines are yours."));
  if (left.reviewPicks) out.push("The reviews you picked to show first stay yours; buyers' reviews are never shared.");
  if (left.quotes) out.push(n(left.quotes, "1 thing said about you elsewhere is left out.", "# things said about you elsewhere are left out."));
  if (left.steps) out.push(n(left.steps, "1 step whose page or product is gone is left out.", "# steps whose page or product is gone are left out."));
  if (left.products) out.push(n(left.products, "1 product card or button names a product you no longer have, and is left empty.", "# product cards or buttons name products you no longer have, and are left empty."));
  if (left.forms) out.push(n(left.forms, "1 form block names a form you no longer have, and is left empty.", "# form blocks name forms you no longer have, and are left empty."));
  return out;
}

// ---- Reading one -----------------------------------------------------------

export type BundleError =
  | "format"
  | "forms_sensitive"
  | "newer"
  | "too_big"
  | "unsafe"
  | "shape"
  | "steps"
  | "pages"
  | "blocks"
  | "kind"
  | "pictures"
  | "forms"
  | "products";

/**
 * A file, read strictly: the bundle when every part of it is one the format
 * has, in the sizes it allows, or the reason it is refused. `own` reads a
 * copy made inside the same store (never a file from outside), which may
 * keep the countdowns, quotes and picked reviews a shared file leaves out.
 */
export function readBundle(raw: unknown, options: { maxBytes: number; own?: boolean }): { ok: true; bundle: FunnelBundle } | { ok: false; error: BundleError } {
  let json: string;
  try {
    json = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return { ok: false, error: "format" };
  }
  if (typeof json !== "string" || new TextEncoder().encode(json).length > options.maxBytes) return { ok: false, error: "too_big" };
  let value: unknown;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, error: "format" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "format" };
  const top = value as Record<string, unknown>;
  if (top.format !== BUNDLE_FORMAT) return { ok: false, error: "format" };
  if (typeof top.schema === "number" && Number.isInteger(top.schema) && top.schema > BUNDLE_SCHEMA) return { ok: false, error: "newer" };
  if (top.schema !== BUNDLE_SCHEMA) return { ok: false, error: "format" };
  if (!onlyKeys(top, ["format", "schema", "name", "steps", "pages", "forms", "products"])) return { ok: false, error: "shape" };
  if (hasUnsafeText(top)) return { ok: false, error: "unsafe" };

  const name = typeof top.name === "string" ? top.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_FUNNEL_NAME) return { ok: false, error: "shape" };

  // Products: placeholders, each named once.
  if (!Array.isArray(top.products) || top.products.length > MAX_BUNDLE_PRODUCTS) return { ok: false, error: "products" };
  const products: BundleProduct[] = [];
  for (const entry of top.products) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "products" };
    const row = entry as Record<string, unknown>;
    if (!onlyKeys(row, ["ref", "label", "wants"])) return { ok: false, error: "shape" };
    const label = typeof row.label === "string" ? row.label.replace(/\s+/g, " ").trim() : "";
    if (typeof row.ref !== "string" || !PRODUCT_REF.test(row.ref) || products.some((p) => p.ref === row.ref)) return { ok: false, error: "products" };
    if (!label || label.length > MAX_PRODUCT_LABEL || (row.wants !== "free" && row.wants !== "paid")) return { ok: false, error: "products" };
    products.push({ ref: row.ref, label, wants: row.wants });
  }
  const productRefs = new Set(products.map((p) => p.ref));

  // Forms: questions only, read by the same rules as a form made in the studio.
  if (!Array.isArray(top.forms) || top.forms.length > MAX_BUNDLE_FORMS) return { ok: false, error: "forms" };
  const forms: BundleForm[] = [];
  for (const entry of top.forms) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "forms" };
    const row = entry as Record<string, unknown>;
    // A scored quiz (lib/forms.ts) also carries its scoring, categories, points and score ranges.
    if (!onlyKeys(row, ["ref", "name", "fields", "button", "doneHeading", "doneBody", "outcomes", "offerList", "scoring", "categories"])) return { ok: false, error: "shape" };
    if (typeof row.ref !== "string" || !FORM_REF.test(row.ref) || forms.some((f) => f.ref === row.ref)) return { ok: false, error: "forms" };
    const outcomes = Array.isArray(row.outcomes) ? row.outcomes : [];
    const refs: string[] = [];
    for (const outcome of outcomes) {
      const o = outcome && typeof outcome === "object" ? (outcome as Record<string, unknown>) : null;
      if (!o || !onlyKeys(o, ["id", "title", "body", "product", "min", "max"])) return { ok: false, error: "forms" };
      const ref = typeof o.product === "string" ? o.product : "";
      if (ref && !productRefs.has(ref)) return { ok: false, error: "products" };
      refs.push(ref);
    }
    const fields = Array.isArray(row.fields) ? row.fields : [];
    for (const field of fields) {
      const f = field && typeof field === "object" ? (field as Record<string, unknown>) : null;
      if (!f || !onlyKeys(f, ["id", "type", "label", "required", "options"])) return { ok: false, error: "forms" };
      for (const option of Array.isArray(f.options) ? f.options : []) {
        const o = option && typeof option === "object" ? (option as Record<string, unknown>) : null;
        if (!o || !onlyKeys(o, ["id", "label", "outcome", "next", "points", "category"])) return { ok: false, error: "forms" };
      }
    }
    const parsed = parseForm({ ...row, id: "aaaaaaaaaa", outcomes: outcomes.map((o) => ({ ...(o as object), product: "" })) });
    // Nothing sent may be dropped by reading it: the counts must survive.
    if (
      !parsed ||
      parsed.fields.length !== fields.length ||
      parsed.outcomes.length !== outcomes.length ||
      parsed.fields.some((f, i) => f.options.length !== (Array.isArray((fields[i] as { options?: unknown }).options) ? ((fields[i] as { options: unknown[] }).options.length) : 0)) ||
      (row.offerList === true) !== parsed.offerList ||
      (row.scoring === "points") !== (parsed.scoring === "points") ||
      (parsed.categories?.length ?? 0) !== (Array.isArray(row.categories) ? row.categories.length : 0) ||
      // A scored quiz arrives whole: every score with exactly one result, as the studio requires.
      tierIssues(parsed).length > 0
    ) {
      return { ok: false, error: "forms" };
    }
    // A form in a funnel file never asks what a scam asks for (568 [GD2] (c)), whoever wrote the file.
    if (sensitiveFieldOf(parsed)) return { ok: false, error: "forms_sensitive" };
    const { id: _id, updatedAt: _at, ...rest } = parsed;
    void _id;
    void _at;
    forms.push({ ref: row.ref, ...rest, outcomes: rest.outcomes.map((o, i) => ({ ...o, product: refs[i] })) });
  }
  const formRefs = new Set(forms.map((f) => f.ref));

  // Pages: blocks a store's own page may hold, every one surviving the page's own rules.
  if (!Array.isArray(top.pages) || top.pages.length > MAX_SITE_PAGES) return { ok: false, error: "pages" };
  const pages: BundlePage[] = [];
  const usedProducts = new Set<string>();
  const usedForms = new Set<string>();
  for (const entry of top.pages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "pages" };
    const row = entry as Record<string, unknown>;
    if (!onlyKeys(row, ["ref", "title", "slug", "target", "style", "blocks"])) return { ok: false, error: "shape" };
    const title = typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
    const slug = typeof row.slug === "string" ? row.slug : "";
    const target = typeof row.target === "string" ? row.target : "";
    if (typeof row.ref !== "string" || !PAGE_REF.test(row.ref) || pages.some((p) => p.ref === row.ref)) return { ok: false, error: "pages" };
    if (!title || title.length > MAX_SITE_TITLE || !slug || slug.length > MAX_SLUG || !SLUG_PATTERN.test(slug)) return { ok: false, error: "pages" };
    if (target && !productRefs.has(target)) return { ok: false, error: "products" };
    if (!(PAGE_STYLES as readonly unknown[]).includes(row.style)) return { ok: false, error: "pages" };
    if (!Array.isArray(row.blocks) || row.blocks.length > MAX_BLOCKS) return { ok: false, error: "blocks" };
    if (JSON.stringify(row.blocks).length > MAX_PAGE_BYTES) return { ok: false, error: "too_big" };
    const sent: Record<string, unknown>[] = [];
    const refs: string[] = [];
    for (const block of row.blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) return { ok: false, error: "blocks" };
      const b = block as Record<string, unknown>;
      const kind = b.kind as BlockKind;
      if (typeof b.kind !== "string" || !SITE_KINDS.includes(kind)) return { ok: false, error: "kind" };
      if (!onlyKeys(b, [...allowedKeys(kind)])) return { ok: false, error: "shape" };
      if (typeof b.id !== "string" || !BLOCK_ID_PATTERN.test(b.id)) return { ok: false, error: "blocks" };
      if (kind === "pictures" && Array.isArray(b.items) && b.items.length) return { ok: false, error: "pictures" };
      if (kind === "feature" && b.picture) return { ok: false, error: "pictures" };
      if (!options.own && (kind === "countdown" || (kind === "quotes" && Array.isArray(b.items) && b.items.length))) return { ok: false, error: "kind" };
      let ref = "";
      if (kind === "product") {
        ref = typeof b.product === "string" ? b.product : "";
        if (ref && !productRefs.has(ref)) return { ok: false, error: "products" };
        if (ref) usedProducts.add(ref);
      }
      if (kind === "form") {
        ref = typeof b.form === "string" ? b.form : "";
        if (ref && !formRefs.has(ref)) return { ok: false, error: "forms" };
        if (ref) usedForms.add(ref);
      }
      refs.push(ref);
      sent.push(kind === "product" ? { ...b, product: "" } : kind === "form" ? { ...b, form: "" } : b);
    }
    const parsed = parsePage({ blocks: sent, style: row.style });
    if (parsed.blocks.length !== sent.length || picturePaths(parsed).length) return { ok: false, error: "blocks" };
    // A list item, a question or a cell dropped in reading is a refusal too: what is imported is what was sent.
    for (let i = 0; i < sent.length; i += 1) {
      const given = sent[i];
      const kept = parsed.blocks[i] as unknown as Record<string, unknown>;
      for (const key of ["items", "rows", "yes", "no", "show", "first"]) {
        if (Array.isArray(given[key]) && (!Array.isArray(kept[key]) || (kept[key] as unknown[]).length !== (given[key] as unknown[]).length)) return { ok: false, error: "blocks" };
      }
      if (given.video && !kept.video) return { ok: false, error: "blocks" };
      if (!options.own && kept.kind === "reviews" && Array.isArray(kept.first) && kept.first.length) return { ok: false, error: "kind" };
    }
    const blocks = parsed.blocks.map((block, i) => {
      if (block.kind === "product") return { ...block, product: refs[i] };
      if (block.kind === "form") return { ...block, form: refs[i] };
      return block;
    });
    if (target) usedProducts.add(target);
    pages.push({ ref: row.ref, title, slug, target, style: parsed.style, blocks });
  }

  // Steps: each page once and every page a step; each product placeholder at most once.
  if (!Array.isArray(top.steps) || top.steps.length === 0 || top.steps.length > MAX_FUNNEL_PAGES) return { ok: false, error: "steps" };
  const steps: BundleStep[] = [];
  for (const entry of top.steps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, error: "steps" };
    const row = entry as Record<string, unknown>;
    if (!onlyKeys(row, ["kind", "ref"]) || (row.kind !== "page" && row.kind !== "product") || typeof row.ref !== "string") return { ok: false, error: "steps" };
    const known = row.kind === "page" ? pages.some((p) => p.ref === row.ref) : productRefs.has(row.ref);
    if (!known || steps.some((s) => s.kind === row.kind && s.ref === row.ref)) return { ok: false, error: "steps" };
    steps.push({ kind: row.kind, ref: row.ref });
    if (row.kind === "product") usedProducts.add(row.ref);
  }
  if (pages.some((page) => !steps.some((s) => s.kind === "page" && s.ref === page.ref))) return { ok: false, error: "steps" };
  for (const form of forms) for (const outcome of form.outcomes) if (outcome.product) usedProducts.add(outcome.product);
  // Nothing in the file that nothing uses.
  if (products.some((p) => !usedProducts.has(p.ref))) return { ok: false, error: "products" };
  if (forms.some((f) => !usedForms.has(f.ref))) return { ok: false, error: "forms" };
  return { ok: true, bundle: { format: BUNDLE_FORMAT, schema: BUNDLE_SCHEMA, name, steps, pages, forms, products } };
}

// ---- What it would make ----------------------------------------------------

/** A bundle as the preview shows it: enough to choose products and see the work left, without its words. */
export type BundleOutline = {
  name: string;
  steps: { kind: PageFunnelStep["kind"]; ref: string; title: string }[];
  pages: { ref: string; title: string; kinds: BlockKind[] }[];
  forms: { ref: string; name: string; questions: number }[];
  products: (BundleProduct & { step: boolean })[];
  /** What the receiver will have to fill in, page by page. */
  fill: string[];
  bytes: number;
};

export function outlineOf(bundle: FunnelBundle): BundleOutline {
  const fill: string[] = [];
  for (const page of bundle.pages) {
    const need: string[] = [];
    const count = (test: (block: PageBlock) => boolean) => page.blocks.filter(test).length;
    const videos = count((b) => b.kind === "video" && !b.video);
    const pictures = count((b) => (b.kind === "pictures" && b.items.length === 0) || (b.kind === "feature" && !b.picture));
    if (videos) need.push(videos === 1 ? "a video" : `${videos} videos`);
    if (pictures) need.push(pictures === 1 ? "pictures in 1 block" : `pictures in ${pictures} blocks`);
    if (count((b) => b.kind === "bio" && !b.body)) need.push("your about text");
    if (count((b) => b.kind === "guarantee" && !b.body)) need.push("your guarantee");
    if (count((b) => b.kind === "faq" && b.items.length === 0)) need.push("your questions and answers");
    if (count((b) => b.kind === "cta" && !b.label)) need.push("button words");
    if (need.length) fill.push(`${page.title}: add ${need.join(", ")}.`);
  }
  const step = new Set(bundle.steps.filter((s) => s.kind === "product").map((s) => s.ref));
  return {
    name: bundle.name,
    steps: bundle.steps.map((s) => ({
      ...s,
      title: s.kind === "page" ? bundle.pages.find((p) => p.ref === s.ref)?.title ?? "" : bundle.products.find((p) => p.ref === s.ref)?.label ?? "",
    })),
    pages: bundle.pages.map((p) => ({ ref: p.ref, title: p.title, kinds: p.blocks.map((b) => b.kind) })),
    forms: bundle.forms.map((f) => ({ ref: f.ref, name: f.name, questions: f.fields.length })),
    products: bundle.products.map((p) => ({ ...p, step: step.has(p.ref) })),
    fill,
    bytes: new TextEncoder().encode(JSON.stringify(bundle)).length,
  };
}

/** One of the receiving store's products, as the import needs to know it. */
export type ReceiverProduct = { id: string; title: string; free: boolean; call: boolean; draft: boolean };

export type ImportRoom = { pagesLeft: number; funnelsLeft: number; formsLeft: number };

export type PlanLine = { level: "ok" | "fix" | "stop"; text: string };

/**
 * What bringing a bundle in would make, before anything is written: each
 * placeholder's product, the steps that will be left out, the room it needs,
 * and what the receiver will have to fill in. `ok` is false when something
 * stops it; the same plan is checked again when it is imported.
 */
export function planImport(
  outline: BundleOutline,
  receiver: ReceiverProduct[],
  room: ImportRoom,
  mapping: Record<string, string>,
): { ok: boolean; lines: PlanLine[]; mapped: Record<string, string>; steps: number } {
  const lines: PlanLine[] = [];
  const mapped: Record<string, string> = {};
  const usedForSteps = new Map<string, string>();
  for (const slot of outline.products) {
    const id = typeof mapping[slot.ref] === "string" ? mapping[slot.ref] : "";
    if (!id) {
      lines.push({ level: "fix", text: slot.step ? `“${slot.label}” is left out: its step is skipped and its cards and buttons lead to your store. Choose one of your products to keep it.` : `“${slot.label}” is left out: its cards and buttons lead to your store.` });
      continue;
    }
    const product = receiver.find((p) => p.id === id);
    if (!product) {
      lines.push({ level: "stop", text: `The product chosen for “${slot.label}” is not in this store.` });
      continue;
    }
    if (slot.step && product.call) {
      lines.push({ level: "stop", text: `${product.title} is a call, booked on a page of its own, so it cannot be a step for “${slot.label}”.` });
      continue;
    }
    if (slot.step) {
      const twice = usedForSteps.get(id);
      if (twice) {
        lines.push({ level: "stop", text: `${product.title} is chosen for two steps. Each product can be one step of a funnel, once.` });
        continue;
      }
      usedForSteps.set(id, slot.ref);
    }
    mapped[slot.ref] = id;
    if (slot.wants === "free" && !product.free) lines.push({ level: "fix", text: `${product.title} is paid where the funnel expects a free product that asks for an email.` });
    else if (slot.wants === "paid" && product.free) lines.push({ level: "fix", text: `${product.title} is free where the funnel expects a paid product.` });
    else lines.push({ level: "ok", text: `“${slot.label}” becomes ${product.title}.` });
    if (product.draft) lines.push({ level: "fix", text: `${product.title} is a draft: visitors go past its step until you publish it.` });
  }
  const steps = outline.steps.filter((s) => s.kind === "page" || mapped[s.ref]).length;
  if (steps === 0) lines.push({ level: "stop", text: "Nothing would be left to walk: choose a product for at least one step." });
  if (outline.pages.length > room.pagesLeft) lines.push({ level: "stop", text: `It makes ${outline.pages.length} pages and your store has room for ${room.pagesLeft} more (${MAX_SITE_PAGES} at most).` });
  if (room.funnelsLeft < 1) lines.push({ level: "stop", text: "Your store has all the funnels it can hold. Remove one to bring this in." });
  if (outline.forms.length > room.formsLeft) lines.push({ level: "stop", text: `It asks ${outline.forms.length} forms and your store has room for ${room.formsLeft} more (${MAX_FORMS} at most).` });
  for (const text of outline.fill) lines.push({ level: "fix", text });
  lines.push({ level: "ok", text: "Its pages arrive kept back from visitors and out of your menu, and the funnel arrives off, until you make them yours." });
  return { ok: !lines.some((line) => line.level === "stop"), lines, mapped, steps };
}

/**
 * A bundle's page as it is written into the receiving store: fresh block ids,
 * placeholders replaced by the receiver's products and forms (or left empty),
 * read through the page's own rules and kept back from visitors.
 */
export function pageForStore(page: BundlePage, products: Record<string, string>, forms: Record<string, string>): SalesPage {
  const blocks = page.blocks.map((block) => {
    const copy = { ...block, id: newBlockId() } as PageBlock;
    delete copy.saved;
    if (copy.kind === "product") copy.product = products[copy.product] ?? "";
    if (copy.kind === "form") copy.form = forms[copy.form] ?? "";
    return copy;
  });
  return { ...parsePage({ blocks, style: page.style }), hidden: true, showFrom: 0 };
}

/** A bundle's form as it is written into the receiving store: a new id, results pointing at the receiver's products. */
export function formForStore(form: BundleForm, products: Record<string, string>, nowSeconds: number): FormDef | null {
  const { ref: _ref, ...rest } = form;
  void _ref;
  return parseForm({ ...rest, id: newFormId(), updatedAt: nowSeconds, outcomes: rest.outcomes.map((o) => ({ ...o, product: o.product ? products[o.product] ?? "" : "" })) });
}
