/**
 * Copying a whole store into another store of the same account (added 18
 * October 2026; HighLevel's snapshots, docs/zero-cost-value-2026-10-18.md
 * item 4). The rules, pure: what comes across, what never does, what a copy
 * needs in the other store, and the words that say so before anything is
 * written. lib/store-copy.ts reads the stores and writes the copy.
 *
 * What comes across, into the other store, as drafts:
 *
 *   - the products (their words, prices, schedules, checkout questions,
 *     boxes at checkout, offers after paying, pairings, long descriptions and
 *     pages of blocks), each kept back from the store until the creator
 *     publishes it;
 *   - the store's own pages, out of the menu and kept back from visitors;
 *   - the forms, quizzes and surveys, without a single answer;
 *   - the funnels of pages, off;
 *   - and, only when the creator asks for it, the store page's setup: the
 *     about line, the colors and letters, the links, the social profiles,
 *     the questions and answers, the order of its parts, its sections and
 *     its line of news.
 *
 * What never comes across: customers, orders, contacts, emails, answers to
 * forms, reviews, numbers, payments, payout details, the Stripe or PayPal
 * account, taxes, the domain, the sender of emails and its postal address,
 * the team, integrations and keys, licence keys, and every file and picture
 * (they are the first store's storage). A product whose whole point lives in
 * one of those (a call on the creator's calendar, a course's lessons, a
 * private podcast, options that each deliver their own thing, licence keys)
 * is not copied, and the preview names each.
 *
 * Nothing is cut to fit: when the other store has no room for the whole
 * copy (products, pages, forms, funnels, its data room, its studio requests
 * this month), the preview says which and nothing is written.
 */
import type { Product } from "@/lib/catalog";
import type { PageBlock, SalesPage } from "@/lib/sales-page";
import type { FormDef } from "@/lib/forms";
import type { PageFunnel } from "@/lib/page-funnel";
import type { FunnelStep } from "@/lib/funnel";
import type { StoreSection, Announcement } from "@/lib/store-sections";
import type { StoreLink } from "@/lib/store-link";
import type { Social } from "@/lib/store-socials";
import type { FaqItem } from "@/lib/store-faq";
import type { PagePart } from "@/lib/store-order";

/** The id a creator's copy is known by, made in their browser: a retry with it resumes the same copy and never makes a second one. */
export const COPY_ID = /^[0-9a-f]{32}$/;

/** Products written in one step of a copy: one request, one write under the store's lock. */
export const COPY_STEP_PRODUCTS = 25;

/** How long the record of a copy's progress is kept, so a retry within it resumes. */
export const COPY_KEEP_SECONDS = 7 * 86_400;

/**
 * What one studio request stands for when a step is charged to the other
 * store's studio requests of the month (lib/store-allowance-rules.ts): at
 * most this many store commands and this many bytes through the database,
 * under the studio request's own priced shape of 24 commands and 50 KB
 * (tests/plan-cost-registry.ts, UNIT_COST.studio). A step is never charged
 * less than COPY_MIN_UNITS, for its time.
 */
export const COPY_UNIT_COMMANDS = 20;
export const COPY_UNIT_BYTES = 40_000;
export const COPY_MIN_UNITS = 4;

/**
 * Store commands each kind of thing a step writes may send, at the most
 * (counted from lib/store-copy.ts, and held by tests/store-copy.test.ts
 * against the commands actually sent).
 */
export const COPY_COMMANDS = {
  /** A step's own: its lock taken and let go, the progress record read and written, the data room for it, and its studio requests taken. */
  step: 16,
  /** A product: its two records, its long description (read, room, write) and its page (read, room, three reads, write, sections). */
  product: 14,
  /** The products' one write: the store's lock, record, head and data room. */
  productWrite: 12,
  /** A form: its capacity check and its write. */
  form: 2,
  /** A page: its blocks read, room, three reads and the write, with the store's own write of the pages, counted once a step. */
  page: 8,
  pagesWrite: 12,
  /** A funnel: the store's funnels read once a step, then its room and its write. */
  funnel: 3,
  funnelsRead: 1,
  /** The store page's setup: one write under the lock. */
  setup: 10,
} as const;

export type CopyPhase = "products" | "forms" | "pages" | "funnels" | "setup" | "done";
export const PHASES: CopyPhase[] = ["products", "forms", "pages", "funnels", "setup", "done"];

/** Why a product is not copied, when it is not. */
export type SkipReason = "call" | "course" | "podcast" | "package" | "options" | "keys" | "bundle";

export const SKIP_WORDS: Record<SkipReason, string> = {
  call: "a call booked on your calendar",
  course: "a course, whose lessons and videos are this store's",
  podcast: "a private podcast, whose episodes are this store's",
  package: "a package of calls booked on your calendar",
  options: "options that each deliver their own thing",
  keys: "license keys, which are this store's own",
  bundle: "a bundle holding a product that is not copied",
};

/** Whether a product can be copied, and why not when it cannot. `copyable` is every product id that can (for a bundle's contents). */
export function skipReason(product: Product, copyable?: ReadonlySet<string>): SkipReason | null {
  if (product.call) return "call";
  if (product.course) return "course";
  if (product.podcast) return "podcast";
  if (product.callPackage) return "package";
  if (product.options.length) return "options";
  if (product.keys) return "keys";
  if (product.bundle && copyable && !product.bundle.every((id) => copyable.has(id))) return "bundle";
  return null;
}

/** Maps one of the first store's ids to its copy's id in the other store; "" when it is not copied. */
export type IdMap = (sourceId: string) => string;

/** What a copied product left behind, counted for the words. */
export type ProductLeft = { files: number; pictures: number; notes: number; refs: number };
export const emptyProductLeft = (): ProductLeft => ({ files: 0, pictures: 0, notes: 0, refs: 0 });

/** Offers after paying, mapped: an offer of a product that is not copied goes, and so do the ways that led to it. */
function mappedFunnel(funnel: Product["funnel"], map: IdMap, left: ProductLeft): Product["funnel"] {
  if (!funnel) return null;
  const kept: FunnelStep[] = [];
  for (const step of funnel.steps) {
    const productId = map(step.productId);
    if (!productId) {
      left.refs += 1;
      continue;
    }
    kept.push({ ...step, productId, imageFrom: step.imageFrom ? map(step.imageFrom) || null : null });
  }
  const ids = new Set(kept.map((s) => s.id));
  const steps = kept.map((s) => ({ ...s, yes: s.yes && ids.has(s.yes) ? s.yes : null, no: s.no && ids.has(s.no) ? s.no : null }));
  return steps.length ? { steps } : null;
}

/**
 * The copy of one product, as a draft of the other store with the id `id`:
 * the creator's words, prices, schedules, checkout questions and offers,
 * its shipping and the legal information filled for it (only the main
 * price's net quantity, since options are not copied), with every product it
 * names mapped to that product's copy. Never its file
 * or picture (the first store's storage), its thank-you note or anything
 * sold, counted or answered.
 */
export function copiedProduct(product: Product, id: string, map: IdMap, now: string, left: ProductLeft): Product {
  if (product.file) left.files += 1;
  if (product.image) left.pictures += 1;
  if (product.note) left.notes += 1;
  const mapList = (ids: readonly string[] | null | undefined) => {
    const out: string[] = [];
    for (const source of ids ?? []) {
      const target = map(source);
      if (target) out.push(target);
      else left.refs += 1;
    }
    return out;
  };
  const bumps = product.bumps.flatMap((bump) => {
    const productId = map(bump.productId);
    if (!productId) {
      left.refs += 1;
      return [];
    }
    return [{ ...bump, productId }];
  });
  const legal = product.legal ? { ...product.legal, quantities: product.legal.quantities.filter((quantity) => quantity.price === "") } : null;
  return {
    id,
    title: product.title,
    summary: product.summary,
    priceCents: product.priceCents,
    createdAt: now,
    file: null,
    link: product.link,
    recurring: product.recurring,
    options: [],
    call: null,
    stock: product.stock,
    bumps,
    pairs: mapList(product.pairs),
    funnel: mappedFunnel(product.funnel, map, left),
    plan: product.plan,
    course: null,
    podcast: null,
    callPackage: null,
    image: null,
    display: product.display,
    fields: product.fields,
    pwyw: product.pwyw,
    about: product.about,
    keys: null,
    // Both are about a PDF file it delivers, which does not come across.
    stamp: false,
    preview: 0,
    page: product.page,
    bundle: product.bundle ? mapList(product.bundle) : null,
    pick: product.pick ?? null,
    intro: product.intro ?? null,
    yearly: product.yearly ?? null,
    shipping: product.shipping ?? null,
    ...(legal ? { legal } : {}),
    hidden: true,
  };
}

/** What copied blocks left behind. */
export type BlocksLeft = { pictures: number; refs: number; reviewPicks: number };
export const emptyBlocksLeft = (): BlocksLeft => ({ pictures: 0, refs: 0, reviewPicks: 0 });

/**
 * A page's blocks for the other store: the same words and order, with
 * pictures left out (the first store's storage), the reviews picked to show
 * first left out (reviews are the first store's buyers'), every product and
 * form named mapped to its copy, and no tie to a section saved in the first
 * store. The blocks keep their ids, so writing the same copy again writes
 * the same page. A divider or a space (375 [TB1]) holds nothing of the first
 * store's, so it comes across as it is.
 */
export function copiedBlocks(blocks: readonly PageBlock[], products: IdMap, forms: IdMap, left: BlocksLeft): PageBlock[] {
  return blocks.flatMap((original): PageBlock[] => {
    // A booking block (552 [BB1]) books one call: the call's copy, or the block is left out and counted, since
    // without a call it has nothing to book (lib/sales-page.ts would not keep it). A call is never copied today
    // (skipReason "call"), so in practice it is always left out.
    if (original.kind === "booking") {
      const mapped = products(original.product);
      if (!mapped) {
        left.refs += 1;
        return [];
      }
      const block: PageBlock = { ...original, product: mapped };
      delete block.saved;
      return [block];
    }
    const block = { ...original } as PageBlock;
    delete block.saved;
    if (block.kind === "pictures" && block.items.length) {
      left.pictures += block.items.length;
      block.items = [];
    }
    if (block.kind === "feature" && block.picture) {
      left.pictures += 1;
      block.picture = null;
    }
    // A row's pictures are the first store's too (375 [TB1]): each one left out and counted, the other parts kept in order.
    if (block.kind === "row") {
      const pictures = block.columns.reduce((n, column) => n + column.filter((element) => element.kind === "image").length, 0);
      if (pictures) {
        left.pictures += pictures;
        block.columns = block.columns.map((column) => column.filter((element) => element.kind !== "image"));
      }
    }
    if (block.kind === "reviews" && block.first.length) {
      left.reviewPicks += block.first.length;
      block.first = [];
    }
    if (block.kind === "product" && block.product) {
      const mapped = products(block.product);
      if (!mapped) left.refs += 1;
      block.product = mapped;
    }
    if (block.kind === "form" && block.form) {
      const mapped = forms(block.form);
      if (!mapped) left.refs += 1;
      block.form = mapped;
    }
    return [block];
  });
}

/** A page of blocks for the other store, kept back from visitors, with no test running on it (a test is counted from its own visitors). */
export function copiedPage(page: SalesPage, products: IdMap, forms: IdMap, left: BlocksLeft): SalesPage {
  const next = page.next ? products(page.next) || null : null;
  if (page.next && !next) left.refs += 1;
  return { ...page, blocks: copiedBlocks(page.blocks, products, forms, left), next, test: null, variant: null, hidden: true };
}

/** A form for the other store: its questions, results and words, with its results' products mapped; never an answer, which is kept apart. */
export function copiedForm(form: FormDef, id: string, products: IdMap, now: number, left: BlocksLeft): FormDef {
  return {
    ...form,
    id,
    outcomes: form.outcomes.map((outcome) => {
      const product = outcome.product ? products(outcome.product) : "";
      if (outcome.product && !product) left.refs += 1;
      return { ...outcome, product };
    }),
    updatedAt: now,
  };
}

/** A funnel for the other store, off, walking its pages' and products' copies; a step whose page or product is not copied is left out. */
export function copiedFunnel(funnel: PageFunnel, id: string, slug: string, pages: IdMap, products: IdMap, nowSeconds: number, left: BlocksLeft): PageFunnel {
  const steps = funnel.steps.flatMap((step) => {
    const mapped = step.kind === "page" ? pages(step.id) : products(step.id);
    if (!mapped) {
      left.refs += 1;
      return [];
    }
    return [{ kind: step.kind, id: mapped }];
  });
  return { id, name: funnel.name, slug, steps, on: false, since: nowSeconds };
}

/** The store page's setup that comes across when the creator asks for it. */
export type CopiedSetup = {
  bio: string;
  look: { theme: string; accent: string; font: string; backdrop: string };
  links: StoreLink[];
  socials: Social[];
  faq: FaqItem[];
  order: PagePart[];
  sections: StoreSection[];
  announcement: Announcement | null;
};

/** Social profiles that are a way to reach the creator in person, kept to the store they were set on. */
export const PERSONAL_SOCIALS = new Set(["email", "whatsapp", "telegram"]);

/**
 * The setup, with the products it names mapped: a section that starts at a
 * product not copied is left out (a section has to start at a product), the
 * line of news keeps its words without a link when its product is not
 * copied, and links lose their own pictures. Social profiles that reach the
 * creator in person (email, WhatsApp, Telegram) stay where they were set.
 */
export function copiedSetup(
  source: { bio: string; look: CopiedSetup["look"]; links: readonly StoreLink[]; socials: readonly Social[]; faq: readonly FaqItem[]; order: readonly PagePart[]; sections: readonly StoreSection[]; announcement: Announcement | null },
  products: IdMap,
  left: { pictures: number; socials: number; sections: number },
): CopiedSetup {
  const sections = source.sections.flatMap((section) => {
    const at = products(section.at);
    if (!at) {
      left.sections += 1;
      return [];
    }
    return [{ title: section.title, at }];
  });
  const links = source.links.map((link) => {
    const { image, ...rest } = link;
    if (image) left.pictures += 1;
    return rest;
  });
  const socials = source.socials.filter((s) => {
    if (PERSONAL_SOCIALS.has(s.network)) {
      left.socials += 1;
      return false;
    }
    return true;
  });
  const announcement = source.announcement ? { text: source.announcement.text, product: source.announcement.product ? products(source.announcement.product) || null : null } : null;
  return {
    bio: source.bio,
    look: { theme: source.look.theme, accent: source.look.accent, font: source.look.font, backdrop: source.look.backdrop },
    links,
    socials,
    faq: [...source.faq],
    order: [...source.order],
    sections,
    announcement,
  };
}

/** Studio requests a step is charged, from the commands and bytes it may send. */
export function unitsFor(commands: number, bytes: number): number {
  return Math.max(COPY_MIN_UNITS, Math.ceil(commands / COPY_UNIT_COMMANDS), Math.ceil(bytes / COPY_UNIT_BYTES));
}

/** One line of a copy's plan: "stop" means nothing would be written. */
export type PlanLine = { level: "stop" | "note"; text: string };

/** What a copy would take, counted from the first store; what the other store has room for. */
export type CopyNeeds = {
  products: number;
  skipped: { title: string; why: SkipReason }[];
  pages: number;
  forms: number;
  funnels: number;
  dataBytes: number;
  units: number;
  /** What comes across without its file, picture or note, counted. */
  files: number;
  pictures: number;
  notes: number;
  sameCurrency: boolean;
  /** Steps the copy is made in. */
  steps: number;
};
export type CopyRoom = { products: number; pages: number; forms: number; funnels: number; dataBytes: number | null; units: number | null; currency: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n.toLocaleString("en-US")} ${many}`);
const kb = (bytes: number) => `${Math.max(1, Math.ceil(bytes / 1000)).toLocaleString("en-US")} KB`;

/**
 * Whether the whole copy fits, and the sentences that say what it makes,
 * what it leaves out and, when it does not fit, why: every "stop" means the
 * copy is refused before anything is written. Never part of a copy.
 */
export function planCopy(needs: CopyNeeds, room: CopyRoom, to: string): { ok: boolean; lines: PlanLine[] } {
  const lines: PlanLine[] = [];
  const stop = (text: string) => lines.push({ level: "stop", text });
  const note = (text: string) => lines.push({ level: "note", text });
  if (!needs.sameCurrency) stop(`${to} sells in ${room.currency.toUpperCase()}, and this store in another currency. Set both to the same currency first, so no price is copied as a different amount.`);
  if (needs.products > room.products) stop(`It would make ${plural(needs.products, "product", "products")} there, and ${to} has room for ${room.products.toLocaleString("en-US")} more.`);
  if (needs.pages > room.pages) stop(`It would make ${plural(needs.pages, "page", "pages")} there, and ${to} has room for ${room.pages} more of its own pages.`);
  if (needs.forms > room.forms) stop(`It would make ${plural(needs.forms, "form", "forms")} there, and ${to} has room for ${room.forms} more.`);
  if (needs.funnels > room.funnels) stop(`It would make ${plural(needs.funnels, "funnel", "funnels")} there, and ${to} has room for ${room.funnels} more.`);
  if (room.dataBytes === null) stop(`${to}'s data room can't be read just now. Try again in a minute.`);
  else if (needs.dataBytes > room.dataBytes) stop(`It needs about ${kb(needs.dataBytes)} of ${to}'s data room, and ${kb(Math.max(0, room.dataBytes))} is left.`);
  if (room.units === null) stop(`${to}'s studio requests for the month can't be read just now. Try again in a minute.`);
  else if (needs.units > room.units) stop(`It takes about ${needs.units.toLocaleString("en-US")} of ${to}'s studio requests this month, and ${room.units.toLocaleString("en-US")} are left. It can be made once the month turns.`);
  const made = [plural(needs.products, "product", "products"), plural(needs.pages, "page", "pages"), plural(needs.forms, "form", "forms"), plural(needs.funnels, "funnel", "funnels")];
  note(`Makes ${made.join(", ")} in ${to}, every one a draft: products kept off the store, pages out of the menu and kept back, funnels off, until you publish them there.`);
  if (needs.skipped.length) note(`Not copied: ${needs.skipped.map((s) => `"${s.title}" (${SKIP_WORDS[s.why]})`).join("; ")}.`);
  if (needs.files) note(`${plural(needs.files, "product comes", "products come")} across without the file it delivers: upload it there before publishing.`);
  note(`Pictures are never copied: they are this store's files. Products, pages and links come across without them${needs.pictures ? ` (${plural(needs.pictures, "product picture", "product pictures")} among them)` : ""}; add them there before publishing.`);
  if (needs.notes) note(`${plural(needs.notes, "note after paying stays", "notes after paying stay")} in this store: write them again there.`);
  note("Never copied: customers, orders, contacts, emails, answers, reviews, numbers, payments, payout details, taxes, the domain, the email sender and its address, the team, integrations and keys.");
  return { ok: !lines.some((line) => line.level === "stop"), lines };
}
