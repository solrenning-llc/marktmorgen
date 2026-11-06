/**
 * Moving a ClickFunnels funnel (added 17 October 2026): the creator's saved
 * pages (lib/clickfunnels-page.ts), each given its place in the journey, made
 * into this platform's own pieces.
 *
 * ClickFunnels keeps a funnel's order, its checkouts and its offers in its own
 * account and exports none of it (docs/clickfunnels-import.md), so the creator
 * says, page by page, what each one was:
 *
 *   page       one of the store's own pages (lib/site-page-rules.ts), with the
 *              page's words in blocks, kept back from visitors until the
 *              creator lets it out; its form, when it had one, made under Forms
 *   checkout   ClickFunnels' order form: here, the product's own page and
 *              checkout take the step's place. The words of the page are not
 *              copied; each order bump it had becomes a box at that checkout
 *              (lib/product-extras.ts) for the product the creator picks
 *   upsell     an offer after paying for the checkout before it, one click
 *              (lib/funnel.ts), with the page's headline and first lines
 *   downsell   the offer shown to whoever says no to the upsell just before it
 *   skip       left out
 *
 * and the pages and checkouts become one funnel of pages (lib/page-funnel.ts),
 * in the order given, switched off until the creator switches it on.
 *
 * planFunnelImport is the dry run: everything checked against the store as it
 * stands, every piece to be made listed, every problem said, and nothing
 * written. saveFunnelImport makes it, after the same plan again under the
 * store's own lock for this, and only when the plan has no error.
 *
 * Doing it twice makes nothing twice. Each run is written down by what it was
 * asked (a key made from the pages and choices); asking the same again answers
 * with what the first made. A page already made by an earlier run, and still
 * there, is used again rather than made again, so a run that stopped partway
 * is finished by running it again. A box at checkout for a product already
 * offered there, and offers after paying on a product that already has them,
 * are left as they are and said so.
 *
 * Nothing here costs per use: no email is sent, no AI is asked, no file is
 * stored or fetched. What is made is bounded by the limits the store already
 * has: ten own pages, twenty forms, ten funnels, three boxes at checkout and
 * five offers after paying per product, a page's own weight.
 */
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import { type Listing, type Store, appendSitePages, ensureStatsId, setProductExtras, setProductFunnel, storeForId, storeRef } from "@/lib/store";
import { idsOfKind, readListings, readProduct } from "@/lib/catalog";
import { offerableAfterPaying } from "@/lib/bundles";
import { MAX_BLOCKS, type PageBlock, oversized, pageProblem, parsePage, picturePaths } from "@/lib/sales-page";
import { writePage } from "@/lib/sales-page-store";
import { MAX_SITE_PAGES, SITE_KINDS, type SitePage, siteKey, siteTitle, slugFrom, slugProblem } from "@/lib/site-page-rules";
import { freeSlug } from "@/lib/funnel-types";
import { MAX_FUNNEL_PAGES, MAX_PAGE_FUNNELS, type PageFunnelStep, funnelSlugFrom, funnelSlugProblem, newFunnelId, productStepProblem, MAX_FUNNEL_NAME } from "@/lib/page-funnel";
import { readPageFunnelsStrict, writePageFunnel } from "@/lib/page-funnel-store";
import { MAX_BUTTON, MAX_FIELDS, MAX_FORM_NAME, MAX_LABEL, newFormId, parseForm } from "@/lib/forms";
import { canAddForms, writeForm } from "@/lib/form-store";
import { type Funnel, MAX_FUNNEL_STEPS, MAX_HEADLINE_LENGTH, MAX_STEP_TEXT_LENGTH, funnelProblem, parseFunnel } from "@/lib/funnel";
import { MAX_BUMPS, MAX_PITCH_LENGTH, canBeBumped, isOneOff } from "@/lib/product-extras";
import { currencyRule, formatMoney } from "@/lib/money";
import { type FormSpec, MAX_IMPORTED_BUMPS, type PageDraft } from "@/lib/clickfunnels-page";

/** Pages one funnel import reads: as many as a store has own pages. */
export const MAX_IMPORT_PAGES = MAX_SITE_PAGES;

export type PageRole = "page" | "checkout" | "upsell" | "downsell" | "skip";
const ROLES: readonly PageRole[] = ["page", "checkout", "upsell", "downsell", "skip"];

/** One saved page, as the studio sends it back with the creator's choices. */
export type ImportPage = {
  file: string;
  role: PageRole;
  /** page: where its buttons lead ("" for the funnel's next step); checkout: the product sold; upsell and downsell: the product offered. */
  product: string;
  /** checkout: the product offered in each of the page's order bumps, "" for none. */
  bumps: string[];
  /** What lib/clickfunnels-page.ts read from the file, as the server answered it. */
  draft: Pick<PageDraft, "title" | "blocks" | "form" | "bumps" | "offer">;
};

export type FunnelImportInput = { name: string; pages: ImportPage[] };

export type PlanAction =
  | { kind: "page"; file: string; title: string; slug: string; blocks: number; form: number; target: string; again: boolean }
  | { kind: "step"; position: number; title: string; what: "page" | "product" }
  | { kind: "bump"; file: string; owner: string; offered: string; price: string; pitch: string; again: boolean }
  | { kind: "offer"; file: string; owner: string; offered: string; price: string; headline: string; yes: string; no: string }
  | { kind: "funnel"; name: string; slug: string; steps: number };

export type PlanIssue = { level: "error" | "warning"; file: string; text: string };

export type Plan = { actions: PlanAction[]; issues: PlanIssue[]; key: string; done: SavedImport | null; partial?: string };

export type SavedImport = { funnel: { id: string; name: string; slug: string }; pages: string[]; bumps: number; offers: number; at: number };

const ledgerKey = (sid: string) => `nl:imports:cf:${sid}`;
const lockKey = (sid: string) => `nl:imports:cf:lock:${sid}`;
const LEDGER_SECONDS = 400 * 86_400;

const oneLine = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** A page's own fingerprint: the same file read the same way is the same page, whichever run made it. */
const pageKeyOf = (page: ImportPage) => digest(["page", page.draft.title, page.draft.blocks, page.draft.form, page.product]);

type Checked = { page: ImportPage; blocks: PageBlock[]; form: FormSpec | null; problem: string };

/** The studio's copy of a page draft, checked here as the page editor checks a page: what could not be one is said, never guessed. */
function checkDraft(raw: unknown): Checked {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const file = oneLine(value.file, 120) || "A page";
  const role = ROLES.includes(value.role as PageRole) ? (value.role as PageRole) : "skip";
  const product = typeof value.product === "string" && /^[A-Za-z0-9_-]{0,40}$/.test(value.product) ? value.product : "";
  const bumps = Array.isArray(value.bumps) ? value.bumps.slice(0, MAX_IMPORTED_BUMPS).map((b) => (typeof b === "string" && /^[A-Za-z0-9_-]{0,40}$/.test(b) ? b : "")) : [];
  const draft = value.draft && typeof value.draft === "object" ? (value.draft as Record<string, unknown>) : {};
  const title = siteTitle(draft.title);
  const sent = Array.isArray(draft.blocks) ? draft.blocks : [];
  const parsed = parsePage({ blocks: sent });
  const offerRaw = draft.offer && typeof draft.offer === "object" ? (draft.offer as Record<string, unknown>) : {};
  const offer = { headline: oneLine(offerRaw.headline, MAX_HEADLINE_LENGTH), text: oneLine(offerRaw.text, MAX_STEP_TEXT_LENGTH) };
  const pitches = Array.isArray(draft.bumps)
    ? draft.bumps.slice(0, MAX_IMPORTED_BUMPS).map((b) => ({ pitch: oneLine(b && typeof b === "object" ? (b as Record<string, unknown>).pitch : "", MAX_PITCH_LENGTH) }))
    : [];
  let form: FormSpec | null = null;
  let problem = "";
  if (draft.form && typeof draft.form === "object") {
    const spec = draft.form as Record<string, unknown>;
    const fields = Array.isArray(spec.fields) ? spec.fields.slice(0, MAX_FIELDS + 1) : [];
    const read = fields.map((f) => {
      const row = f && typeof f === "object" ? (f as Record<string, unknown>) : {};
      const type = row.type === "email" || row.type === "long" || row.type === "short" ? row.type : null;
      return type ? { type, label: oneLine(row.label, MAX_LABEL), required: row.required === true } : null;
    });
    if (!read.length || read.length > MAX_FIELDS || read.some((f) => !f || !f.label)) problem = "Its form could not be read. Choose the file again.";
    else form = { fields: read as FormSpec["fields"], button: oneLine(spec.button, MAX_BUTTON) };
  }
  const page: ImportPage = { file, role, product, bumps, draft: { title, blocks: parsed.blocks, form, bumps: pitches, offer } };
  if (!problem && role === "page") {
    if (!title) problem = "It has no title. Choose the file again.";
    else if (pageProblem({ blocks: sent }, parsed)) problem = "Its blocks could not be read as a page. Choose the file again.";
    else if (sent.length > MAX_BLOCKS || oversized(parsed)) problem = "It holds more than one page can.";
    else if (parsed.blocks.some((b) => !SITE_KINDS.includes(b.kind))) problem = "It has a block a store's own page cannot have. Choose the file again.";
    // A picture is never brought over from a file: a page may show only a picture the door gave it or one it already
    // shows (lib/picture-door.ts), as the funnel bundle refuses them too (Claude 4 on #2156).
    else if (picturePaths(parsed).length) problem = "It has a picture, which cannot be brought over. Choose the file again, then add your pictures in the page editor.";
    else if (parsed.blocks.filter((b) => b.kind === "form").length > 1 || (parsed.blocks.some((b) => b.kind === "form") !== Boolean(form))) problem = "Its form could not be read. Choose the file again.";
    else if (parsed.blocks.length === 0) problem = "Nothing on it could be brought over: there is no page to make.";
  }
  return { page, blocks: parsed.blocks, form, problem };
}

/** The import's input, read: its name, and each page checked. */
function readInput(raw: unknown): { name: string; pages: Checked[]; problem: string } {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const name = oneLine(value.name, MAX_FUNNEL_NAME) || "Funnel from ClickFunnels";
  const list = Array.isArray(value.pages) ? value.pages : [];
  if (list.length === 0) return { name, pages: [], problem: "Choose at least one saved page." };
  if (list.length > MAX_IMPORT_PAGES) return { name, pages: [], problem: `One import reads up to ${MAX_IMPORT_PAGES} pages.` };
  return { name, pages: list.map(checkDraft), problem: "" };
}

/** The key a run is written down under: the same pages and choices, the same key. */
function runKey(name: string, pages: Checked[]): string {
  return digest(["run", name, pages.map((c) => [c.page.role, c.page.product, c.page.bumps, pageKeyOf(c.page), c.page.draft.offer])]);
}

async function readLedger(sid: string, fields: string[]): Promise<(string | null)[]> {
  if (!fields.length || !isRedisConfigured()) return fields.map(() => null);
  const [found] = await redisPipeline([["HMGET", ledgerKey(sid), ...fields]]);
  return fields.map((_, i) => (Array.isArray(found) && typeof found[i] === "string" ? (found[i] as string) : null));
}

/** A run that stopped after making its funnel of pages: that funnel's id, to use again rather than make a second. */
function parsePartial(raw: string | null): string {
  if (!raw) return "";
  try {
    const value = JSON.parse(raw) as { state?: string; funnel?: string };
    return value && value.state === "funnel" && typeof value.funnel === "string" ? value.funnel : "";
  } catch {
    return "";
  }
}

function parseSaved(raw: string | null): SavedImport | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SavedImport & { state?: string };
    return value && value.state === "done" && value.funnel && typeof value.funnel.id === "string" ? value : null;
  } catch {
    return null;
  }
}

const money = (cents: number, store: Store) => formatMoney(cents, store.currency);

type Built = {
  plan: Plan;
  /** What saving makes, in order, when the plan has no error. */
  make: {
    pages: { checked: Checked; again: string | null; slug: string; target: string }[];
    steps: ({ kind: "made"; at: number } | { kind: "product"; id: string })[];
    bumps: { owner: string; bump: { productId: string; priceCents: number; pitch: string } }[];
    offers: { owner: string; funnel: Funnel }[];
    funnel: { name: string; slug: string };
  };
};

/** The plan, from the store as it stands. Reads only. */
async function build(store: Store, raw: unknown): Promise<Built> {
  const issues: PlanIssue[] = [];
  const actions: PlanAction[] = [];
  const error = (file: string, text: string) => issues.push({ level: "error", file, text });
  const warn = (file: string, text: string) => issues.push({ level: "warning", file, text });
  const input = readInput(raw);
  const empty: Built["make"] = { pages: [], steps: [], bumps: [], offers: [], funnel: { name: input.name, slug: "" } };
  if (input.problem) {
    error("", input.problem);
    return { plan: { actions, issues, key: "", done: null }, make: empty };
  }
  const key = runKey(input.name, input.pages);
  const twice = new Set<string>();
  const once = new Set<string>();
  for (const c of input.pages) {
    if (c.page.role === "skip") continue;
    const k = pageKeyOf(c.page);
    if (once.has(k)) twice.add(c.page.file);
    once.add(k);
  }
  for (const file of twice) error(file, "The same page is chosen twice. Remove one of them.");
  const sid = store.sid ?? "";
  const pageKeys = input.pages.map((c) => `page:${pageKeyOf(c.page)}`);
  const [runRaw, ...madeIds] = await readLedger(sid, [`run:${key}`, ...pageKeys]);
  const done = parseSaved(runRaw);
  const partial = parsePartial(runRaw);

  // Only the products the pages name are read, not the whole catalog.
  const named = new Set(input.pages.flatMap((c) => [c.page.product, ...c.page.bumps]).filter(Boolean));
  const listings = named.size ? await readListings(store, named) : [];
  const byId = new Map(listings.map((p) => [p.id, p]));
  const title = (id: string) => byId.get(id)?.title ?? "a deleted product";
  const least = currencyRule(store.currency).minCharge;
  for (const c of input.pages) if (c.problem && c.page.role !== "skip") error(c.page.file, c.problem);

  // The store's own pages: room for the new ones, an address each.
  const taken = new Set(store.sitePages.map((p) => p.slug));
  const make: Built["make"] = { ...empty, pages: [], steps: [], bumps: [], offers: [] };
  // Each page's step, by its place in the file list: the funnel walks them in that order.
  const stepAt: (Built["make"]["steps"][number] | null)[] = input.pages.map(() => null);
  let newPages = 0;
  input.pages.forEach((c, i) => {
    if (c.page.role !== "page" || c.problem) return;
    const target = c.page.product;
    if (target && !byId.has(target)) error(c.page.file, "The product its buttons lead to is not in your store.");
    const earlier = madeIds[i];
    const again = earlier && store.sitePages.some((p) => p.id === earlier) ? earlier : null;
    let slug = again ? store.sitePages.find((p) => p.id === again)!.slug : "";
    if (!again) {
      newPages += 1;
      const base = slugFrom(c.page.draft.title) || "page";
      slug = freeSlug(base, taken);
      if (slugProblem(slug, store.sitePages) === "reserved") slug = freeSlug(`${base}-page`, taken);
      taken.add(slug);
    }
    make.pages.push({ checked: c, again, slug, target });
    stepAt[i] = { kind: "made", at: make.pages.length - 1 };
    actions.push({
      kind: "page",
      file: c.page.file,
      title: c.page.draft.title,
      slug,
      blocks: c.blocks.length,
      form: c.form ? c.form.fields.length : 0,
      target: target ? title(target) : "",
      again: Boolean(again),
    });
    if (again) warn(c.page.file, "An earlier import already made this page, and it is still in your store: it is used again, not made twice.");
  });
  if (store.sitePages.length + newPages > MAX_SITE_PAGES) {
    error("", `Your store has room for ${Math.max(0, MAX_SITE_PAGES - store.sitePages.length)} more of its own pages (${MAX_SITE_PAGES} in all), and this import makes ${newPages}. Remove pages you no longer use, or leave some of these out.`);
  }
  const formsNeeded = make.pages.filter((p) => !p.again && p.checked.form).length;
  if (formsNeeded && store.statsId && !(await canAddForms(store.statsId, formsNeeded))) {
    error("", `This import makes ${formsNeeded} ${formsNeeded === 1 ? "form" : "forms"}, and your store has no room for ${formsNeeded === 1 ? "it" : "them"} under Forms. Remove forms you no longer use first.`);
  }

  // Checkouts: the product's own page, its boxes at checkout, and the offers after it.
  let owner: Listing | null = null;
  const offersBy = new Map<string, { file: string; role: "upsell" | "downsell"; product: Listing; headline: string; text: string }[]>();
  const withFunnel = new Set(idsOfKind(store, "funnel"));
  for (const [i, c] of input.pages.entries()) {
    const { role, file } = c.page;
    if (role === "checkout") {
      const product = byId.get(c.page.product) ?? null;
      if (!product) {
        error(file, c.page.product ? "The product chosen for this checkout is not in your store." : "Choose the product this checkout sells.");
        owner = null;
        continue;
      }
      const problem = productStepProblem(product);
      if (problem === "call") {
        error(file, `${product.title} is a call, booked on a page of its own, so it cannot be a step.`);
        owner = null;
        continue;
      }
      if (problem === "hidden") warn(file, `${product.title} is a draft: the funnel passes over it until you publish it.`);
      owner = product;
      stepAt[i] = { kind: "product", id: product.id };
      warn(file, `This step becomes ${product.title}'s own page and checkout. The words of the saved page are not copied onto it; edit its page in the studio.`);
      // Its order bumps, each a box at this checkout.
      const already = [...product.bumps];
      c.page.bumps.forEach((offeredId, b) => {
        const pitch = c.page.draft.bumps[b]?.pitch ?? "";
        if (!offeredId) {
          if (pitch) warn(file, `Order bump left out: "${pitch}".`);
          return;
        }
        const offered = byId.get(offeredId) ?? null;
        if (!isOneOff(product) || product.pwyw) {
          error(file, `${product.title} cannot have a box at checkout: only a one-time paid product with one price can.`);
          return;
        }
        if (!offered || offered.id === product.id || !canBeBumped(offered)) {
          error(file, `${offered ? offered.title : "That product"} cannot be offered in a box at checkout: it needs one price, something to hand over, and no limited quantity.`);
          return;
        }
        if (already.some((x) => x.productId === offered.id)) {
          actions.push({ kind: "bump", file, owner: product.title, offered: offered.title, price: money(offered.priceCents, store), pitch, again: true });
          warn(file, `${offered.title} is already offered at ${product.title}'s checkout: left as it is.`);
          return;
        }
        if (already.length >= MAX_BUMPS) {
          error(file, `${product.title}'s checkout already has ${MAX_BUMPS} boxes, the most it can have.`);
          return;
        }
        if (offered.priceCents < least) {
          error(file, `${offered.title} costs less than the smallest amount a card can be charged.`);
          return;
        }
        already.push({ productId: offered.id, priceCents: offered.priceCents, pitch });
        make.bumps.push({ owner: product.id, bump: { productId: offered.id, priceCents: offered.priceCents, pitch } });
        actions.push({ kind: "bump", file, owner: product.title, offered: offered.title, price: money(offered.priceCents, store), pitch, again: false });
      });
      continue;
    }
    if (role === "upsell" || role === "downsell") {
      if (!owner) {
        error(file, "An offer after paying follows a checkout: put a checkout before it.");
        continue;
      }
      const product = byId.get(c.page.product) ?? null;
      if (!product) {
        error(file, c.page.product ? "The product chosen for this offer is not in your store." : "Choose the product this offer sells.");
        continue;
      }
      const list = offersBy.get(owner.id) ?? [];
      if (role === "downsell" && list[list.length - 1]?.role !== "upsell") {
        error(file, "An offer after a no comes right after an offer after paying: put it just after one.");
        continue;
      }
      list.push({ file, role, product, headline: c.page.draft.offer.headline, text: c.page.draft.offer.text });
      offersBy.set(owner.id, list);
    }
  }
  make.steps = stepAt.filter((step): step is NonNullable<typeof step> => step !== null);

  // Offers after paying, one funnel per checkout product, linked as ClickFunnels walks them.
  const offerable = await offerableAfterPaying(store, listings);
  for (const [ownerId, list] of offersBy) {
    const ownerListing = byId.get(ownerId)!;
    const file = list[0].file;
    if (list.length > MAX_FUNNEL_STEPS) {
      error(file, `${ownerListing.title} can have up to ${MAX_FUNNEL_STEPS} offers after paying, and this import gives it ${list.length}.`);
      continue;
    }
    const ids = list.map((_, i) => `cfo${i}`);
    const nextUpsell = (i: number) => {
      for (let j = i + 1; j < list.length; j += 1) if (list[j].role === "upsell") return ids[j];
      return null;
    };
    const funnel = parseFunnel({
      steps: list.map((o, i) => ({
        id: ids[i],
        productId: o.product.id,
        priceCents: o.product.priceCents,
        headline: o.headline,
        text: o.text,
        imageFrom: null,
        yes: nextUpsell(i),
        no: o.role === "upsell" && list[i + 1]?.role === "downsell" ? ids[i + 1] : nextUpsell(i),
      })),
    });
    const problem = funnel ? funnelProblem(funnel, offerable, ownerListing) : "shape";
    if (!funnel || problem) {
      const words: Record<string, string> = {
        kind: `${ownerListing.title} cannot have offers after paying: only a one-time paid product can.`,
        target: "One of the products offered cannot be offered in one click: it needs one price and something to hand over, and cannot be the product just bought.",
        price: "One of the products offered costs less than the smallest amount a card can be charged.",
        repeat: "The same product is offered twice to someone who already took it.",
        shape: "These offers could not be linked into a funnel.",
      };
      error(file, words[problem ?? "shape"] ?? words.shape);
      continue;
    }
    if (funnel.steps.some((s) => s.priceCents < least)) {
      error(file, "One of the products offered costs less than the smallest amount a card can be charged.");
      continue;
    }
    if (withFunnel.has(ownerId)) {
      const current = await readProduct(store, ownerId);
      const same = current?.funnel && current.funnel.steps.map((s) => s.productId).join() === funnel.steps.map((s) => s.productId).join();
      warn(file, same
        ? `${ownerListing.title} already has these offers after paying: left as they are.`
        : `${ownerListing.title} already has offers after paying of its own: they are left as they are, and these are not added. Change them on the product in the studio.`);
      continue;
    }
    const label = (id: string | null) => (id === null ? "the end" : `offer ${ids.indexOf(id) + 1}`);
    funnel.steps.forEach((step, i) => {
      actions.push({ kind: "offer", file: list[i].file, owner: ownerListing.title, offered: title(step.productId), price: money(step.priceCents, store), headline: step.headline, yes: label(step.yes), no: label(step.no) });
    });
    make.offers.push({ owner: ownerId, funnel });
  }

  // The funnel of pages itself.
  if (make.steps.length === 0) error("", "Nothing to make a funnel of: say for at least one page that it is a page or a checkout.");
  if (make.steps.length > MAX_FUNNEL_PAGES) error("", `A funnel has up to ${MAX_FUNNEL_PAGES} steps.`);
  let funnels: { id: string; slug: string }[] = [];
  try {
    funnels = await readPageFunnelsStrict(store.statsId);
  } catch {
    if (store.statsId) error("", "Your funnels could not be read just now, so nothing can be checked against them. Try again in a moment.");
  }
  const resumed = partial && funnels.some((f) => f.id === partial) ? partial : "";
  if (funnels.length >= MAX_PAGE_FUNNELS && !done && !resumed) error("", `Your store has ${MAX_PAGE_FUNNELS} funnels, the most it can have. Remove one you no longer use first.`);
  const base = funnelSlugFrom(input.name) || "funnel";
  let slug = base;
  for (let n = 2; funnelSlugProblem(slug, funnels) !== null && n < 100; n += 1) slug = `${base.slice(0, 36)}-${n}`;
  make.funnel = { name: input.name, slug };
  let position = 0;
  for (const step of make.steps) {
    position += 1;
    if (step.kind === "made") actions.push({ kind: "step", position, title: make.pages[step.at].checked.page.draft.title, what: "page" });
    else actions.push({ kind: "step", position, title: title(step.id), what: "product" });
  }
  actions.push({ kind: "funnel", name: input.name, slug, steps: make.steps.length });
  if (input.pages.every((c) => c.page.role === "skip")) error("", "Every page is left out.");
  if (resumed) warn("", "An earlier import of these pages stopped partway after making the funnel: it is finished now, with the funnel it made.");
  return { plan: { actions, issues, key, done, ...(resumed ? { partial: resumed } : {}) }, make };
}

/** The dry run: what would be made, and why anything would not. Writes nothing. */
export async function planFunnelImport(store: Store, raw: unknown): Promise<Plan> {
  return (await build(store, raw)).plan;
}

export type SaveResult =
  | { ok: true; saved: SavedImport; again: boolean; problems: string[] }
  | { ok: false; reason: "plan" | "busy" | "pages_changed" | "unavailable"; plan?: Plan };

/**
 * Makes the funnel the plan describes. Under the store's own lock for this,
 * so two presses make one; the plan is made again here, from the store as it
 * is now, and nothing is made when it has an error.
 */
export async function saveFunnelImport(store: Store, raw: unknown): Promise<SaveResult> {
  if (!isRedisConfigured() || !store.sid) return { ok: false, reason: "unavailable" };
  const sid = store.sid;
  let held;
  try {
    held = await takeLock(lockKey(sid), 120, 3_000);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    throw error;
  }
  try {
    let current = (await storeForId(sid)) ?? store;
    if (!current.statsId) current = (await ensureStatsId(storeRef(current))) ?? current;
    if (!current.statsId) return { ok: false, reason: "unavailable" };
    const statsId = current.statsId;
    const { plan, make } = await build(current, raw);
    if (plan.done) return { ok: true, saved: plan.done, again: true, problems: [] };
    if (plan.issues.some((i) => i.level === "error")) return { ok: false, reason: "plan", plan };
    const ledger = ledgerKey(sid);
    await redisPipeline([["HSET", ledger, `run:${plan.key}`, JSON.stringify({ state: "started", at: Date.now() })], ["EXPIRE", ledger, LEDGER_SECONDS]]);

    // The pages, all added at once to the store as it is now.
    const fresh = make.pages.filter((p) => !p.again);
    const ids = new Map<number, string>();
    make.pages.forEach((p, i) => {
      if (p.again) ids.set(i, p.again);
    });
    const added: SitePage[] = fresh.map((p) => ({ id: randomBytes(5).toString("hex"), slug: p.slug, title: p.checked.page.draft.title, nav: false, target: p.target, from: -1 }));
    if (added.length) {
      const saved = await appendSitePages(storeRef(current), added);
      if (!saved.ok) return { ok: false, reason: "pages_changed" };
    }
    let k = 0;
    for (const [i, p] of make.pages.entries()) {
      if (p.again) continue;
      const page = added[k++];
      ids.set(i, page.id);
      const blocks = p.checked.blocks.map((b) => ({ ...b }));
      const asks = blocks.find((b) => b.kind === "form");
      if (p.checked.form && asks?.kind === "form") {
        const spec = p.checked.form;
        const form = parseForm({
          id: newFormId(),
          name: p.checked.page.draft.title.slice(0, MAX_FORM_NAME),
          fields: spec.fields.map((f) => ({ id: newFormId(6), options: [], ...f })),
          button: spec.button,
          // Visitors who give an email are offered the box to hear more; nobody is added without ticking it.
          offerList: spec.fields.some((f) => f.type === "email"),
          updatedAt: Math.floor(Date.now() / 1000),
        });
        if (!form || !(await writeForm(statsId, form))) throw new Error("an imported page's form could not be saved");
        asks.form = form.id;
      }
      await writePage(statsId, siteKey(page.id), { ...parsePage({}), blocks, hidden: true }, current);
      await redisPipeline([["HSET", ledger, `page:${pageKeyOf(p.checked.page)}`, page.id]]);
    }

    // The funnel of pages, switched off.
    const steps: PageFunnelStep[] = make.steps.map((s) => (s.kind === "made" ? { kind: "page", id: ids.get(s.at)! } : { kind: "product", id: s.id }));
    const existing = await readPageFunnelsStrict(statsId);
    const before = plan.partial ? existing.find((f) => f.id === plan.partial) ?? null : null;
    let funnel;
    if (before) funnel = await writePageFunnel(statsId, { ...before, steps }, existing, current);
    else {
      let slug = make.funnel.slug;
      for (let n = 2; funnelSlugProblem(slug, existing) !== null && n < 100; n += 1) slug = `${(funnelSlugFrom(make.funnel.name) || "funnel").slice(0, 36)}-${n}`;
      funnel = await writePageFunnel(statsId, { id: newFunnelId(), name: make.funnel.name, slug, steps, on: false, since: Math.floor(Date.now() / 1000) }, existing, current);
    }
    await redisPipeline([["HSET", ledger, `run:${plan.key}`, JSON.stringify({ state: "funnel", funnel: funnel.id, at: Date.now() })]]);

    // Boxes at checkout and offers after paying, each checked once more as it is saved.
    const problems: string[] = [];
    const ref = storeRef(current);
    let bumps = 0;
    for (const { owner, bump } of make.bumps) {
      const product = await readProduct((await storeForId(sid)) ?? current, owner);
      const slot = product ? product.bumps.length : 0;
      const result = await setProductExtras(ref, owner, { bump, slot });
      if (result.ok) bumps += 1;
      else problems.push(`A box at checkout could not be added (${result.reason}).`);
    }
    let offers = 0;
    for (const { owner, funnel: offered } of make.offers) {
      const result = await setProductFunnel(ref, owner, offered);
      if (result.ok) offers += offered.steps.length;
      else problems.push(`Offers after paying could not be added (${result.reason}).`);
    }

    const saved: SavedImport = { funnel: { id: funnel.id, name: funnel.name, slug: funnel.slug }, pages: [...ids.values()], bumps, offers, at: Date.now() };
    await redisPipeline([["HSET", ledger, `run:${plan.key}`, JSON.stringify({ state: "done", ...saved })], ["EXPIRE", ledger, LEDGER_SECONDS]]);
    return { ok: true, saved, again: false, problems };
  } finally {
    await releaseLock(held);
  }
}
