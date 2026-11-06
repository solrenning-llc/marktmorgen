/**
 * Copying a whole store into another store of the same account
 * (lib/store-copy-rules.ts has what comes across and what never does).
 *
 * A copy is made in steps, each one studio request of the other store's:
 * the products 25 at a time, then the forms, the pages, the funnels and, when
 * asked, the store page's setup. Each step is charged to the other store's
 * studio requests of the month before it writes anything, at what it may
 * send (COPY_UNIT_COMMANDS and COPY_UNIT_BYTES a request), so a copy costs
 * nothing a plan's priced studio requests do not already count; and
 * everything it writes takes its room in that store's data room first.
 *
 * Every id a copy makes is worked out from the copy's own id and the id of
 * what it copies (idFor). So a step done twice writes the same records again
 * or finds them already there and adds nothing: a retry after a failure, a
 * second tab or a lost answer never makes a second product, page, form or
 * funnel. The record of a copy's progress is kept COPY_KEEP_SECONDS under
 * nl:copy:<store>:<copy id>, counted in the data room until it goes by
 * itself, and one step runs at a time in a store (nl:copy:lock:<store>).
 */
import { createHash } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { MAX_PRODUCTS, MAX_PRODUCT_BYTES, type Product, productIds, readProducts } from "@/lib/catalog";
import { type Store, accountStores, addCopiedProducts, appendSitePages, applyCopiedSetup, storeForId, storeRef } from "@/lib/store";
import { readAbout, writeAbout, MAX_ABOUT_LENGTH } from "@/lib/product-about";
import { readPage, writePage } from "@/lib/sales-page-store";
import { MAX_PAGE_BYTES, type SalesPage } from "@/lib/sales-page";
import { MAX_SITE_PAGES, type SitePage, siteKey, slugProblem } from "@/lib/site-page-rules";
import { freeSlug } from "@/lib/funnel-types";
import { MAX_FORMS } from "@/lib/forms";
import { readForms, writeForm } from "@/lib/form-store";
import { MAX_PAGE_FUNNELS, funnelSlugFrom, funnelSlugProblem } from "@/lib/page-funnel";
import { readPageFunnelsStrict, writePageFunnel } from "@/lib/page-funnel-store";
import { dataKey, dataUsed, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import {
  COPY_COMMANDS,
  COPY_KEEP_SECONDS,
  COPY_STEP_PRODUCTS,
  type CopyNeeds,
  type CopyPhase,
  type PlanLine,
  PHASES,
  type SkipReason,
  copiedForm,
  copiedFunnel,
  copiedPage,
  copiedProduct,
  copiedSetup,
  emptyBlocksLeft,
  emptyProductLeft,
  planCopy,
  skipReason,
  unitsFor,
} from "@/lib/store-copy-rules";

/** A copy's id for one thing it copies: ten lower-case hex characters, fitting every id pattern of products, pages, forms and funnels. */
export function idFor(copyId: string, kind: "p" | "f" | "s" | "n", sourceId: string): string {
  return createHash("sha256").update(`store-copy|${copyId}|${kind}|${sourceId}`).digest("hex").slice(0, 10);
}

const progressKey = (sid: string, copyId: string) => `nl:copy:${sid}:${copyId}`;
const lockKey = (sid: string) => `nl:copy:lock:${sid}`;

/** What a copy has done so far, kept between its steps. */
export type CopyProgress = {
  from: string;
  setup: boolean;
  phase: CopyPhase;
  /** The first store's products that are copied, in its order. */
  ids: string[];
  /** How far through `ids` the products are written. */
  cursor: number;
  made: { products: number; forms: number; pages: number; funnels: number; setup: boolean };
  started: number;
};

/**
 * The other store, when it is one of the account's own: only the account's
 * owner copies, from one of its stores into another of them. A teammate, a
 * store of anyone else or the same store is never a destination.
 */
export async function ownTarget(email: string, store: Store, role: string, raw: unknown): Promise<{ ok: true; store: Store } | { ok: false; error: "owner_only" | "not_yours" | "unavailable"; status: number }> {
  if (role !== "owner" || email.toLowerCase() !== store.email.toLowerCase()) return { ok: false, error: "owner_only", status: 403 };
  const to = typeof raw === "string" ? raw : "";
  if (!/^[0-9a-f]{32}$/.test(to) || to === store.sid) return { ok: false, error: "not_yours", status: 404 };
  const target = (await accountStores(email)).find((s) => s.sid === to && s.email.toLowerCase() === email.toLowerCase());
  if (!target) return { ok: false, error: "not_yours", status: 404 };
  if (!target.statsId || !store.statsId) return { ok: false, error: "unavailable", status: 503 };
  return { ok: true, store: target };
}

/** What one of the first store's products weighs in its data room: its records, its long description and its page. */
type Weight = { record: number; about: number | null; page: number | null };

/**
 * What each of the first store's products (or pages) weighs in its data
 * room, read in one command. A record whose room is not counted is weighed
 * at the ceiling; a description or page whose room is not counted is null,
 * and weighed at its ceiling once the product read says it has one.
 */
async function weights(from: Store, ids: string[]): Promise<Map<string, Weight>> {
  const out = new Map<string, Weight>();
  const key = dataKey(from);
  if (!ids.length) return out;
  const fields = ids.flatMap((id) => [`p:${id}`, `ab:${id}`, `pg:${id}`]);
  const [reply] = key ? await redisPipeline([["HMGET", key, ...fields]]) : [null];
  const values = Array.isArray(reply) ? reply.map((v) => (v === null || v === undefined ? NaN : Number(v))) : [];
  const known = (n: number | undefined) => (n !== undefined && Number.isFinite(n) && n >= 0 ? n : null);
  ids.forEach((id, i) => {
    const record = known(values[i * 3]);
    out.set(id, { record: record && record > 0 ? record : MAX_PRODUCT_BYTES, about: known(values[i * 3 + 1]), page: known(values[i * 3 + 2]) });
  });
  return out;
}

/** What a product (or page) and what comes with it weigh, given what its read says it has. */
const weightOf = (w: Weight | undefined, has: { about: boolean; page: boolean }) =>
  (w?.record ?? MAX_PRODUCT_BYTES) + (has.about ? w?.about ?? MAX_ABOUT_LENGTH * 4 : 0) + (has.page ? w?.page ?? MAX_PAGE_BYTES : 0);

/** Everything a copy reads from the first store before it writes, and what it would need in the other one. */
type Source = {
  products: Product[];
  copyable: string[];
  skipped: { title: string; why: SkipReason }[];
  pages: SitePage[];
  pageBytes: number;
  forms: Awaited<ReturnType<typeof readForms>>;
  funnels: Awaited<ReturnType<typeof readPageFunnelsStrict>>;
  bytes: number;
};

/** What a progress record may weigh at the most: its fields and a list of every product. */
const PROGRESS_BYTES = 1_000 + MAX_PRODUCTS * 12;

/**
 * The studio requests reading the whole first store is charged, worked out
 * before it is read from what each thing weighs in its data room (one
 * command), so the read is paid for first.
 */
async function readCharge(from: Store): Promise<{ units: number; sizes: Map<string, Weight>; pageSizes: Map<string, Weight> }> {
  const ids = productIds(from);
  const sizes = await weights(from, ids);
  const pageSizes = await weights(from, from.sitePages.map((p) => siteKey(p.id)));
  // A plan reads the product records, the forms and the funnels: never a page or a description.
  const bytes = [...sizes.values()].reduce((sum, w) => sum + w.record, 0);
  return { units: unitsFor(8 + Math.ceil(ids.length / 10), bytes + MAX_FORMS * 20_000 + MAX_PAGE_FUNNELS * 10_000), sizes, pageSizes };
}

/** Reads every product of the first store, its pages, forms and funnels: what a plan needs to know. */
async function readSource(from: Store, sizes: Map<string, Weight>, pageSizes: Map<string, Weight>): Promise<Source> {
  const products = await readProducts(from, productIds(from));
  const first = new Set(products.filter((p) => !skipReason(p)).map((p) => p.id));
  // A bundle is copied only when everything in it is.
  const copyableSet = new Set(products.filter((p) => !skipReason(p, first)).map((p) => p.id));
  const skipped = products.flatMap((p) => {
    const why = skipReason(p, first);
    return why ? [{ title: p.title, why }] : [];
  });
  const copyable = products.filter((p) => copyableSet.has(p.id)).map((p) => p.id);
  const pageBytes = [...pageSizes.values()].reduce((sum, w) => sum + (w.page ?? MAX_PAGE_BYTES), 0);
  const forms = await readForms(from.statsId);
  const funnels = await readPageFunnelsStrict(from.statsId);
  const byId = new Map(products.map((p) => [p.id, p]));
  const bytes = copyable.reduce((sum, id) => sum + weightOf(sizes.get(id), { about: byId.get(id)?.about === true, page: byId.get(id)?.page === true }), 0)
    + pageBytes
    + forms.reduce((sum, f) => sum + dataBytes([JSON.stringify(f)], 1), 0)
    + funnels.reduce((sum, f) => sum + dataBytes([JSON.stringify(f)], 1), 0)
    + PROGRESS_BYTES;
  return { products, copyable, skipped, pages: from.sitePages, pageBytes, forms, funnels, bytes };
}

/** The studio requests the steps of a whole copy are charged, at the most, past the read of its plan. */
function copyUnits(source: Source, sizes: Map<string, Weight>, setup: boolean): { units: number; steps: number } {
  const batches = Math.ceil(source.copyable.length / COPY_STEP_PRODUCTS);
  let units = 0;
  for (let b = 0; b < batches; b += 1) {
    const batch = source.copyable.slice(b * COPY_STEP_PRODUCTS, (b + 1) * COPY_STEP_PRODUCTS);
    const byId = new Map(source.products.map((p) => [p.id, p]));
    units += unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.productWrite + batch.length * COPY_COMMANDS.product, 2 * batch.reduce((sum, id) => sum + weightOf(sizes.get(id), { about: byId.get(id)?.about === true, page: byId.get(id)?.page === true }), 0));
  }
  units += unitsFor(COPY_COMMANDS.step + source.forms.length * COPY_COMMANDS.form, 2 * source.forms.reduce((s, f) => s + JSON.stringify(f).length, 0));
  units += unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.pagesWrite + source.pages.length * COPY_COMMANDS.page, 2 * source.pageBytes);
  units += unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.funnelsRead + source.funnels.length * COPY_COMMANDS.funnel, 2 * source.funnels.reduce((s, f) => s + JSON.stringify(f).length, 0));
  if (setup) units += unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.setup, SETUP_BYTES);
  return { units, steps: batches + 4 + (setup ? 1 : 0) };
}

/** What the store page's setup may move through the database at the most: the store's record read and written. */
const SETUP_BYTES = 200_000;

type Planned = { ok: boolean; lines: PlanLine[]; needs: CopyNeeds; source: Source | null };

/**
 * Plans a copy from both stores as they are now: its read paid for first
 * from the other store's studio requests, then what it would make there,
 * what it leaves out, and whether all of it fits. Nothing is written.
 */
async function planFor(from: Store, to: Store, setup: boolean): Promise<Planned> {
  const empty: CopyNeeds = { products: 0, skipped: [], pages: 0, forms: 0, funnels: 0, dataBytes: 0, units: 0, files: 0, pictures: 0, notes: 0, sameCurrency: true, steps: 0 };
  const read = await readCharge(from);
  const paid = await charge(to, read.units);
  if (!paid.ok) return { ok: false, lines: [{ level: "stop", text: paid.message }], needs: empty, source: null };
  const source = await readSource(from, read.sizes, read.pageSizes);
  const { units, steps } = copyUnits(source, read.sizes, setup);
  const left = emptyProductLeft();
  for (const p of source.products.filter((p) => source.copyable.includes(p.id))) copiedProduct(p, p.id, (id) => id, "", left);
  const funnels = await readPageFunnelsStrict(to.statsId);
  const forms = await readForms(to.statsId);
  const used = await dataUsed(to).catch(() => null);
  const unitsUsed = await allowanceUsed(to, "studio").catch(() => null);
  const needs: CopyNeeds = {
    products: source.copyable.length,
    skipped: source.skipped,
    pages: source.pages.length,
    forms: source.forms.length,
    funnels: source.funnels.length,
    dataBytes: source.bytes,
    units,
    files: left.files,
    pictures: left.pictures,
    notes: left.notes,
    sameCurrency: from.currency === to.currency,
    steps,
  };
  const room = {
    products: Math.max(0, MAX_PRODUCTS - to.catalog.items.length),
    pages: Math.max(0, MAX_SITE_PAGES - to.sitePages.length),
    forms: Math.max(0, MAX_FORMS - forms.length),
    funnels: Math.max(0, MAX_PAGE_FUNNELS - funnels.length),
    dataBytes: used ? used.room - used.used : null,
    units: unitsUsed === null ? null : Math.max(0, allowanceFor(to, "studio") - unitsUsed),
    currency: to.currency,
  };
  const plan = planCopy(needs, room, to.name || `@${to.handle}`);
  return { ...plan, needs, source };
}

/** What a copy needs and where the other store stands; nothing is written but the studio requests its reading takes. */
export async function previewCopy(from: Store, to: Store, setup: boolean): Promise<{ ok: boolean; lines: PlanLine[]; needs: CopyNeeds }> {
  const { ok, lines, needs } = await planFor(from, to, setup);
  return { ok, lines, needs };
}

export type StepAnswer =
  | { ok: true; done: boolean; phase: CopyPhase; made: CopyProgress["made"]; products: { done: number; of: number }; lines: PlanLine[] }
  | { ok: false; error: "busy" | "plan" | "other_copy" | "studio_used" | "full" | "unavailable"; message: string; lines?: PlanLine[] };

/** Takes the studio requests a part of a step is charged, on top of the one its request took at the door. */
async function charge(to: Store, units: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const taken = await takeAllowance(to, "studio", Math.max(1, units));
  return taken.ok ? { ok: true } : { ok: false, message: taken.message };
}

async function readProgress(to: Store, copyId: string): Promise<CopyProgress | null> {
  const [raw] = await redisPipeline([["GET", progressKey(to.sid, copyId)]]);
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as CopyProgress;
    return value && typeof value.from === "string" && PHASES.includes(value.phase) && Array.isArray(value.ids) ? value : null;
  } catch {
    return null;
  }
}

async function saveProgress(to: Store, copyId: string, progress: CopyProgress, fresh: boolean): Promise<void> {
  const json = JSON.stringify(progress);
  // Counted until it goes by itself; the first time with what its list of products may weigh at the most.
  if (fresh) await needData(to, [{ until: Date.now() + COPY_KEEP_SECONDS * 1000, bytes: Math.max(PROGRESS_BYTES, dataBytes([json], 1)) }]);
  await redisPipeline([["SET", progressKey(to.sid, copyId), json, "EX", COPY_KEEP_SECONDS]]);
}

const nextPhase = (phase: CopyPhase, setup: boolean): CopyPhase => {
  const after = PHASES[PHASES.indexOf(phase) + 1] ?? "done";
  return after === "setup" && !setup ? "done" : after;
};

/**
 * One step of a copy: the first one plans it again from both stores as they
 * are now and refuses it whole when it does not fit; the later ones go on
 * from where the last one stopped. Answers where the copy stands.
 */
export async function copyStep(from: Store, to: Store, copyId: string, setup: boolean): Promise<StepAnswer> {
  if (!isRedisConfigured() || !from.statsId || !to.statsId) return { ok: false, error: "unavailable", message: "Copying can't be done just now. Try again in a minute." };
  let held;
  try {
    held = await takeLock(lockKey(to.sid), 60, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, error: "busy", message: "A step of a copy into that store is running. Try again in a moment." };
    throw error;
  }
  try {
    let progress = await readProgress(to, copyId);
    if (progress && progress.from !== from.sid) return { ok: false, error: "other_copy", message: "That copy is from another store. Start a new copy from here." };
    if (!progress) {
      const planned = await planFor(from, to, setup);
      if (!planned.ok || !planned.source) return { ok: false, error: "plan", message: "Nothing was copied: it does not fit as a whole.", lines: planned.lines };
      progress = { from: from.sid, setup, phase: "products", ids: planned.source.copyable, cursor: 0, made: { products: 0, forms: 0, pages: 0, funnels: 0, setup: false }, started: Date.now() };
      await saveProgress(to, copyId, progress, true);
    }
    const p = progress;
    const products = (id: string) => (id && p.ids.includes(id) ? idFor(copyId, "p", id) : "");
    const now = Date.now();

    if (p.phase === "products") {
      const batch = p.ids.slice(p.cursor, p.cursor + COPY_STEP_PRODUCTS);
      const sizes = await weights(from, batch);
      // The records are read first, paid for at what the data room says they weigh; then the rest, before anything is written.
      const recordUnits = unitsFor(2, batch.reduce((sum, id) => sum + (sizes.get(id)?.record ?? MAX_PRODUCT_BYTES), 0));
      const paidRead = await charge(to, recordUnits);
      if (!paidRead.ok) return { ok: false, error: "studio_used", message: paidRead.message };
      const read = await readProducts(from, batch);
      const bytes = 2 * read.reduce((sum, product) => sum + weightOf(sizes.get(product.id), { about: product.about, page: product.page }), 0);
      const charged = await charge(to, Math.max(1, unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.productWrite + batch.length * COPY_COMMANDS.product, bytes) - recordUnits));
      if (!charged.ok) return { ok: false, error: "studio_used", message: charged.message };
      const left = emptyProductLeft();
      const stamp = new Date(now).toISOString();
      const copies = read.map((product) => copiedProduct(product, products(product.id), products, stamp, left));
      // Their pages, read before anything is written: an unknown answer throws here and leaves no draft without its page.
      const pages = new Map<string, SalesPage>();
      for (const product of read) if (product.page) pages.set(product.id, await readPage(from.statsId, product.id));
      const added = await addCopiedProducts(storeRef(to), copies);
      if (!added.ok) return { ok: false, error: "full", message: `${to.name || `@${to.handle}`} has no room for these products now. Nothing more was copied.` };
      const fresh = added.store;
      // Each long description and page, written again the same if this step is done twice.
      const blocksLeft = emptyBlocksLeft();
      const forms = (id: string) => (id ? idFor(copyId, "f", id) : "");
      for (const product of read) {
        const id = products(product.id);
        if (product.about) {
          const text = await readAbout(from.statsId, product.id);
          if (text) await writeAbout(to.statsId, id, text, fresh);
        }
        const page = pages.get(product.id);
        if (page) await writePage(to.statsId, id, copiedPage(page, products, forms, blocksLeft), fresh);
      }
      p.cursor += batch.length;
      p.made.products += added.made.length;
      if (p.cursor >= p.ids.length) p.phase = nextPhase("products", p.setup);
    } else if (p.phase === "forms") {
      const forms = await readForms(from.statsId);
      const charged = await charge(to, unitsFor(COPY_COMMANDS.step + forms.length * COPY_COMMANDS.form, 2 * forms.reduce((s, f) => s + JSON.stringify(f).length, 0)));
      if (!charged.ok) return { ok: false, error: "studio_used", message: charged.message };
      const left = emptyBlocksLeft();
      const seconds = Math.floor(now / 1000);
      for (const form of forms) {
        const copy = copiedForm(form, idFor(copyId, "f", form.id), products, seconds, left);
        // Writing one this copy already wrote replaces it with the same words; a store at its ceiling refuses a new one.
        if (!(await writeForm(to.statsId, copy))) return { ok: false, error: "full", message: `${to.name || `@${to.handle}`} has no room for more forms now. Nothing more was copied.` };
        p.made.forms += 1;
      }
      p.phase = nextPhase("forms", p.setup);
    } else if (p.phase === "pages") {
      const pages = from.sitePages;
      const sizes = await weights(from, pages.map((page) => siteKey(page.id)));
      const charged = await charge(to, unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.pagesWrite + pages.length * COPY_COMMANDS.page, 2 * [...sizes.values()].reduce((s, w) => s + (w.page ?? MAX_PAGE_BYTES), 0)));
      if (!charged.ok) return { ok: false, error: "studio_used", message: charged.message };
      const have = new Set(to.sitePages.map((page) => page.id));
      const taken = new Set(to.sitePages.map((page) => page.slug));
      const add: SitePage[] = [];
      for (const page of pages) {
        const id = idFor(copyId, "s", page.id);
        if (have.has(id)) continue;
        let slug = freeSlug(page.slug, taken);
        if (slugProblem(slug, to.sitePages) === "reserved") slug = freeSlug(`${page.slug.slice(0, 34)}-page`, taken);
        taken.add(slug);
        add.push({ id, slug, title: page.title, nav: false, target: products(page.target), from: -1 });
      }
      // Every page read before the first write, as above.
      const blocks: SalesPage[] = [];
      for (const page of pages) blocks.push(await readPage(from.statsId, siteKey(page.id)));
      let current = to;
      if (add.length) {
        const saved = await appendSitePages(storeRef(to), add);
        if (!saved.ok) return { ok: false, error: "full", message: `${to.name || `@${to.handle}`} has no room for these pages now. Nothing more was copied.` };
        current = saved.store;
      }
      const left = emptyBlocksLeft();
      const forms = (id: string) => (id ? idFor(copyId, "f", id) : "");
      for (const [i, page] of pages.entries()) await writePage(to.statsId, siteKey(idFor(copyId, "s", page.id)), copiedPage(blocks[i], products, forms, left), current);
      p.made.pages += add.length;
      p.phase = nextPhase("pages", p.setup);
    } else if (p.phase === "funnels") {
      const source = await readPageFunnelsStrict(from.statsId);
      const charged = await charge(to, unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.funnelsRead + source.length * COPY_COMMANDS.funnel, 2 * source.reduce((s, f) => s + JSON.stringify(f).length, 0)));
      if (!charged.ok) return { ok: false, error: "studio_used", message: charged.message };
      let existing = await readPageFunnelsStrict(to.statsId);
      const pageIds = new Set(from.sitePages.map((page) => page.id));
      const pages = (id: string) => (pageIds.has(id) ? idFor(copyId, "s", id) : "");
      const left = emptyBlocksLeft();
      for (const funnel of source) {
        const id = idFor(copyId, "n", funnel.id);
        const held = existing.find((f) => f.id === id);
        if (held) continue;
        if (existing.length >= MAX_PAGE_FUNNELS) return { ok: false, error: "full", message: `${to.name || `@${to.handle}`} has no room for more funnels now. Nothing more was copied.` };
        const base = funnelSlugFrom(funnel.slug || funnel.name) || "funnel";
        let slug = base;
        for (let n = 2; funnelSlugProblem(slug, existing) !== null && n < 100; n += 1) slug = `${base.slice(0, 36)}-${n}`;
        const made = await writePageFunnel(to.statsId, copiedFunnel(funnel, id, slug, pages, products, Math.floor(now / 1000), left), existing, to);
        existing = [...existing, made];
        p.made.funnels += 1;
      }
      p.phase = nextPhase("funnels", p.setup);
    } else if (p.phase === "setup") {
      const charged = await charge(to, unitsFor(COPY_COMMANDS.step + COPY_COMMANDS.setup, SETUP_BYTES));
      if (!charged.ok) return { ok: false, error: "studio_used", message: charged.message };
      const left = { pictures: 0, socials: 0, sections: 0 };
      const setupCopy = copiedSetup(from, products, left);
      const fresh = await storeForId(to.sid);
      if (!fresh) return { ok: false, error: "unavailable", message: "That store can't be read just now. Try again in a minute." };
      await applyCopiedSetup(storeRef(fresh), setupCopy);
      p.made.setup = true;
      p.phase = "done";
    }
    await saveProgress(to, copyId, p, false);
    return { ok: true, done: p.phase === "done", phase: p.phase, made: p.made, products: { done: Math.min(p.cursor, p.ids.length), of: p.ids.length }, lines: [] };
  } finally {
    await releaseLock(held).catch(() => undefined);
  }
}
