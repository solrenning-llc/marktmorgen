/**
 * Reading a store's funnel into a file, and writing a file into a store as a
 * draft (lib/funnel-bundle.ts has the format and its rules).
 *
 * Writing in makes what a funnel type makes (app/api/store/page-funnels):
 * the store's own pages, out of the menu and kept back from visitors; the
 * forms they ask; and the funnel, off. Every limit is checked before the
 * first write, and again by the write that holds it (the store's pages, the
 * forms, the funnels), so two imports at once cannot pass a limit together.
 */
import { randomBytes } from "node:crypto";
import { idsOfKind, readCards } from "@/lib/catalog";
import { appendSitePages, type Store } from "@/lib/store";
import { readPage, writePage } from "@/lib/sales-page-store";
import { MAX_SITE_PAGES, type SitePage, siteKey, slugProblem } from "@/lib/site-page-rules";
import { MAX_PAGE_FUNNELS, type PageFunnel, type PageFunnelStep, funnelSlugFrom, funnelSlugProblem, newFunnelId } from "@/lib/page-funnel";
import { readPageFunnel, readPageFunnelsStrict, writePageFunnel } from "@/lib/page-funnel-store";
import { freeSlug } from "@/lib/funnel-types";
import { MAX_FORMS, type FormDef } from "@/lib/forms";
import { canAddForms, readForm, readForms, writeForm } from "@/lib/form-store";
import { type BundleOutline, type BundleSource, type FunnelBundle, type ImportRoom, type LeftOut, type ReceiverProduct, buildBundle, formForStore, outlineOf, pageForStore, planImport } from "@/lib/funnel-bundle";

/** One of this store's funnels as a file; null when the funnel is gone. */
export async function collectBundle(store: Store, funnelId: string, mode: "share" | "own"): Promise<{ bundle: FunnelBundle; left: LeftOut; funnel: PageFunnel; productIds: Record<string, string> } | null> {
  if (!store.statsId) return null;
  const funnel = await readPageFunnel(store.statsId, funnelId);
  if (!funnel) return null;
  const pages: BundleSource["pages"] = new Map();
  const formIds = new Set<string>();
  const productIds = new Set<string>();
  for (const step of funnel.steps) {
    // A split test or a conditional path is left out of the file (lib/funnel-bundle.ts says so to the sender), and so are its pages.
    if (step.kind === "split" || step.kind === "branch") continue;
    if (step.kind === "product") {
      productIds.add(step.id);
      continue;
    }
    const meta = store.sitePages.find((page) => page.id === step.id);
    if (!meta) continue;
    const page = await readPage(store.statsId, siteKey(meta.id));
    pages.set(meta.id, { meta, page });
    if (meta.target) productIds.add(meta.target);
    for (const block of page.blocks) {
      if (block.kind === "form" && block.form) formIds.add(block.form);
      if (block.kind === "product" && block.product) productIds.add(block.product);
    }
  }
  const forms: BundleSource["forms"] = new Map();
  for (const id of formIds) {
    const form = await readForm(store.statsId, id);
    if (form) {
      forms.set(id, form);
      for (const outcome of form.outcomes) if (outcome.product) productIds.add(outcome.product);
    }
  }
  const cards = await readCards(store);
  const free = new Set(idsOfKind(store, "free"));
  const calls = new Set(idsOfKind(store, "call"));
  const products: BundleSource["products"] = new Map();
  for (const id of productIds) {
    const card = cards.get(id);
    if (card) products.set(id, { title: card.title, free: free.has(id), call: calls.has(id) });
  }
  const { bundle, left, productIds: ids } = buildBundle({ name: funnel.name, steps: funnel.steps, pages, forms, products }, mode);
  return { bundle, left, funnel, productIds: ids };
}

/** What the receiving store has, for the plan of an import. */
export async function receiverOf(store: Store): Promise<{ products: ReceiverProduct[]; room: ImportRoom }> {
  const cards = await readCards(store);
  const free = new Set(idsOfKind(store, "free"));
  const calls = new Set(idsOfKind(store, "call"));
  const drafts = new Set(idsOfKind(store, "hidden"));
  const products = store.catalog.items.map((item) => ({
    id: item.id,
    title: cards.get(item.id)?.title ?? "Untitled product",
    free: free.has(item.id),
    call: calls.has(item.id),
    draft: drafts.has(item.id),
  }));
  const funnels = await readPageFunnelsStrict(store.statsId);
  const forms = store.statsId ? await readForms(store.statsId) : [];
  return {
    products,
    room: {
      pagesLeft: Math.max(0, MAX_SITE_PAGES - store.sitePages.length),
      funnelsLeft: Math.max(0, MAX_PAGE_FUNNELS - funnels.length),
      formsLeft: Math.max(0, MAX_FORMS - forms.length),
    },
  };
}

export type ImportResult =
  | { ok: true; funnel: PageFunnel; pages: { id: string; title: string; slug: string }[]; lines: ReturnType<typeof planImport>["lines"] }
  | { ok: false; error: "plan" | "pages_full" | "forms_full" | "full" | "setup_incomplete"; lines?: ReturnType<typeof planImport>["lines"] };

/**
 * Writes a bundle into a store as a draft: its pages, forms and funnel, with
 * each placeholder mapped to the product `mapping` names (or left out). The
 * plan is made again here from the store as it is now, so a preview never
 * stands in for the check.
 */
export async function importBundle(ref: string, store: Store, bundle: FunnelBundle, mapping: Record<string, string>, name?: string): Promise<ImportResult> {
  if (!store.statsId) return { ok: false, error: "setup_incomplete" };
  const statsId = store.statsId;
  const outline: BundleOutline = outlineOf(bundle);
  const receiver = await receiverOf(store);
  const plan = planImport(outline, receiver.products, receiver.room, mapping);
  if (!plan.ok) return { ok: false, error: "plan", lines: plan.lines };
  const products = plan.mapped;
  if (bundle.forms.length && !(await canAddForms(statsId, bundle.forms.length))) return { ok: false, error: "forms_full", lines: plan.lines };

  // The pages, at addresses of their own, out of the menu and kept back.
  const taken = new Set(store.sitePages.map((page) => page.slug));
  const made: { ref: string; page: SitePage }[] = [];
  for (const page of bundle.pages) {
    let slug = freeSlug(page.slug, taken);
    if (slugProblem(slug, store.sitePages) === "reserved") slug = freeSlug(`${page.slug.slice(0, 34)}-page`, taken);
    taken.add(slug);
    made.push({ ref: page.ref, page: { id: randomBytes(5).toString("hex"), slug, title: page.title, nav: false, target: page.target ? products[page.target] ?? "" : "", from: -1 } });
  }
  let started = false;
  try {
    if (made.length) {
      started = true;
      const saved = await appendSitePages(ref, made.map((m) => m.page));
      if (!saved.ok) return { ok: false, error: "pages_full", lines: plan.lines };
    }
    const now = Math.floor(Date.now() / 1000);
    const forms: Record<string, string> = {};
    for (const form of bundle.forms) {
      const made: FormDef | null = formForStore(form, products, now);
      if (!made) throw new Error("A checked form could not be read again");
      started = true;
      if (!(await writeForm(statsId, made))) return { ok: false, error: "forms_full", lines: plan.lines };
      forms[form.ref] = made.id;
    }
    for (const { ref: pageRef, page } of made) {
      const source = bundle.pages.find((p) => p.ref === pageRef)!;
      await writePage(statsId, siteKey(page.id), pageForStore(source, products, forms), store);
    }
    const steps: PageFunnelStep[] = bundle.steps.flatMap((step): PageFunnelStep[] => {
      if (step.kind === "page") return [{ kind: "page", id: made.find((m) => m.ref === step.ref)!.page.id }];
      return products[step.ref] ? [{ kind: "product", id: products[step.ref] }] : [];
    });
    const existing = await readPageFunnelsStrict(statsId);
    if (existing.length >= MAX_PAGE_FUNNELS) return { ok: false, error: "full", lines: plan.lines };
    const label = (name ?? bundle.name).replace(/\s+/g, " ").trim().slice(0, 60) || "Imported funnel";
    const base = funnelSlugFrom(label) || "funnel";
    let slug = base;
    for (let n = 2; funnelSlugProblem(slug, existing) !== null && n < 100; n += 1) slug = `${base.slice(0, 36)}-${n}`;
    started = true;
    const funnel = await writePageFunnel(statsId, { id: newFunnelId(), name: label, slug, steps, on: false, since: now }, existing, store);
    return { ok: true, funnel, pages: made.map((m) => ({ id: m.page.id, title: m.page.title, slug: m.page.slug })), lines: plan.lines };
  } catch (error) {
    if (!started) throw error;
    console.error("importing a funnel stopped part way", error);
    return { ok: false, error: "setup_incomplete", lines: plan.lines };
  }
}

