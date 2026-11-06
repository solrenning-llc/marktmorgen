import { SENSITIVE_WHY, sensitiveFieldOf } from "@/lib/form-sensitive";
import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { idsOfKind, readListings } from "@/lib/catalog";
import { FUNNEL_ID, MAX_FUNNEL_NAME, MAX_FUNNEL_PAGES, MAX_PAGE_FUNNELS, type PageFunnelStep, funnelSlugFrom, funnelSlugProblem, newFunnelId, productStepProblem, readFunnelInput } from "@/lib/page-funnel";
import { dropPageFunnel, readPageFunnels, writePageFunnel } from "@/lib/page-funnel-store";
import { randomBytes } from "node:crypto";
import { can } from "@/lib/team-roles";
import { appendSitePages } from "@/lib/store";
import { StoreFullError } from "@/lib/store-full";
import { emptyBlock, parsePage } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { MAX_SITE_PAGES, type SitePage, siteKey, slugProblem } from "@/lib/site-page-rules";
import { choicesOf, freeSlug, funnelType, pagesOf, slotProblem } from "@/lib/funnel-types";
import { readFunnelFormDrafts } from "@/lib/funnel-form-draft";
import { readFunnelPageCopy } from "@/lib/funnel-page-copy";
import { readFunnelBlockCopy } from "@/lib/funnel-ai-rules";
import { newFormId, parseForm } from "@/lib/forms";
import { canAddForms, writeForm } from "@/lib/form-store";

/**
 * Saves or removes one funnel of pages (lib/page-funnel.ts).
 *
 * `{ funnel: { id?, name, slug?, on, steps: [{ kind: "page" | "product", id }] } }`
 * saves it; `{ action: "remove", id }` removes it. Every step has to be a page
 * the store has, or a product of the store that has a page of its own and is
 * bought from it; a draft may be a step, and is passed over until it is out.
 *
 * `{ action: "from-type", type, name, products: { <slot>: <product id> } }`
 * builds one from a funnel type (lib/funnel-types.ts): the store's own pages
 * the type needs, optionally with author-written pageCopy and a draft's blockCopy (lib/funnel-ai-rules.ts), kept back until the creator lets them out,
 * and the funnel walking them and the chosen products in the type's order.
 * Making pages needs the permission to change the public page as well.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 20_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  if (!store.statsId) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
  const statsId = store.statsId;
  let setupStarted = false;

  try {
    const existing = await readPageFunnels(statsId);

    if (body.action === "remove") {
      const id = text(body.id, 10);
      if (!FUNNEL_ID.test(id)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
      const removed = await dropPageFunnel(statsId, id, store, existing);
      return removed ? Response.json({ ok: true }) : Response.json({ ok: false, error: "unknown" }, { status: 404 });
    }

    if (body.action === "from-type") {
      const type = funnelType(text(body.type, 40));
      if (!type) return Response.json({ ok: false, error: "type" }, { status: 400 });
      if (!can(guarded.role, "page")) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
      if (existing.length >= MAX_PAGE_FUNNELS) return Response.json({ ok: false, error: "full" }, { status: 400 });
      const name = text(body.name, MAX_FUNNEL_NAME).replace(/\s+/g, " ").trim() || type.label;
      const pages = pagesOf(type);
      const formDrafts = readFunnelFormDrafts(body.formDrafts, type);
      if (!formDrafts) return Response.json({ ok: false, error: "form_draft" }, { status: 400 });
      // What a scam asks for is never asked (568 [GD2] (c)): a typed question is refused before anything is made.
      for (const draft of Object.values(formDrafts)) {
        const sensitive = sensitiveFieldOf({ fields: draft.fields.map((field) => ({ ...field, label: String((field as { label?: unknown }).label ?? "") })) as never });
        if (sensitive) return Response.json({ ok: false, error: "form_sensitive", field: sensitive.label, why: SENSITIVE_WHY[sensitive.what] }, { status: 400 });
      }
      const pageCopy = readFunnelPageCopy(body.pageCopy, type);
      if (!pageCopy) return Response.json({ ok: false, error: "page_copy" }, { status: 400 });
      // A draft's words for the page's other blocks (lib/funnel-ai-rules.ts), held to each block's limits.
      const blockCopy = readFunnelBlockCopy(body.blockCopy, type);
      if (!blockCopy) return Response.json({ ok: false, error: "page_copy" }, { status: 400 });
      if (store.sitePages.length + pages.length > MAX_SITE_PAGES) return Response.json({ ok: false, error: "pages_full" }, { status: 400 });

      // Each product chosen is the store's, once, and the kind the role asks for.
      const chosen = body.products && typeof body.products === "object" ? (body.products as Record<string, unknown>) : {};
      const free = new Set(idsOfKind(store, "free"));
      const calls = new Set(idsOfKind(store, "call"));
      const known = new Set(store.catalog.items.map((item) => item.id));
      const picked: Record<string, string> = {};
      for (const slot of choicesOf(type)) {
        const id = text(chosen[slot.key], 40);
        const problem = slotProblem(slot, id && known.has(id) ? { free: free.has(id), call: calls.has(id) } : null);
        if (problem) return Response.json({ ok: false, error: `slot_${problem}`, slot: slot.key }, { status: 400 });
        if (Object.values(picked).includes(id)) return Response.json({ ok: false, error: "slot_twice", slot: slot.key }, { status: 400 });
        picked[slot.key] = id;
      }

      const formsNeeded = pages.filter(page => page.form && page.blocks.includes("form")).length;
      if (formsNeeded && !(await canAddForms(statsId, formsNeeded))) return Response.json({ ok: false, error: "forms_full" }, { status: 400 });

      // The pages, at addresses of their own, out of the menu: they belong to the funnel.
      const taken = new Set(store.sitePages.map((page) => page.slug));
      const made: { slot: (typeof pages)[number]; page: SitePage }[] = [];
      const formsMade: Record<string, string> = {};
      for (const slot of pages) {
        let slug = freeSlug(slot.slug, taken);
        if (slugProblem(slug, store.sitePages) === "reserved") slug = freeSlug(`${slot.slug}-page`, taken);
        taken.add(slug);
        made.push({ slot, page: { id: randomBytes(5).toString("hex"), slug, title: slot.title, nav: false, target: slot.target ? picked[slot.target] : "", from: -1 } });
      }
      if (made.length) {
        setupStarted = true;
        const saved = await appendSitePages(guarded.ref, made.map((m) => m.page));
        if (!saved.ok) return Response.json({ ok: false, error: "pages_changed" }, { status: 409 });
        if (!saved.store.statsId) throw new Error("Saved pages have no store identity");
        for (const { slot, page } of made) {
          const blocks = slot.blocks.map((kind) => emptyBlock(kind));
          const copy = pageCopy[slot.key];
          const hero = blocks[0];
          if (hero?.kind === "hero") Object.assign(hero, { headline: copy?.headline || slot.title, media: "none" });
          let introBlock: (typeof blocks)[number] | null = null;
          if (copy?.intro) {
            const intro = emptyBlock("text");
            introBlock = intro;
            if (intro.kind === "text") {
              intro.body = copy.intro;
              blocks.splice(1, 0, intro);
            }
          }
          const words = blockCopy[slot.key];
          if (words) {
            // The type's own blocks, never the introduction added above them.
            const first = <K extends (typeof blocks)[number]["kind"]>(kind: K) => blocks.find((block) => block.kind === kind && block !== introBlock) as Extract<(typeof blocks)[number], { kind: K }> | undefined;
            const top = first("hero"), text = first("text"), steps = first("steps"), fit = first("fit"), faq = first("faq"), cta = first("cta");
            if (words.sub && top) top.sub = words.sub;
            if (words.text && text) Object.assign(text, { heading: words.text.heading, body: words.text.body });
            if (words.steps && steps) Object.assign(steps, { heading: words.steps.heading, items: words.steps.items });
            if (words.fit && fit) Object.assign(fit, { yes: words.fit.yes, no: words.fit.no });
            if (words.faq && faq) faq.items = words.faq;
            if (words.cta && cta) cta.label = words.cta;
          }
          // The form the page asks, made with it: questions only, nothing claimed (lib/funnel-types.ts).
          const asks = blocks.find((block) => block.kind === "form");
          if (slot.form && asks?.kind === "form") {
            const draft = formDrafts[slot.key];
            const fields = draft?.fields ?? slot.form.fields;
            const form = parseForm({
              id: newFormId(),
              name: `${slot.form.name}: ${name}`.slice(0, 60),
              fields: fields.map((field) => ({ id: newFormId(6), options: [], ...field })),
              offerList: draft ? draft.offerList : slot.form.fields.some((field) => field.type === "email"),
              updatedAt: Math.floor(Date.now() / 1000),
            });
            if (!form || !(await writeForm(saved.store.statsId, form))) throw new Error("Required funnel form could not be saved");
            asks.form = form.id;
            formsMade[slot.key] = form.id;
          }
          await writePage(saved.store.statsId, siteKey(page.id), { ...parsePage({}), blocks, hidden: true }, saved.store);
        }
      }

      const steps: PageFunnelStep[] = type.slots.flatMap((slot): PageFunnelStep[] => {
        if (slot.kind === "page") return [{ kind: "page", id: made.find((m) => m.slot.key === slot.key)!.page.id }];
        if (slot.kind === "product") return [{ kind: "product", id: picked[slot.key] }];
        return [];
      });
      let slug = funnelSlugFrom(name) || "funnel";
      for (let n = 2; funnelSlugProblem(slug, existing) !== null && n < 100; n += 1) slug = `${(funnelSlugFrom(name) || "funnel").slice(0, 36)}-${n}`;
      setupStarted = true;
      const kept = await writePageFunnel(statsId, { id: newFunnelId(), name, slug, steps, on: false, since: Math.floor(Date.now() / 1000) }, existing, store);
      return Response.json({ ok: true, funnel: kept, pages: made.map((m) => ({ id: m.page.id, title: m.page.title, slug: m.page.slug })), forms: formsMade });
    }

    const read = readFunnelInput(body.funnel, existing, Math.floor(Date.now() / 1000));
    if (!read.ok) return Response.json({ ok: false, error: read.error }, { status: 400 });
    const { funnel } = read;

    // Each step is a page or a product this store has, as it stands now.
    const productIds = funnel.steps.filter((s) => s.kind === "product").map((s) => s.id);
    const products = productIds.length ? await readListings(store, productIds) : [];
    for (const step of funnel.steps.slice(0, MAX_FUNNEL_PAGES)) {
      if (step.kind === "page" && !store.sitePages.some((p) => p.id === step.id)) {
        return Response.json({ ok: false, error: "page" }, { status: 400 });
      }
      if (step.kind === "product") {
        const problem = productStepProblem(products.find((p) => p.id === step.id) ?? null);
        if (problem === "gone" || problem === "call") return Response.json({ ok: false, error: problem }, { status: 400 });
      }
    }

    const kept = await writePageFunnel(statsId, funnel, existing, store);
    return Response.json({ ok: true, funnel: kept });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full", message: error.message }, { status: 409 });
    console.error("saving a funnel of pages failed", error);
    return Response.json({ ok: false, error: setupStarted ? "setup_incomplete" : "server_error" }, { status: 500 });
  }
}
