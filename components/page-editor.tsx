"use client";

import { fastMoneyMessage } from "@/lib/terms-check-rules";
import { TestCountsNotice } from "@/components/test-counts-notice";
import { pasteExceedsLimit } from "@/lib/paste-limit";

import { PageAnswers } from "@/components/page-answers";
import type { WhyNot } from "@/lib/why-not-rules";
import type { VideoReach } from "@/lib/page-depth";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { SavedSections } from "@/components/saved-sections";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { shrink } from "@/components/product-image-editor";
import { IMAGE_ACCEPT, MAX_ALT_LENGTH, MAX_SOURCE_BYTES, imagePath, imageUrl } from "@/lib/product-image";
import { Icon } from "@/components/icons";
import { KIND_ICONS } from "@/lib/sales-page-icons";
import { toast } from "@/components/toast";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { TranslatePage } from "@/components/translate-page";
import { AiPosts } from "@/components/ai-posts";
import { PageCoach } from "@/components/page-coach";
import { PageStylePicker } from "@/components/page-style-picker";
import { BlockPicker } from "@/components/block-picker";
import { SharePanel } from "@/components/share-panel";
import { useLeaveGuard } from "@/components/leave-guard";
import { BlockRewrite } from "@/components/block-rewrite";
import { type CourseOutline, insideFromCourse } from "@/lib/course-outline-items";
import { MIN_EXPECTED_SIGNUPS, MIN_SALES, MIN_VIEWS, REFUND_DAYS, type Counts, type Measure, boundary, chanceBBetter, daysLeft, perVisitor, rate, testState } from "@/lib/headline-test-rules";
import { formatMoney } from "@/lib/money";
import { type BlockContext, type FeaturedCard, HeroView, PageSections } from "@/components/sales-blocks";
import { RatingLine, ReviewsSection } from "@/components/review-list";
import { type StoreLook, lookStyle } from "@/lib/store-look";
import type { Review, Summary } from "@/lib/review-summary";
import {
  blocksFromDraft,
  type DraftCopy,
  BLOCK_KINDS,
  type BlockKind,
  MAX_ANSWER,
  MAX_BENEFITS,
  MAX_BIO,
  MAX_BLOCKS,
  MAX_CTA_LABEL,
  MAX_CTA_NOTE,
  MAX_FAQ_ITEMS,
  MAX_GUARANTEE,
  MAX_HEADING,
  MAX_HEADLINE,
  MAX_INSIDE_ITEMS,
  MAX_ITEM,
  MAX_ITEM_DETAIL,
  MAX_QUESTION,
  MAX_SEO_DESCRIPTION,
  MAX_SEO_TITLE,
  MAX_SUBHEADLINE,
  MAX_TEXT,
  MAX_CAPTION,
  MAX_COUNTDOWN_LABEL,
  MAX_COUNTDOWN_NOTE,
  MAX_PAGE_PICTURES,
  picturePaths,
  MAX_PICTURES,
  MAX_PICTURE_CAPTION,
  MAX_FIT_ITEMS,
  MAX_STEPS,
  MAX_BONUSES,
  MAX_COMPARE_ROWS,
  MAX_COLUMN,
  MAX_CELL,
  CELL_YES,
  CELL_NO,
  FACT_KEYS,
  type CompareRow,
  type FactKey,
  PAGE_STYLES,
  BLOCK_SHOWS,
  MAX_PICKED_REVIEWS,
  HERO_LAYOUTS,
  MAX_PRODUCT_NOTE,
  MAX_QUOTES,
  MAX_QUOTE,
  MAX_QUOTE_NAME,
  MAX_QUOTE_URL,
  type Quote,
  quoteUrl,
  PAGE_TEMPLATES,
  templateOutline,
  type PageStyle,
  PROVIDER_NAMES,
  type PageBlock,
  type Picture,
  type SalesPage,
  blocksFromTemplate,
  emptyBlock,
  newBlockId,
  readVideo,
  videoAddress,
} from "@/lib/sales-page";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { READ_PDF_JOBS, READ_PDF_PAGES } from "@/lib/ai-rules";
import type { PageFacts } from "@/lib/page-facts";
import { blockWords } from "@/lib/buyer-words/blocks";
import type { LanguageCode } from "@/lib/store-language";
import { NewTab } from "@/components/new-tab";

// Started provider attempts stay counted even when their reply is unusable (lib/ai.ts).
const HEADLINE_UNCONFIRMED_NOTE = "A replacement headline was not confirmed. Your current draft was kept. Started attempts count toward your monthly writing allowance. Check your allowance before trying again.";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  too_many: `A page can have up to ${MAX_BLOCKS} blocks.`,
  hero_first: "The hero can only be the first block: it carries the page's main headline.",
  two_reviews: "Reviews can sit in one place on the page. Remove the second block of them.",
  video: "That video address is not one we can play. Paste a YouTube, Vimeo or Loom link.",
  pictures: `A picture on the page could not be kept. A page holds up to ${MAX_PAGE_PICTURES} pictures, each shown once: remove the one that was added twice, or add it again.`,
  countdown: "Give the countdown the moment it runs to, no more than a year away, or remove the block.",
  quote_length: `A quotation exceeds the ${MAX_QUOTE}-character limit. Use a shorter, complete quotation from the source or remove it. Nothing was saved.`,
  quote_link: "Each thing said elsewhere needs the full https address of where it was said, so visitors can check it. Add it, or remove that one.",
  shape: "Something in the page could not be read. Reload the studio and try again.",
  same_version: "Version B shows just what version A does, or one of them has no blocks. Change something in version B, or end the test.",
  too_big: "The page is too long to save. Shorten some of the text.",
  placeholder: "This page still has parts marked ⟦like this⟧ for you to write. Replace each one with your own words, or keep the page hidden, before saving. Nothing was saved.",
  next: "After a sign-up, only another product that costs money can be shown.",
  unknown: "That product is no longer in your store. Reload the page.",
  store_full: "Your store is full. Remove something before adding more.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/** A moment in seconds as the date-and-time field holds it, in the creator's own time zone. */
function toLocalField(seconds: number): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** And back: what the field holds, as a moment in seconds; 0 when it holds nothing readable. */
function fromLocalField(value: string): number {
  const at = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(at) ? Math.floor(at / 1000) : 0;
}

/** Below this many visitors a share would say more about chance than about the page. */
const MIN_DEPTH_VISITORS = 30;

const kindLabel = (kind: BlockKind) => BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? kind;

export type EditorProduct = {
  id: string;
  title: string;
  summary: string;
  free: boolean;
  pill: string;
  picture: { src: string; alt: string; width: number; height: number } | null;
  /** What a button says when its label is left empty, and where it leads, in words. */
  defaultLabel: string;
  leadsTo: string;
  /** Whether it has a PDF its page can be written from (lib/ai.ts, readPdfFacts). */
  pdf?: boolean;
};

/** A block as the editor holds it: a hero keeps the video address as typed, too. */
type Draft = { block: PageBlock; video: string };

function toDrafts(page: SalesPage): Draft[] {
  return page.blocks.map((block) => ({
    block,
    video: (block.kind === "hero" || block.kind === "video") && block.video ? videoAddress(block.video) : "",
  }));
}

/** Blocks that can stand more than once on a page, with no picture of their own to share. */
function canDuplicate(block: PageBlock): boolean {
  return block.kind !== "hero" && block.kind !== "reviews" && block.kind !== "pictures";
}

/** When a version was saved over, in the creator's own clock: "Oct 8, 3:12 PM". */
function whenSaved(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function counter(value: string, max: number) {
  return <span className="text-xs tabular-nums text-ink-mute">{`${value.length}/${max}`}</span>;
}

/**
 * The studio's page builder for one product: blocks to add, fill in, move
 * and remove, and a preview drawn by the same components as the live page,
 * in the store's own look. Saved as a whole, the way the funnel editor is.
 */
export function PageEditor({
  product,
  initial,
  templateDraft,
  about,
  look,
  storeName,
  photo,
  pageHref,
  shareUrl = null,
  nextOptions,
  summary,
  reviews = [],
  folder,
  lang = "en",
  facts = {},
  traffic = null,
  outline = [],
  asked = [],
  pagesToCopy = [],
  featurable = [],
  site,
  startTest = false,
}: {
  /** Opened from "Worth knowing" to test a second headline (lib/insights.ts): the test is switched on, ready to write. */
  startTest?: boolean;
  product: EditorProduct;
  /** The store's own picture folder (lib/product-image.ts), where a page's pictures go. */
  folder: string;
  initial: SalesPage;
  /** Unsaved library content; initial remains the saved baseline. */
  templateDraft?: SalesPage;
  /** The long description, to start a page from. */
  about: string;
  look: StoreLook;
  storeName: string;
  photo: string | null;
  pageHref: string;
  /** The page's full address to share, on the creator's own domain when it has one; null for a draft. */
  shareUrl?: string | null;
  /** For something free: the paid products that can be shown after a sign-up. */
  nextOptions: { id: string; title: string }[];
  summary: Summary | null;
  /** The newest reviews on the page, so the preview shows real ones. */
  reviews?: Review[];
  /** The store's language, so the preview speaks it as the page does. */
  lang?: LanguageCode;
  /** The numbers the store has counted for this product (lib/page-facts.ts). */
  facts?: PageFacts;
  /** Its page's last 30 days: times it was opened, checkouts started. */
  traffic?: { views: number; checkouts: number } | null;
  /** A course's modules and lessons, by title, to fill "What's inside" from (lib/course-outline-items.ts). */
  outline?: CourseOutline;
  /** What visitors asked this page's answer box and the page could not answer (lib/answers.ts). */
  asked?: string[];
  /** The store's other products that have a page of their own, to start this one from. */
  pagesToCopy?: { id: string; title: string }[];
  /** The store's other products a page can show as a card (lib/featured-cards.ts). */
  featurable?: { id: string; card: FeaturedCard }[];
  /**
   * Editing one of the store's own pages rather than a product's
   * (lib/site-page-rules.ts): only the blocks such a page offers, saved to
   * its own place, and none of what belongs to a product — tests, a buy box,
   * a draft written from the product, what visitors to it did.
   */
  site?: { id: string; kinds: readonly BlockKind[]; forms?: { id: string; name: string }[] };
}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>(() => toDrafts(templateDraft ?? initial));
  const [seoTitle, setSeoTitle] = useState(initial.seoTitle);
  const [seoDescription, setSeoDescription] = useState(initial.seoDescription);
  const [next, setNext] = useState(initial.next ?? "");
  const [style, setStyle] = useState<PageStyle>(initial.style);
  const [hidden, setHidden] = useState(initial.hidden);
  const [showFrom, setShowFrom] = useState(initial.showFrom);
  // How far down the saved page visitors read (lib/page-depth.ts), shown on each block.
  const [reach, setReach] = useState<{ shares: Record<string, number>; visitors: number } | null>(null);
  // What stopped measured visitors, how far the video was watched, and whether the page asks (components/page-answers.tsx).
  const [answers, setAnswers] = useState<{ whyNot: Partial<Record<WhyNot, number>>; videos: Record<string, VideoReach>; asking: boolean } | null>(null);
  // The key the page's blocks and earlier versions are kept under.
  const pageKey = site ? `site-${site.id}` : product.id;
  useEffect(() => {
    if (site) return;
    let live = true;
    fetch(`/api/store/depth?id=${encodeURIComponent(product.id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { ok?: boolean; shares?: Record<string, number>; visitors?: number; whyNot?: Partial<Record<WhyNot, number>>; videos?: Record<string, VideoReach>; asking?: boolean }) => {
        if (live && data.ok && data.shares) setReach({ shares: data.shares, visitors: data.visitors ?? 0 });
        if (live && data.ok) setAnswers({ whyNot: data.whyNot ?? {}, videos: data.videos ?? {}, asking: data.asking === true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [product.id, site]);
  // A second headline, tested against the hero's (lib/headline-test.ts).
  const [testing, setTesting] = useState(initial.test !== null || (startTest && !initial.variant && !site));
  // Brought here to start a headline test: to the box, with the cursor in it.
  useEffect(() => {
    if (!startTest) return;
    // The hero opens with the page; the box is drawn inside it a moment later.
    const box = document.getElementById("headline-test") ?? document.querySelector<HTMLElement>("[aria-labelledby=page-test-title]");
    // At once, not smoothly: this is where the page opens, and a smooth scroll waits for a tab in the background.
    box?.scrollIntoView({ behavior: "instant", block: "center" });
    box?.querySelector<HTMLInputElement>("input[type=text], textarea")?.focus({ preventScroll: true });
  }, [startTest]);
  const [testHeadline, setTestHeadline] = useState(initial.test?.headline ?? "");
  const [testSub, setTestSub] = useState(initial.test?.sub ?? "");
  // A second headline written by the writing help (lib/ai.ts, writeTestHeadline): one of the month's jobs.
  const aiOn = useContext(AiOn);
  const [writingTest, setWritingTest] = useState(false);
  const [testNote, setTestNote] = useState<string | null>(null);
  async function writeTest(hero: { headline: string; sub: string }) {
    if (writingTest) return;
    setWritingTest(true);
    setTestNote(null);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "headline", product: product.id, headline: hero.headline, sub: hero.sub, page: pageToSend() }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: { headline: string; sub: string }; error?: string };
      if (data.ok && data.value) {
        setTestHeadline(data.value.headline);
        setTestSub(data.value.sub);
      } else {
        setTestNote(data.error === "used" ? "This month's writing help is used up. It starts again with your next billing month." : data.error === "notes" ? "Write the hero's own headline first." : HEADLINE_UNCONFIRMED_NOTE);
      }
    } catch {
      setTestNote(HEADLINE_UNCONFIRMED_NOTE);
    } finally {
      setWritingTest(false);
    }
  }
  // A second version of the whole page, tested against the first (lib/sales-page.ts,
  // variant): the version not being edited right now, and whether B is the one being edited.
  const [other, setOther] = useState<Draft[] | null>(() => (initial.variant ? toDrafts({ ...initial, blocks: initial.variant.blocks }) : null));
  const [onB, setOnB] = useState(false);
  // Brought here to test a headline (lib/insights.ts): the hero, where the test is, open.
  const [open, setOpen] = useState<string | null>(startTest && !site && initial.blocks[0]?.kind === "hero" ? initial.blocks[0].id : null);
  const [view, setView] = useState<"build" | "preview">("build");
  const [sharing, setSharing] = useState(false);
  // Whether the screen is wide enough to draw the page beside its blocks; only
  // then is the second drawing made at all, so a narrow screen holds one.
  const [sideBySide, setSideBySide] = useState(false);
  const beside = useRef<HTMLElement>(null);
  // The block being edited, outlined in the page beside it.
  useEffect(() => {
    const box = beside.current;
    if (!box) return;
    box.querySelectorAll(".sp-editing").forEach((el) => el.classList.remove("sp-editing"));
    if (open) box.querySelector(`[data-block="${CSS.escape(open)}"]`)?.classList.add("sp-editing");
  });
  useEffect(() => {
    const wideScreen = window.matchMedia("(min-width: 1280px)");
    const read = () => setSideBySide(wideScreen.matches);
    const first = window.setTimeout(read, 0);
    wideScreen.addEventListener("change", read);
    return () => {
      window.clearTimeout(first);
      wideScreen.removeEventListener("change", read);
    };
  }, []);
  // Both versions' blocks as they are now, for a save or a translation to know whether they changed while it ran.
  const latest = useRef({ drafts, other, onB });
  useEffect(() => {
    latest.current = { drafts, other, onB };
  }, [drafts, other, onB]);
  function unchangedSince(page: Pick<SalesPage, "blocks" | "variant">): boolean {
    const now = latest.current;
    const a = now.onB && now.other ? now.other : now.drafts;
    const b = now.other === null ? null : now.onB ? now.drafts : now.other;
    return JSON.stringify({ a: a.map((d) => d.block), b: b ? b.map((d) => d.block) : null }) === JSON.stringify({ a: page.blocks, b: page.variant ? page.variant.blocks : null });
  }
  /** The page's two versions as they came back, with the one being edited in front. */
  function putVersions(page: SalesPage, editB: boolean) {
    const a = toDrafts(page);
    const b = page.variant ? toDrafts({ ...page, blocks: page.variant.blocks }) : null;
    const showB = editB && b !== null;
    if (showB !== latest.current.onB) freshHistory(showB ? b : a);
    setDrafts(showB ? b : a);
    setOther(showB ? a : b);
    setOnB(showB);
  }
  // Undo and redo, a step at a time (added 8 October 2026): each pause in
  // editing is one step back, a hundred at most, the page's blocks and its
  // style together. Text being typed in a box keeps the box's own undo.
  type Step = { drafts: Draft[]; style: PageStyle };
  const steps = useRef<{ past: Step[]; future: Step[]; last: Step }>({ past: [], future: [], last: { drafts, style } });
  const [stepsLeft, setStepsLeft] = useState({ back: 0, forward: 0 });
  useEffect(() => {
    const h = steps.current;
    // What a step back or forward put here is already the last step.
    if (h.last.drafts === drafts && h.last.style === style) return;
    const timer = window.setTimeout(() => {
      if (h.last.drafts === drafts && h.last.style === style) return;
      h.past.push(h.last);
      if (h.past.length > 100) h.past.shift();
      h.future = [];
      h.last = { drafts, style };
      setStepsLeft({ back: h.past.length, forward: 0 });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [drafts, style]);
  /** Undo starts again from these blocks: a step back never crosses from one version of the page into the other. */
  function freshHistory(now: Draft[]) {
    steps.current = { past: [], future: [], last: { drafts: now, style: steps.current.last.style } };
    setStepsLeft({ back: 0, forward: 0 });
  }
  function stepTo(direction: "back" | "forward") {
    const h = steps.current;
    // An edit still within its pause is a step of its own first.
    if (h.last.drafts !== drafts || h.last.style !== style) {
      h.past.push(h.last);
      h.future = [];
      h.last = { drafts, style };
    }
    const from = direction === "back" ? h.past : h.future;
    const to = direction === "back" ? h.future : h.past;
    const step = from.pop();
    if (!step) return;
    to.push(h.last);
    h.last = step;
    setDrafts(step.drafts);
    setStyle(step.style);
    setStepsLeft({ back: h.past.length, forward: h.future.length });
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        document.getElementById("undo-step")?.click();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        document.getElementById("redo-step")?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [wide, setWide] = useState(false);
  // Where the block picker is open: the place a new block would take, or null when closed.
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  // Which template the empty page would start from, and the block being dragged.
  const templates = site ? [] : PAGE_TEMPLATES.filter((t) => t.free === product.free);
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  // The time, for saying a countdown's moment has passed; read off the clock every half minute, never while drawing.
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const read = () => setClock(Date.now());
    const first = window.setTimeout(read, 0);
    const timer = window.setInterval(read, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);

  // Whether visitors are kept from the saved page right now; read off the clock, never while drawing on the server.
  const hiddenNow = initial.hidden && !(initial.showFrom > 0 && clock > 0 && initial.showFrom * 1000 <= clock);
  // The two versions, whichever is being edited.
  const draftsA = onB && other ? other : drafts;
  const draftsB = other === null ? null : onB ? drafts : other;
  const saved = JSON.stringify({
    d: toDrafts(initial),
    v: initial.variant ? initial.variant.blocks : null,
    t: initial.seoTitle,
    s: initial.seoDescription,
    n: initial.next ?? "",
    y: initial.style,
    h: initial.hidden,
    f: initial.hidden ? initial.showFrom : 0,
    ab: initial.test ? [initial.test.headline, initial.test.sub] : null,
  });
  const dirty =
    JSON.stringify({
      d: draftsA,
      v: draftsB ? draftsB.map((d) => d.block) : null,
      t: seoTitle,
      s: seoDescription,
      n: next,
      y: style,
      h: hidden,
      f: hidden ? showFrom : 0,
      ab: !draftsB && testing ? [testHeadline.trim(), testSub.trim()] : null,
    }) !== saved;
  // Pictures only the other version shows: the two versions together hold no more than a page may.
  const onlyInOther = useMemo(() => {
    if (!other) return 0;
    const here = new Set(picturePaths({ blocks: drafts.map((d) => d.block) }));
    return picturePaths({ blocks: other.map((d) => d.block) }).filter((path) => !here.has(path)).length;
  }, [drafts, other]);
  // Nothing typed here is lost to a closed tab or a link pressed by mistake.
  useLeaveGuard(dirty && !busy);
  const hasHero = drafts[0]?.block.kind === "hero";
  const hasReviews = drafts.some((d) => d.block.kind === "reviews");
  const addable = BLOCK_KINDS.filter((k) => (site ? site.kinds.includes(k.kind) : k.kind !== "form") && (k.kind === "hero" ? !hasHero : k.kind === "reviews" ? !hasReviews : true));

  function change(index: number, patch: Partial<PageBlock>) {
    setDrafts((all) => all.map((d, i) => (i === index ? { ...d, block: { ...d.block, ...patch } as PageBlock } : d)));
  }

  function setVideo(index: number, typed: string) {
    const video = readVideo(typed);
    setDrafts((all) =>
      all.map((d, i) => (i === index && (d.block.kind === "hero" || d.block.kind === "video") ? { video: typed, block: { ...d.block, video } } : d)),
    );
  }

  /** A new block at `at` (the end when left out); a hero always goes on top. */
  function add(kind: BlockKind, at?: number) {
    if (drafts.length >= MAX_BLOCKS) return;
    const block = emptyBlock(kind, newBlockId());
    const draft: Draft = { block, video: "" };
    setDrafts((all) => {
      if (kind === "hero") return [draft, ...all];
      const place = at === undefined ? all.length : Math.max(all[0]?.block.kind === "hero" ? 1 : 0, Math.min(at, all.length));
      const copy = [...all];
      copy.splice(place, 0, draft);
      return copy;
    });
    setOpen(block.id);
    setPicking(null);
  }

  /** A saved section's blocks (components/saved-sections.tsx), at the end of the page. */
  function insertSection(blocks: PageBlock[]) {
    setDrafts((all) =>
      all.length + blocks.length > MAX_BLOCKS
        ? all
        : [...all, ...blocks.map((block) => ({ block, video: block.kind === "video" && block.video ? videoAddress(block.video) : "" }))],
    );
    setPicking(null);
  }

  function move(index: number, by: -1 | 1) {
    setDrafts((all) => {
      const to = index + by;
      if (to < 0 || to >= all.length) return all;
      if (all[index].block.kind === "hero" || all[to].block.kind === "hero") return all;
      const copy = [...all];
      [copy[index], copy[to]] = [copy[to], copy[index]];
      return copy;
    });
  }

  /** Dropping one block on another puts it in that place; the hero stays on top. */
  function moveTo(from: number, to: number) {
    setDrafts((all) => {
      if (from === to || from < 0 || to < 0 || from >= all.length || to >= all.length) return all;
      if (all[from].block.kind === "hero" || all[to].block.kind === "hero") return all;
      const copy = [...all];
      const [taken] = copy.splice(from, 1);
      copy.splice(to, 0, taken);
      return copy;
    });
  }

  /** Puts a block where it reads best: after the first of `after` found on the page, or right under the hero. */
  function insertNear(block: PageBlock, after: BlockKind[]) {
    setDrafts((all) => {
      if (all.length >= MAX_BLOCKS) return all;
      const at = all.findIndex((d) => after.includes(d.block.kind));
      const place = at >= 0 ? at + 1 : all[0]?.block.kind === "hero" ? 1 : 0;
      const copy = [...all];
      copy.splice(place, 0, { block, video: "" });
      return copy;
    });
    setOpen(block.id);
  }

  /** The coach's headline, in the hero: the one there, or a new hero when the page has none. */
  function putHeadline(headline: string, sub: string) {
    setDrafts((all) => {
      if (all[0]?.block.kind === "hero") {
        return all.map((d, i) => (i === 0 ? { ...d, block: { ...d.block, headline: headline.slice(0, MAX_HEADLINE), sub: sub.slice(0, MAX_SUBHEADLINE) } as PageBlock } : d));
      }
      const hero = { ...(emptyBlock("hero") as Extract<PageBlock, { kind: "hero" }>), headline: headline.slice(0, MAX_HEADLINE), sub: sub.slice(0, MAX_SUBHEADLINE), media: product.picture ? ("picture" as const) : ("none" as const) };
      return [{ block: hero, video: "" }, ...all];
    });
  }

  /** The coach's questions, added to the page's questions, or as a block of their own before the last button. */
  function addQuestions(items: { q: string; a: string }[]) {
    setDrafts((all) => {
      const at = all.findIndex((d) => d.block.kind === "faq");
      if (at >= 0) {
        return all.map((d, i) => {
          if (i !== at || d.block.kind !== "faq") return d;
          const known = new Set(d.block.items.map((item) => item.q.trim().toLowerCase()));
          const added = items.filter((item) => !known.has(item.q.trim().toLowerCase()));
          return { ...d, block: { ...d.block, items: [...d.block.items, ...added].slice(0, MAX_FAQ_ITEMS) } };
        });
      }
      if (all.length >= MAX_BLOCKS) return all;
      const faq: PageBlock = { ...(emptyBlock("faq") as Extract<PageBlock, { kind: "faq" }>), items: items.slice(0, MAX_FAQ_ITEMS) };
      const lastCta = all.map((d) => d.block.kind).lastIndexOf("cta");
      const copy = [...all];
      copy.splice(lastCta > 0 ? lastCta : copy.length, 0, { block: faq, video: "" });
      return copy;
    });
  }

  function remove(index: number) {
    setDrafts((all) => all.filter((_, i) => i !== index));
  }

  /**
   * A copy of a block right under it, with a new id, to change from there.
   * The hero and the reviews stand once on a page; a picture is shown once,
   * so a copy of words beside a picture comes without it.
   */
  function duplicate(index: number) {
    const source = drafts[index];
    if (!source || drafts.length >= MAX_BLOCKS || !canDuplicate(source.block)) return;
    const block = { ...structuredClone(source.block), id: newBlockId() } as PageBlock;
    if (block.kind === "feature") block.picture = null;
    // A copy is the creator's own block, not part of the saved section the original came from.
    delete block.saved;
    setDrafts((all) => {
      if (all.length >= MAX_BLOCKS) return all;
      const copy = [...all];
      copy.splice(index + 1, 0, { block, video: source.video });
      return copy;
    });
    setOpen(block.id);
    toast(`Block ${index + 1} copied below it.`);
  }

  /** Brings version B (or A) to the front for editing; the other waits as it is. */
  function switchVersion(toB: boolean) {
    if (other === null || toB === onB) return;
    freshHistory(other);
    setOther(drafts);
    setDrafts(other);
    setOnB(toB);
    setOpen(null);
  }

  /**
   * Starts a test of a second version of the whole page: version B begins as
   * a copy of this one, block for block with new ids, and is the one being
   * edited from here. A page runs one test at a time, so a second headline
   * being tested stops.
   */
  function startPageTest() {
    if (other !== null || drafts.length === 0) return;
    const copy = drafts.map((d) => ({ ...d, block: { ...structuredClone(d.block), id: newBlockId() } as PageBlock }));
    freshHistory(copy);
    setOther(drafts);
    setDrafts(copy);
    setOnB(true);
    setTesting(false);
    setOpen(null);
    toast("Version B is a copy of your page. Change anything in it, then press Save to start the test.");
  }

  /** Ends the test with one version kept as the page; nothing is live until Save. */
  function endPageTest(keep: "a" | "b") {
    if (other === null) return;
    const kept = (keep === "b") === onB ? drafts : other;
    freshHistory(kept);
    setDrafts(kept);
    setOther(null);
    setOnB(false);
    setOpen(null);
    toast(`Version ${keep.toUpperCase()} is the page again. Press Save to end the test.`);
  }

  // Earlier versions of the saved page (lib/sales-page-store.ts, readVersions).
  const [versions, setVersions] = useState<{ index: number; at: number; blocks: number; headline: string }[] | null>(null);
  const [versionNote, setVersionNote] = useState<string | null>(null);
  async function loadVersions() {
    setVersionNote(null);
    try {
      const response = await fetch(`/api/store/page-versions?id=${encodeURIComponent(pageKey)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; versions?: { index: number; at: number; blocks: number; headline: string }[] };
      if (!data.ok || !data.versions) throw new Error("unread");
      setVersions(data.versions);
    } catch {
      setVersions(null);
      setVersionNote("The earlier versions could not be read just now. Try again in a moment.");
    }
  }
  async function bringBack(index: number) {
    setVersionNote(null);
    try {
      const response = await fetch(`/api/store/page-versions?id=${encodeURIComponent(pageKey)}&n=${index}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; at?: number; page?: SalesPage; dropped?: number };
      if (!data.ok || !data.page) throw new Error("unread");
      const page = data.page;
      putVersions(page, false);
      setSeoTitle(page.seoTitle);
      setSeoDescription(page.seoDescription);
      setNext(page.next ?? "");
      setStyle(page.style);
      setHidden(page.hidden);
      setShowFrom(page.showFrom);
      setTesting(page.test !== null);
      setTestHeadline(page.test?.headline ?? "");
      setTestSub(page.test?.sub ?? "");
      setOpen(null);
      const dropped = data.dropped ?? 0;
      toast(
        `Loaded the version from ${whenSaved(data.at ?? 0)}. Press Save to put it back live${dropped ? `; ${dropped === 1 ? "one picture was" : `${dropped} pictures were`} deleted since, so add ${dropped === 1 ? "it" : "them"} again if you want ${dropped === 1 ? "it" : "them"}` : ""}.`,
      );
    } catch {
      setVersionNote("That version could not be read just now. Try again in a moment.");
    }
  }

  /** A first page from a template: its order of blocks, with the product's own title and summary on top. */
  function startFromTemplate(template: string) {
    const blocks = blocksFromTemplate(template, { title: product.title, summary: product.summary, picture: Boolean(product.picture) });
    if (blocks.length === 0) return;
    setDrafts(blocks.map((block) => ({ block, video: "" })));
    setOpen(blocks[1]?.id ?? blocks[0].id);
  }

  // Whether "Write the whole page with AI" reads the product's own PDF first (lib/ai.ts, readPdfFacts).
  const [readFile, setReadFile] = useState(product.pdf === true);
  const [copyFrom, setCopyFrom] = useState(pagesToCopy[0]?.id ?? "");
  const [copying, setCopying] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  /** Another product's page, as a start: its blocks with fresh ids and without its pictures (lib/sales-page.ts, copyOfPage). */
  async function startFromCopy() {
    if (!copyFrom || copying) return;
    setCopying(true);
    setCopyNote(null);
    try {
      const response = await fetch(`/api/store/page?id=${encodeURIComponent(copyFrom)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; blocks?: PageBlock[]; picturesLeft?: number; style?: PageStyle };
      if (!data.ok || !data.blocks?.length) {
        setCopyNote("That page could not be read just now. Try again in a moment.");
        return;
      }
      const blocks = data.blocks;
      setDrafts(blocks.map((block) => ({ block, video: (block.kind === "hero" || block.kind === "video") && block.video ? videoAddress(block.video) : "" })));
      setOpen(blocks[0].kind === "hero" ? blocks[0].id : null);
      if (data.style && (PAGE_STYLES as readonly string[]).includes(data.style)) setStyle(data.style);
      const from = pagesToCopy.find((p) => p.id === copyFrom)?.title ?? "the other page";
      const left = data.picturesLeft ?? 0;
      toast(
        `Copied from ${from}. Change what is about that product before you save${left ? `; its ${left === 1 ? "picture stays" : `${left} pictures stay`} with it, so add this product's own` : ""}.`,
      );
    } catch {
      setCopyNote("That page could not be read just now. Try again in a moment.");
    } finally {
      setCopying(false);
    }
  }

  /** A first page from what the product already says: hero, description, button, reviews. */
  function startFromDescription() {
    const blocks: PageBlock[] = [
      { ...(emptyBlock("hero") as Extract<PageBlock, { kind: "hero" }>), headline: product.title, sub: product.summary, media: product.picture ? "picture" : "none" },
    ];
    if (about) blocks.push({ ...(emptyBlock("text") as Extract<PageBlock, { kind: "text" }>), heading: `About ${product.title}`, body: about });
    blocks.push(emptyBlock("cta"));
    blocks.push(emptyBlock("reviews"));
    setDrafts(blocks.map((block) => ({ block, video: "" })));
    setOpen(blocks[0].id);
  }

  function pageToSend(): SalesPage {
    return {
      seoTitle: seoTitle.trim(),
      seoDescription: seoDescription.trim(),
      next: product.free && next ? next : null,
      // The ids are the server's to give (lib/sales-page.ts, parseTest and parseVariant).
      // One test at a time: a second version of the page, or else a second headline.
      blocks: draftsA.map((d) => d.block),
      test: !draftsB && testing && testHeadline.trim() ? { id: "", headline: testHeadline.trim(), sub: testSub.trim() } : null,
      variant: draftsB ? { id: "", blocks: draftsB.map((d) => d.block) } : null,
      style,
      hidden,
      showFrom: hidden ? showFrom : 0,
    };
  }

  async function send(page: SalesPage | null, confirmation: string) {
    setBusy(true);
    setError(null);
    const all = page ? [...page.blocks, ...(page.variant?.blocks ?? [])] : [];
    const inB = (id: string) => Boolean(page?.variant?.blocks.some((b) => b.id === id)) && !page?.blocks.some((b) => b.id === id);
    const show = (id: string) => {
      // The block in trouble may be in the version not being edited: that one is brought to the front.
      if (inB(id) !== onB) switchVersion(inB(id));
      setOpen(id);
    };
    const badVideo = all.find((b) => (b.kind === "hero" && b.media === "video" && !b.video) || (b.kind === "video" && !b.video));
    if (badVideo) {
      setError(MESSAGES.video);
      setBusy(false);
      show(badVideo.id);
      return;
    }
    const badCountdown = all.find((b) => b.kind === "countdown" && !b.until);
    if (badCountdown) {
      setError(MESSAGES.countdown);
      setBusy(false);
      show(badCountdown.id);
      return;
    }
    try {
      const response = await fetch(site ? "/api/store/site-page" : "/api/store/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(site ? { action: "save", id: site.id, page } : { id: product.id, page }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; page?: SalesPage };
      if (data.ok) {
        // The blocks as the server kept them (ids given, empty items left out),
        // unless the creator has changed something while it was saving.
        if (page === null) {
          // The page cleared: the editor starts from nothing, as the product's page does.
          setDrafts([]);
          setSeoTitle("");
          setSeoDescription("");
          setNext("");
          setStyle("plain");
          setHidden(false);
          setShowFrom(0);
          setTesting(false);
          setTestHeadline("");
          setTestSub("");
          if (onB) freshHistory([]);
          setOther(null);
          setOnB(false);
          setOpen(null);
        } else if (data.page && unchangedSince(page)) {
          putVersions(data.page, onB);
          if (data.page.test) setTestHeadline(data.page.test.headline);
        }
        toast(confirmation);
        setConfirmClear(false);
        router.refresh();
        // The page as it was a moment ago is now the newest earlier version.
        if (versions !== null) void loadVersions();
        return;
      }
      setError(data.error === "fast_money" ? fastMoneyMessage((data as { passage?: unknown }).passage, "save") : MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const ctx: BlockContext = {
    storeName,
    productTitle: product.title,
    picture: product.picture,
    photo,
    action: { kind: "link", href: "#" },
    defaultLabel: product.defaultLabel,
    preview: true,
    lang,
    facts,
    featured: Object.fromEntries(featurable.map((p) => [p.id, p.card])),
  };
  const preview = useMemo(() => {
    const blocks = drafts.map((d) => d.block);
    const hero = blocks[0]?.kind === "hero" ? blocks[0] : null;
    const rest = hero ? blocks.slice(1) : blocks;
    return { hero, rest, placed: blocks.some((b) => b.kind === "reviews") };
  }, [drafts]);
  const pill = <p className="st-price text-sm">{product.pill}</p>;
  const rating = summary ? <RatingLine summary={summary} /> : null;
  // The preview shows the reviews as the page will: the picked ones first, then the newest, three in all.
  const pickedNow = drafts.find((d) => d.block.kind === "reviews")?.block;
  const pickedIds = pickedNow?.kind === "reviews" ? pickedNow.first : [];
  const previewFirst = pickedIds.map((id) => reviews.find((r) => r.id === id && !r.refunded)).filter((r): r is Review => r !== undefined);
  const previewReviews = [...previewFirst, ...reviews.filter((r) => !previewFirst.includes(r))].slice(0, Math.max(3, previewFirst.length));
  const reviewsPart = (heading: string) =>
    summary ? (
      <ReviewsSection heading={heading} summary={summary} reviews={previewReviews} storeName={storeName} productTitle={product.title} moreHref={null} preview picked={pickedIds} />
    ) : null;
  const buyPreview = (
    <section className="st-card sp-section p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="font-display text-xl font-semibold leading-snug sm:text-2xl">{product.free ? `Get ${product.title}` : product.title}</p>
        {pill}
      </div>
      <p className="st-muted mt-3 text-sm">
        {product.free
          ? "The sign-up form goes here: an email field, the box to hear from you, and the button. It works as it does on your store page."
          : "The buy box goes here, exactly as on your store page: price options, payment plan, the product offered alongside, and the checkout button."}
      </p>
      <span className="btn st-btn btn-block mt-4">
        {product.defaultLabel}
      </span>
    </section>
  );

  /** The page as visitors will see it, in the store's look: at phone width, or wide. */
  const pagePreview = (wideView: boolean) => (
          <div className="overflow-hidden rounded-2xl ring-1 ring-line">
            <div
              className={`st-page st-theme-${look.theme} mx-auto overflow-hidden`}
              style={{ ...(lookStyle(look) as React.CSSProperties), maxWidth: wideView ? "100%" : 390 }}
            >
              <div className={`sp-body sp-style-${style} mx-auto ${wideView ? "max-w-3xl" : ""} px-4 pb-12 pt-8`}>
                {drafts.length === 0 ? (
                  <p className="st-note text-sm">Add a block and it appears here, in your store&apos;s look.</p>
                ) : (
                  <>
                    {preview.hero ? (
                      <div data-block={preview.hero.id}>
                        <HeroView block={preview.hero} ctx={ctx} pill={pill} rating={rating} />
                      </div>
                    ) : (
                      <header>
                        <div className="flex flex-wrap items-center gap-2">
                          {pill}
                          {rating}
                        </div>
                        <p className="font-display mt-4 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em]">{product.title}</p>
                      </header>
                    )}
                    {product.free && !site ? buyPreview : null}
                    <PageSections
                      blocks={preview.rest}
                      ctx={ctx}
                      style={style}
                      reviewsFor={(heading) => reviewsPart(heading) ?? <p className="st-note text-sm">Buyers&apos; reviews appear here once somebody who paid writes one.</p>}
                    />
                    {product.free || site ? null : buyPreview}
                    {!preview.placed && summary ? <section className="sp-section">{reviewsPart("Reviews")}</section> : null}
                  </>
                )}
              </div>
            </div>
          </div>
  );

  const field = (id: string, label: string, input: React.ReactNode, extra?: React.ReactNode) => (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        {extra}
      </div>
      {input}
    </div>
  );

  function blockFields(draft: Draft, index: number) {
    const block = draft.block;
    const base = `blk-${block.id}`;
    switch (block.kind) {
      case "hero": {
        const recognised = readVideo(draft.video);
        return (
          <div className="space-y-4">
            {field(
              `${base}-h`,
              "Headline",
              <input id={`${base}-h`} className="field" maxLength={MAX_HEADLINE} value={block.headline} placeholder={product.title} onChange={(e) => change(index, { headline: e.target.value })} />,
              counter(block.headline, MAX_HEADLINE),
            )}
            {field(
              `${base}-s`,
              "Subheadline",
              <textarea id={`${base}-s`} className="field" rows={2} maxLength={MAX_SUBHEADLINE} value={block.sub} placeholder="Who it is for and what it changes, in a sentence." onChange={(e) => change(index, { sub: e.target.value })} />,
              counter(block.sub, MAX_SUBHEADLINE),
            )}
            <fieldset>
              <legend className="field-label">Beside the words</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {(["picture", "video", "none"] as const).map((media) => {
                  const off = media === "picture" && !product.picture;
                  return (
                    <label
                      key={media}
                      className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 transition-colors ${
                        block.media === media ? "bg-lilac text-violet-ink ring-violet-brand/40" : "bg-white text-ink-soft ring-line hover:text-ink"
                      } ${off ? "cursor-not-allowed opacity-50" : ""}`}
                    >
                      <input
                        type="radio"
                        name={`${base}-m`}
                        value={media}
                        checked={block.media === media}
                        disabled={off}
                        onChange={() => change(index, { media })}
                        className="h-4 w-4"
                      />
                      {media === "picture" ? "The product's picture" : media === "video" ? "A video" : "Nothing"}
                    </label>
                  );
                })}
              </div>
              {!product.picture && !site ? <p className="mt-1 text-xs text-ink-soft">Give the product a picture in the studio and it can go here.</p> : null}
            </fieldset>
            <fieldset>
              <legend className="field-label">Layout</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {HERO_LAYOUTS.map((option) => {
                  const on = (block.layout ?? "split") === option.value;
                  const off = option.value === "cover" && !(block.media === "picture" && product.picture);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={on}
                      disabled={off}
                      onClick={() =>
                        setDrafts((all) =>
                          all.map((d, i) => {
                            if (i !== index || d.block.kind !== "hero") return d;
                            const next = { ...d.block };
                            if (option.value === "split") delete next.layout;
                            else next.layout = option.value;
                            return { ...d, block: next };
                          }),
                        )
                      }
                      className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-lilac text-violet-ink ring-violet-brand/40" : "bg-white text-ink-soft ring-line hover:text-ink"}`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-ink-soft">The picture behind the words needs the product&apos;s picture beside them; it is darkened so the words read on any picture.</p>
            </fieldset>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold text-ink">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={Boolean(block.button)}
                onChange={(e) =>
                  setDrafts((all) =>
                    all.map((d, i) => {
                      if (i !== index || d.block.kind !== "hero") return d;
                      const next = { ...d.block };
                      if (e.target.checked) next.button = true;
                      else delete next.button;
                      return { ...d, block: next };
                    }),
                  )
                }
              />
              A button under the headline
            </label>
            {block.media === "video" ? (
              <div>
                {field(
                  `${base}-v`,
                  "Video address",
                  <input
                    id={`${base}-v`}
                    className="field"
                    inputMode="url"
                    value={draft.video}
                    placeholder="https://www.youtube.com/watch?v=…"
                    aria-describedby={`${base}-vh`}
                    onChange={(e) => setVideo(index, e.target.value)}
                  />,
                )}
                <p id={`${base}-vh`} className={`mt-1 text-xs ${draft.video && !recognised ? "font-semibold text-danger" : "text-ink-soft"}`}>
                  {recognised
                    ? `${PROVIDER_NAMES[recognised.provider]} video recognized. It loads only when a visitor presses play (YouTube's privacy-enhanced player, Vimeo with do-not-track).`
                    : draft.video
                      ? "Not a video we can play. Paste a link from YouTube, Vimeo or Loom."
                      : "A link from YouTube, Vimeo or Loom. Nothing else can be played on the page."}
                </p>
              </div>
            ) : null}
            {/*
              A second headline, tested against this one (lib/headline-test.ts).
              Only words: the price and what is sold are the same for everyone.
            */}
            {site ? null : (
            <div id="headline-test" className="scroll-mt-32 rounded-2xl bg-paper p-4 ring-1 ring-line">
              <label className={`flex min-h-11 items-start gap-3 text-sm font-semibold text-ink ${other ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <input type="checkbox" checked={testing && !other} disabled={other !== null} onChange={(e) => setTesting(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" />
                <span>
                  Test a second headline
                  <span className="block font-normal text-ink-soft">
                    {other
                      ? "A second version of the whole page is being tested, and a page runs one test at a time. Write a different headline in version B instead."
                      : product.free
                        ? `Half your visitors see this one, half see the second. Once each has been seen ${MIN_VIEWS} times, there are at least ${MIN_EXPECTED_SIGNUPS * 2} sign-ups between them and one brings clearly more, your page shows that one to everybody by itself. Only the words change.`
                        : `Half your visitors see this one, half see the second. Once each has ${MIN_VIEWS} views and ${MIN_SALES} paid sales, and one clearly brings more gross payments per visitor, your page shows that one to everybody by itself. Only the words change: never the price.`}
                  </span>
                </span>
              </label>
              {testing && !other ? (
                <div className="mt-3 space-y-3">
                  {field(
                    `${base}-th`,
                    "Second headline",
                    <input id={`${base}-th`} className="field" maxLength={MAX_HEADLINE} value={testHeadline} placeholder="Another way to say what they get" onChange={(e) => setTestHeadline(e.target.value)} />,
                    counter(testHeadline, MAX_HEADLINE),
                  )}
                  {field(
                    `${base}-ts`,
                    "Its line under it (optional)",
                    <textarea id={`${base}-ts`} className="field" rows={2} maxLength={MAX_SUBHEADLINE} value={testSub} onChange={(e) => setTestSub(e.target.value)} />,
                  )}
                  {aiOn.on ? (
                    <div>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={writingTest} aria-busy={writingTest} onClick={() => void writeTest({ headline: block.headline, sub: block.sub })} data-write-test>
                        {writingTest ? "Writing…" : "Write a second headline with AI"}
                      </button>
                      <p role="status" aria-atomic="true" className="mt-1 text-xs text-ink-soft">
                        {testNote ?? "From your page and product only, said another way, with no number your page does not state. One of your month's AI jobs; read it before you save."}
                      </p>
                    </div>
                  ) : null}
                  <TestResults key={product.id+":headline:"+(initial.test?.id??"new")} productId={product.id} running={initial.test !== null} what="headline" sold={!product.free} />
                </div>
              ) : null}
            </div>
            )}
          </div>
        );
      }
      case "text":
      case "guarantee": {
        const max = block.kind === "text" ? MAX_TEXT : MAX_GUARANTEE;
        return (
          <div className="space-y-4">
            {field(
              `${base}-h`,
              "Heading",
              <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder={block.kind === "guarantee" ? "Guarantee" : "Optional"} onChange={(e) => change(index, { heading: e.target.value })} />,
            )}
            {field(
              `${base}-b`,
              block.kind === "guarantee" ? "Your refund promise" : "Text",
              <textarea
                id={`${base}-b`}
                className="field"
                rows={block.kind === "text" ? 7 : 4}
                maxLength={max}
                value={block.body}
                placeholder={block.kind === "guarantee" ? "For example: if it is not for you, email me within 14 days and I refund you in full." : "A blank line starts a new paragraph. A line starting with “- ” is a point in a list."}
                onChange={(e) => change(index, { body: e.target.value })}
              />,
              counter(block.body, max),
            )}
            {block.kind === "guarantee" ? (
              <p className="text-xs text-ink-soft">Say only what you will do: buyers read this as a promise, and refunds are made by you, from your Stripe account.</p>
            ) : null}
          </div>
        );
      }
      case "benefits":
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} onChange={(e) => change(index, { heading: e.target.value })} />)}
            <ListEditor
              base={base}
              label="Point"
              items={block.items}
              max={MAX_BENEFITS}
              maxLength={MAX_ITEM}
              onChange={(items) => change(index, { items })}
            />
          </div>
        );
      case "inside": {
        const fromCourse = outline.length ? insideFromCourse(outline, lang) : [];
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} onChange={(e) => change(index, { heading: e.target.value })} />)}
            {fromCourse.length ? (
              <div className="flex flex-wrap items-center gap-3 rounded-xl bg-paper p-3 ring-1 ring-line">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => change(index, { items: fromCourse })}>
                  <Icon name="list" size={15} />
                  {block.items.length ? "Replace with your course's outline" : "Fill from your course's outline"}
                </button>
                <span className="text-xs text-ink-soft">
                  {outline.length === 1
                    ? `${fromCourse.length} ${fromCourse.length === 1 ? "lesson" : "lessons"}, by their titles in the course.`
                    : `${fromCourse.length} modules, each with its lessons, as the course shows them.`}
                </span>
              </div>
            ) : null}
            <PairEditor
              base={base}
              first={{ label: "Part", max: MAX_ITEM }}
              second={{ label: "A line about it (optional)", max: MAX_ITEM_DETAIL }}
              items={block.items.map((item) => [item.title, item.detail] as [string, string])}
              max={MAX_INSIDE_ITEMS}
              onChange={(pairs) => change(index, { items: pairs.map(([title, detail]) => ({ title, detail })) })}
              addLabel="Add a part"
            />
          </div>
        );
      }
      case "bio":
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder={`About ${storeName}`} onChange={(e) => change(index, { heading: e.target.value })} />)}
            {field(
              `${base}-b`,
              "About you",
              <textarea id={`${base}-b`} className="field" rows={5} maxLength={MAX_BIO} value={block.body} placeholder="Who you are, and why you made this." onChange={(e) => change(index, { body: e.target.value })} />,
              counter(block.body, MAX_BIO),
            )}
            <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-sm font-semibold text-ink">
              <input type="checkbox" className="h-4 w-4" checked={block.photo} onChange={(e) => change(index, { photo: e.target.checked })} />
              Show your store photo
            </label>
          </div>
        );
      case "faq":
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} onChange={(e) => change(index, { heading: e.target.value })} />)}
            <PairEditor
              base={base}
              first={{ label: "Question", max: MAX_QUESTION }}
              second={{ label: "Answer", max: MAX_ANSWER, rows: 3 }}
              items={block.items.map((item) => [item.q, item.a] as [string, string])}
              max={MAX_FAQ_ITEMS}
              onChange={(pairs) => change(index, { items: pairs.map(([q, a]) => ({ q, a })) })}
              addLabel="Add a question"
              needsBoth
            />
          </div>
        );
      case "cta":
        return (
          <div className="space-y-4">
            {field(
              `${base}-l`,
              "Button label",
              <input id={`${base}-l`} className="field" maxLength={MAX_CTA_LABEL} value={block.label} placeholder={product.defaultLabel} onChange={(e) => change(index, { label: e.target.value })} />,
              counter(block.label, MAX_CTA_LABEL),
            )}
            {field(
              `${base}-n`,
              "A line under it (optional)",
              <input id={`${base}-n`} className="field" maxLength={MAX_CTA_NOTE} value={block.note} placeholder="For example: instant download, 40 pages as a PDF" onChange={(e) => change(index, { note: e.target.value })} />,
            )}
            <p className="text-xs text-ink-soft">{product.leadsTo}</p>
          </div>
        );
      case "video": {
        const recognised = readVideo(draft.video);
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="Watch the first lesson" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <div>
              {field(
                `${base}-v`,
                "Video address",
                <input
                  id={`${base}-v`}
                  className="field"
                  inputMode="url"
                  value={draft.video}
                  placeholder="https://www.youtube.com/watch?v=…"
                  aria-describedby={`${base}-vh`}
                  onChange={(e) => setVideo(index, e.target.value)}
                />,
              )}
              <p id={`${base}-vh`} className={`mt-1 text-xs ${draft.video && !recognised ? "font-semibold text-danger" : "text-ink-soft"}`}>
                {recognised
                  ? `${PROVIDER_NAMES[recognised.provider]} video recognized. It loads only when a visitor presses play.`
                  : draft.video
                    ? "Not a video we can play. Paste a link from YouTube, Vimeo or Loom."
                    : "A link from YouTube, Vimeo or Loom. Add as many video blocks as the page needs."}
              </p>
            </div>
            {field(
              `${base}-c`,
              "A line under it (optional)",
              <textarea id={`${base}-c`} className="field" rows={2} maxLength={MAX_CAPTION} value={block.caption} placeholder="What the visitor is about to see." onChange={(e) => change(index, { caption: e.target.value })} />,
              counter(block.caption, MAX_CAPTION),
            )}
          </div>
        );
      }
      case "pictures": {
        const elsewhere = drafts.reduce((n, d, i) => (i !== index ? n + (d.block.kind === "pictures" ? d.block.items.length : d.block.kind === "feature" && d.block.picture ? 1 : 0) : n), 0);
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="A look inside" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <PicturesEditor
              base={base}
              productId={product.id}
              pageId={site?.id}
              folder={folder}
              items={block.items}
              room={Math.min(MAX_PICTURES, MAX_PAGE_PICTURES - elsewhere - onlyInOther)}
              onChange={(items) => change(index, { items })}
            />
          </div>
        );
      }
      case "countdown": {
        const passed = clock > 0 && block.until > 0 && block.until * 1000 <= clock;
        return (
          <div className="space-y-4">
            {field(
              `${base}-u`,
              "Counts down to",
              <input id={`${base}-u`} type="datetime-local" className="field" value={toLocalField(block.until)} aria-describedby={`${base}-uh`} onChange={(e) => change(index, { until: fromLocalField(e.target.value) })} />,
            )}
            <p id={`${base}-uh`} className={`-mt-2 text-xs ${passed ? "font-semibold text-danger" : "text-ink-soft"}`}>
              {passed
                ? "That moment has passed, so the countdown is no longer shown on the page. Set a new one, or remove the block."
                : "One moment, typed in your own time zone and shown to each visitor in theirs. It is the same for everybody and never starts again for anyone; once it has passed, the block disappears by itself."}
            </p>
            {field(
              `${base}-h`,
              "Above the numbers",
              <input id={`${base}-h`} className="field" maxLength={MAX_COUNTDOWN_LABEL} value={block.heading} placeholder="The launch price ends in" onChange={(e) => change(index, { heading: e.target.value })} />,
              counter(block.heading, MAX_COUNTDOWN_LABEL),
            )}
            {field(
              `${base}-n`,
              "What changes then (optional)",
              <input id={`${base}-n`} className="field" maxLength={MAX_COUNTDOWN_NOTE} value={block.note} placeholder="After that, the price is $49." onChange={(e) => change(index, { note: e.target.value })} />,
              counter(block.note, MAX_COUNTDOWN_NOTE),
            )}
            <p className="text-xs text-ink-soft">Buyers read this as a promise. Count down only to a moment after which something really changes: a sale that ends, doors that close, a session that starts.</p>
          </div>
        );
      }
      case "feature": {
        const elsewhere = drafts.reduce((n, d, i) => (i !== index ? n + (d.block.kind === "pictures" ? d.block.items.length : d.block.kind === "feature" && d.block.picture ? 1 : 0) : n), 0);
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="What this part of it does for them" onChange={(e) => change(index, { heading: e.target.value })} />)}
            {field(
              `${base}-b`,
              "Text",
              <textarea id={`${base}-b`} className="field" rows={5} maxLength={MAX_TEXT} value={block.body} placeholder="A blank line starts a new paragraph. A line starting with “- ” is a point in a list." onChange={(e) => change(index, { body: e.target.value })} />,
              counter(block.body, MAX_TEXT),
            )}
            <PicturesEditor
              base={base}
              productId={product.id}
              pageId={site?.id}
              folder={folder}
              items={block.picture ? [block.picture] : []}
              room={Math.max(0, Math.min(1, MAX_PAGE_PICTURES - elsewhere - onlyInOther))}
              onChange={(items) => change(index, { picture: items[0] ?? null })}
            />
            <fieldset>
              <legend className="field-label">The picture goes</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {(["left", "right"] as const).map((side) => (
                  <label key={side} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-full px-4 text-sm font-semibold ring-1 focus-within:ring-2 focus-within:ring-violet-brand ${block.side === side ? "bg-lilac text-violet-ink ring-violet-brand/40" : "text-ink-soft ring-line"}`}>
                    <input type="radio" name={`${base}-side`} className="sr-only" checked={block.side === side} onChange={() => change(index, { side })} />
                    {side === "left" ? "On the left" : "On the right"}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-ink-soft">On a phone the picture is always above the words. Alternating sides down the page reads like a story.</p>
            </fieldset>
          </div>
        );
      }
      case "fit": {
        const said = blockWords(lang);
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="Is it for you?" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <div className="rounded-xl bg-paper p-3 ring-1 ring-line">
              {field(`${base}-yl`, "Above the first list", <input id={`${base}-yl`} className="field" maxLength={MAX_HEADING} value={block.yesLabel} placeholder={said.fitYes} onChange={(e) => change(index, { yesLabel: e.target.value })} />)}
              <div className="mt-3">
                <ListEditor base={`${base}-y`} label="Point" items={block.yes} max={MAX_FIT_ITEMS} maxLength={MAX_ITEM} onChange={(yes) => change(index, { yes })} />
              </div>
            </div>
            <div className="rounded-xl bg-paper p-3 ring-1 ring-line">
              {field(`${base}-nl`, "Above the second list", <input id={`${base}-nl`} className="field" maxLength={MAX_HEADING} value={block.noLabel} placeholder={said.fitNo} onChange={(e) => change(index, { noLabel: e.target.value })} />)}
              <div className="mt-3">
                <ListEditor base={`${base}-n`} label="Point" items={block.no} max={MAX_FIT_ITEMS} maxLength={MAX_ITEM} onChange={(no) => change(index, { no })} />
              </div>
            </div>
            <p className="text-xs text-ink-soft">
              Saying who should not buy is the most honest line on a page, and the one that sends back the fewest refunds: a visitor who sees themselves in the second list leaves before paying instead of after. Left empty, the two headings are written in your store&apos;s language.
            </p>
          </div>
        );
      }
      case "steps":
      case "bonuses":
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} onChange={(e) => change(index, { heading: e.target.value })} />)}
            <PairEditor
              base={base}
              first={{ label: block.kind === "steps" ? "Step" : "Bonus", max: MAX_ITEM }}
              second={{ label: "A line about it (optional)", max: MAX_ITEM_DETAIL }}
              items={block.items.map((item) => [item.title, item.detail] as [string, string])}
              max={block.kind === "steps" ? MAX_STEPS : MAX_BONUSES}
              onChange={(pairs) => change(index, { items: pairs.map(([title, detail]) => ({ title, detail })) })}
              addLabel={block.kind === "steps" ? "Add a step" : "Add a bonus"}
            />
            {block.kind === "bonuses" ? (
              <p className="text-xs text-ink-soft">
                Only what really comes with it. There is no place for a &ldquo;worth $497&rdquo; beside a bonus on purpose: a value nobody ever paid makes buyers doubt the rest of the page.
              </p>
            ) : (
              <p className="text-xs text-ink-soft">From the moment they pay to the result: what happens first, what they do next, what they end up with.</p>
            )}
          </div>
        );
      case "compare":
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="Why this, and not the usual way" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <div className="grid gap-3 sm:grid-cols-2">
              {field(`${base}-ca`, "Your column", <input id={`${base}-ca`} className="field" maxLength={MAX_COLUMN} value={block.columnA} placeholder={product.title.slice(0, MAX_COLUMN)} onChange={(e) => change(index, { columnA: e.target.value })} />)}
              {field(`${base}-cb`, "The other column", <input id={`${base}-cb`} className="field" maxLength={MAX_COLUMN} value={block.columnB} placeholder="Figuring it out alone" onChange={(e) => change(index, { columnB: e.target.value })} />)}
            </div>
            <CompareEditor base={base} rows={block.rows} onChange={(rows) => change(index, { rows })} />
            <p className="text-xs text-ink-soft">
              Compare with a way of doing it, not with a named competitor, and write only what you could show to be true. A row with nothing in either column is left out when you save.
            </p>
          </div>
        );
      case "quotes":
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="What people say" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <QuotesEditor base={base} items={block.items} onChange={(items) => change(index, { items })} />
            <p className="text-xs text-ink-soft">
              Only what someone really said in public, in their words, with the address of the post, video or comment, so a visitor can open it and check. The words are shown as they were said, never translated or rewritten. Reviews from your buyers go in the Reviews block, with their stars.
            </p>
          </div>
        );
      case "product": {
        const known = featurable.some((p) => p.id === block.product);
        return (
          <div className="space-y-4">
            {field(
              `${base}-p`,
              "Product",
              <select id={`${base}-p`} className="field" value={known ? block.product : ""} onChange={(e) => change(index, { product: e.target.value })}>
                <option value="">Choose one of your products</option>
                {featurable.map((p) => (
                  <option key={p.id} value={p.id}>{`${p.card.title} (${p.card.pill})`}</option>
                ))}
              </select>,
            )}
            {block.product && !known ? (
              <p className="notice notice-error text-sm" role="status">
                The product chosen before is not among the first 24 on your store page, or is a draft, so its card is not shown. Choose another, or move it up on your store page.
              </p>
            ) : null}
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="Goes well with it" onChange={(e) => change(index, { heading: e.target.value })} />)}
            {field(
              `${base}-n`,
              "A line about why (optional)",
              <input id={`${base}-n`} className="field" maxLength={MAX_PRODUCT_NOTE} value={block.note} placeholder="The recipes from the course, ready to print." onChange={(e) => change(index, { note: e.target.value })} />,
            )}
            <p className="text-xs text-ink-soft">
              Its picture, name and price are always today&apos;s, and the card links to its own page. Products among the first 24 on your store page can be shown.
            </p>
          </div>
        );
      }
      case "form": {
        const forms = site?.forms ?? [];
        const known = forms.some((f) => f.id === block.form);
        return (
          <div className="space-y-4">
            {forms.length ? (
              field(
                `${base}-f`,
                "Form",
                <select id={`${base}-f`} className="field" value={known ? block.form : ""} onChange={(e) => change(index, { form: e.target.value })}>
                  <option value="">Choose one of your forms</option>
                  {forms.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>,
              )
            ) : (
              <p className="notice notice-warn text-sm">You have no forms yet. Make one under Forms in your studio, then choose it here.</p>
            )}
            {block.form && !known ? (
              <p className="notice notice-error text-sm" role="status">
                The form chosen before was deleted, so nothing is shown here. Choose another.
              </p>
            ) : null}
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="A few questions first" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <p className="text-xs text-ink-soft">
              The questions are the form&apos;s, and so is what a person reads after sending it. On a page that is a step of a funnel, sending it leads on to the next step, after the result when it is a quiz.
            </p>
          </div>
        );
      }
      case "facts": {
        const chosen = new Set(block.show);
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading (optional)", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="By the numbers" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <fieldset>
              <legend className="field-label">Which numbers may appear</legend>
              <div className="mt-2 space-y-1">
                {FACT_KEYS.map((fact) => {
                  const now = facts[fact.key];
                  return (
                    <label key={fact.key} className="flex min-h-[44px] cursor-pointer items-start gap-3 py-1 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 shrink-0"
                        checked={chosen.has(fact.key)}
                        onChange={(e) => {
                          const next = new Set(block.show);
                          if (e.target.checked) next.add(fact.key);
                          else next.delete(fact.key);
                          change(index, { show: FACT_KEYS.map((f) => f.key).filter((k): k is FactKey => next.has(k)) });
                        }}
                      />
                      <span>
                        <span className="block font-semibold text-ink">
                          {fact.label}
                          <span className="ml-2 font-normal text-ink-soft">{now ? `now: ${now.value} ${now.label}` : "not shown yet"}</span>
                        </span>
                        <span className="block text-xs text-ink-soft">{fact.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <p className="text-xs text-ink-soft">
              Every number here is counted by your store and kept up to date by itself; none can be typed. One that is not there yet, such as a rating before the first review, simply does not appear.
            </p>
          </div>
        );
      }
      case "reviews": {
        // Picked ones that are still shown; one hidden since no longer takes a place.
        const offered = reviews.filter((r) => !r.refunded);
        const chosen = block.first.filter((id) => offered.some((r) => r.id === id));
        return (
          <div className="space-y-4">
            {field(`${base}-h`, "Heading", <input id={`${base}-h`} className="field" maxLength={MAX_HEADING} value={block.heading} placeholder="Reviews" onChange={(e) => change(index, { heading: e.target.value })} />)}
            <p className="text-xs text-ink-soft">
              Only buyers can write reviews, and they appear here as they come. Without this block they still appear, at the end of the page.
            </p>
            {offered.length > 0 ? (
              <fieldset>
                <legend className="field-label">{`Show first (${chosen.length} of ${MAX_PICKED_REVIEWS})`}</legend>
                <p className="text-xs text-ink-soft">
                  Pick the reviews that answer what buyers ask most. They show before the newest ones, marked &ldquo;Picked by the creator&rdquo;; the average and the count stay those of every review.
                </p>
                <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                  {offered.map((review) => {
                    const on = chosen.includes(review.id);
                    return (
                      <li key={review.id}>
                        <label className={`flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ${on ? "bg-lilac ring-violet-brand/40" : "bg-white ring-line"}`}>
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={on}
                            disabled={!on && chosen.length >= MAX_PICKED_REVIEWS}
                            onChange={() => change(index, { first: on ? chosen.filter((id) => id !== review.id) : [...chosen, review.id] })}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-ink">
                              <span aria-hidden="true">{"★".repeat(review.rating) + "☆".repeat(5 - review.rating)}</span>
                              <span className="sr-only">{`${review.rating} out of 5 stars`}</span>
                              {` · ${review.name || "Verified buyer"}`}
                            </span>
                            {review.text ? <span className="mt-0.5 line-clamp-3 text-xs text-ink-soft [overflow-wrap:anywhere]">{review.text}</span> : null}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ) : (
              <p className="text-xs text-ink-soft">Once buyers review it, you can pick up to three to show first.</p>
            )}
          </div>
        );
      }
    }
  }

  const summaryLine = (block: PageBlock) => {
    switch (block.kind) {
      case "hero":
        return block.headline || product.title;
      case "text":
      case "guarantee":
        return block.heading || block.body.slice(0, 60) || "Empty";
      case "benefits":
      case "inside":
      case "faq":
        return `${block.heading ? `${block.heading} · ` : ""}${block.items.length} ${block.items.length === 1 ? "item" : "items"}`;
      case "bio":
        return block.heading || `About ${storeName}`;
      case "cta":
        return block.label || product.defaultLabel;
      case "reviews":
        return block.heading || "Reviews";
      case "video":
        return block.heading || (block.video ? `${PROVIDER_NAMES[block.video.provider]} video` : "No video yet");
      case "pictures":
        return `${block.heading ? `${block.heading} · ` : ""}${block.items.length} ${block.items.length === 1 ? "picture" : "pictures"}`;
      case "countdown":
        return block.until
          ? `${block.heading ? `${block.heading} · ` : ""}${new Date(block.until * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
          : "No moment set yet";
      case "fit":
        return `${block.heading ? `${block.heading} · ` : ""}${block.yes.length} for, ${block.no.length} not for`;
      case "steps":
      case "bonuses":
        return `${block.heading ? `${block.heading} · ` : ""}${block.items.length} ${block.kind === "steps" ? (block.items.length === 1 ? "step" : "steps") : block.items.length === 1 ? "bonus" : "bonuses"}`;
      case "compare":
        return `${block.heading ? `${block.heading} · ` : ""}${block.rows.length} ${block.rows.length === 1 ? "row" : "rows"}`;
      case "feature":
        return block.heading || (block.body ? block.body.slice(0, 60) : block.picture ? "A picture, no words yet" : "Empty");
      case "product": {
        const chosen = featurable.find((p) => p.id === block.product);
        return `${block.heading ? `${block.heading} · ` : ""}${chosen ? chosen.card.title : "No product chosen yet"}`;
      }
      case "quotes":
        return `${block.heading ? `${block.heading} · ` : ""}${block.items.length} said elsewhere`;
      case "form": {
        const chosen = site?.forms?.find((f) => f.id === block.form);
        return `${block.heading ? `${block.heading} · ` : ""}${chosen ? chosen.name : "No form chosen yet"}`;
      }
      case "facts": {
        const live = block.show.filter((key) => facts[key]).length;
        return `${block.heading ? `${block.heading} · ` : ""}${live} ${live === 1 ? "number" : "numbers"} shown now`;
      }
    }
  };

  const kind = site ? "Page" : product.free ? "Landing page" : "Sales page";

  return (
    <section aria-labelledby="page-title" className="card min-w-0 p-5 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="page-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            {site ? product.title : `${kind} for ${product.title}`}
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {initial.blocks.length
              ? `${initial.blocks.length} ${initial.blocks.length === 1 ? "block" : "blocks"} ${site ? "on this page" : "live on its page"}.`
              : site
                ? "No blocks yet: until it has some, the page is not shown."
                : "No blocks yet: the product's page shows its picture, description and buy box, as it always has."}
          </p>
        </div>
        <span className={`tag ${initial.blocks.length && !hiddenNow ? "tag-live" : ""}`}>
          {!initial.blocks.length ? "Plain" : !hiddenNow ? "Built" : initial.showFrom && clock ? `Shows ${whenSaved(initial.showFrom * 1000)}` : "Hidden"}
        </span>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-full bg-paper p-1 ring-1 ring-line" role="group" aria-label="Build or preview">
          {(["build", "preview"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold transition-colors ${view === v ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink"}`}
            >
              {v === "build" ? "Build" : "Preview"}
            </button>
          ))}
        </div>
        <div className="inline-flex gap-1" role="group" aria-label="Undo and redo">
          <button
            id="undo-step"
            type="button"
            onClick={() => stepTo("back")}
            disabled={stepsLeft.back === 0 && !dirty}
            title="Undo (Ctrl+Z)"
            aria-label="Undo the last change"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft ring-1 ring-line transition-colors hover:text-ink disabled:opacity-35"
          >
            <Icon name="undo" size={18} />
          </button>
          <button
            id="redo-step"
            type="button"
            onClick={() => stepTo("forward")}
            disabled={stepsLeft.forward === 0}
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft ring-1 ring-line transition-colors hover:text-ink disabled:opacity-35"
          >
            <Icon name="redo" size={18} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4">
          {shareUrl ? (
            <button
              type="button"
              aria-expanded={sharing}
              aria-controls="share-panel"
              onClick={() => setSharing((v) => !v)}
              className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-violet-deep underline-offset-4 hover:underline"
            >
              <Icon name="link" size={15} />
              Share
            </button>
          ) : null}
          <a href={pageHref} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-sm font-semibold text-violet-deep underline-offset-4 hover:underline">
            Open the live page
            <Icon name="external" size={15} />
          <NewTab /></a>
        </div>
      </div>
      {shareUrl && sharing ? (
        <section id="share-panel" aria-label={`Share ${product.title}`} className="mt-4 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
          <SharePanel url={shareUrl} title={product.title} />
          {site ? null : <AiPosts productId={product.id} url={shareUrl} page={pageToSend} />}
        </section>
      ) : null}

      {view === "preview" ? (
        <div className="mt-5">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-soft">Width:</span>
            {[false, true].map((w) => (
              <button
                key={String(w)}
                type="button"
                aria-pressed={wide === w}
                onClick={() => setWide(w)}
                className={`inline-flex min-h-11 items-center rounded-full px-3 font-semibold ring-1 ${wide === w ? "bg-lilac text-violet-ink ring-violet-brand/40" : "text-ink-soft ring-line"}`}
              >
                {w ? "Wide" : "Phone"}
              </button>
            ))}
            {dirty ? <span className="ml-auto text-xs font-semibold text-ink-soft">Showing unsaved changes</span> : null}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink-soft">Style:</span>
            <PageStylePicker value={style} onChange={setStyle} compact />
          </div>
          {pagePreview(wide)}
        </div>
      ) : (
        // On a wide screen the page is drawn beside the blocks as they are edited.
        <div className={sideBySide ? "grid grid-cols-[minmax(0,1fr)_24.5rem] items-start gap-6" : ""}>
        <div className="min-w-0">
          {drafts.length === 0 ? (
            <div className="mt-6 rounded-2xl bg-paper p-5 ring-1 ring-line sm:p-6">
              <p className="font-semibold text-ink">Start the page</p>
              <p className="mt-1 text-sm text-ink-soft">
                {site
                  ? "Add blocks one by one below: a headline at the top, then text, pictures, a video, questions, your products and a button."
                  : `Begin from what ${product.title} already says — its title, summary and description, a button and a place for reviews — or add blocks one by one below.`}
              </p>
              {site ? null : (
                <button type="button" onClick={startFromDescription} className="btn btn-primary mt-4">
                  <Icon name="sparkle" size={17} />
                  Start from the description
                </button>
              )}
              {templates.length > 0 ? (
                <div className="mt-6 border-t border-line pt-5">
                  <p className="field-label">Or start from a template</p>
                  <p className="text-xs text-ink-soft">
                    A template is an order of blocks with their headings, under your headline and a button: the words are yours to write, and a block you leave empty is not shown.
                  </p>
                  <ul className="mt-3 grid gap-3 sm:grid-cols-2">
                    {templates.map((t) => {
                      const outline = templateOutline(t.id);
                      return (
                        <li key={t.id} className="flex flex-col rounded-2xl bg-white p-4 ring-1 ring-line">
                          <p className="text-sm font-semibold text-ink">{t.label}</p>
                          <p className="mt-1 text-xs text-ink-soft">{t.hint}</p>
                          <ol className="mt-3 flex flex-wrap gap-1.5" aria-label={`The blocks of the ${t.label} template, in order`}>
                            {outline.map((kind, i) => (
                              <li key={`${kind}-${i}`} className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-[0.75rem] font-medium text-ink-soft ring-1 ring-line">
                                <Icon name={KIND_ICONS[kind]} size={12} />
                                {kindLabel(kind)}
                              </li>
                            ))}
                          </ol>
                          <button type="button" onClick={() => startFromTemplate(t.id)} className="btn btn-secondary btn-sm mt-4 self-start" aria-label={`Use the ${t.label} template`}>
                            Use this template
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {pagesToCopy.length > 0 ? (
                <div className="mt-6 border-t border-line pt-5">
                  <label htmlFor="page-copy" className="field-label">
                    Or start from another product&apos;s page
                  </label>
                  <div className="mt-1 flex flex-wrap items-end gap-3">
                    <select id="page-copy" className="field min-w-0 flex-1" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                      {pagesToCopy.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void startFromCopy()} className="btn btn-secondary" disabled={copying} aria-busy={copying}>
                      {copying ? "Copying…" : "Copy its blocks"}
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">
                    Its blocks in the same order, with their words and videos, for you to change into this product&apos;s. Its pictures stay on its own page. Nothing is saved until you press Save, and the other page does not change.
                  </p>
                  {copyNote ? (
                    <p className="notice notice-error mt-2 text-sm" role="alert">
                      {copyNote}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {drafts.length > 0 && !site ? (
            <PageCoach
              productId={product.id}
              productTitle={product.title}
              free={product.free}
              picture={Boolean(product.picture)}
              pictureAlt={product.picture?.alt ?? ""}
              facts={facts}
              // The version being edited: what the coach adds goes into it. The other version, never this one twice,
              // is the second one, whose pictures are counted too (independent review, 31/10/2026).
              page={{ ...pageToSend(), blocks: drafts.map((d) => d.block), variant: other ? { id: "", blocks: other.map((d) => d.block) } : null }}
              reach={reach}
              onAdd={(kind) => (kind === "fit" || kind === "facts" || kind === "steps" ? insertNear(emptyBlock(kind), kind === "facts" ? ["hero"] : ["benefits", "inside"]) : add(kind))}
              onHeadline={putHeadline}
              onTest={(headline, sub) => {
                if (other) return;
                setTesting(true);
                setTestHeadline(headline.slice(0, MAX_HEADLINE));
                setTestSub(sub.slice(0, MAX_SUBHEADLINE));
              }}
              onFit={(yes, no) =>
                insertNear({ ...(emptyBlock("fit") as Extract<PageBlock, { kind: "fit" }>), yes: yes.slice(0, MAX_FIT_ITEMS), no: no.slice(0, MAX_FIT_ITEMS) }, ["benefits", "inside", "steps"])
              }
              onQuestions={addQuestions}
              traffic={traffic}
              asked={asked}
            />
          ) : null}

          {answers && !product.free ? (
            <PageAnswers
              whyNot={answers.whyNot}
              videos={answers.videos}
              asking={answers.asking}
              canSet
              reachOf={(block) =>
                reach && reach.visitors >= MIN_DEPTH_VISITORS && reach.shares[block] !== undefined ? Math.round((reach.shares[block] / 100) * reach.visitors) : null
              }
              blockName={(block) => {
                const at = drafts.findIndex((d) => d.block.id === block);
                return at >= 0 ? `${at + 1}. ${kindLabel(drafts[at].block.kind)}` : "A block since removed";
              }}
            />
          ) : null}

          {/*
            The whole page drafted at once (lib/ai.ts, writePage), from what the
            product already says and anything written in the box. It replaces
            the blocks in this editor only: nothing is saved until Save, and
            leaving without saving keeps the page as it was.
          */}
          {site ? null : (
          <div className="mt-6">
            <AiAssist<DraftCopy>
              title="Write the whole page with AI"
              hint={`A full draft — headline, what the buyer gets, what is inside, questions and buttons — from ${product.title}'s name, price and description. Add anything else it should know below, or leave the box empty. It replaces the blocks here; nothing is saved until you press Save.`}
              placeholder="Who it is for, what makes it different, what buyers ask you most. Your refund promise, if you have one."
              allowEmpty
              payload={() => ({ kind: "page", product: product.id, readFile: product.pdf === true && readFile })}
              extra={
                product.pdf ? (
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-ink">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" checked={readFile} onChange={(e) => setReadFile(e.target.checked)} />
                    <span>
                      <span className="font-semibold">{`Read the first ${READ_PDF_PAGES} pages of ${product.title}'s PDF too`}</span>
                      <span className="block text-ink-soft">{`So \u201cWhat's inside\u201d lists its real contents. Takes ${1 + READ_PDF_JOBS} of your writing jobs instead of 1. Only those pages are read, and nothing is kept.`}</span>
                    </span>
                  </label>
                ) : undefined
              }
              onResult={(draft) => {
                const page = blocksFromDraft(draft, Boolean(product.picture));
                setDrafts(toDrafts(page));
                if (page.seoTitle) setSeoTitle(page.seoTitle);
                if (page.seoDescription) setSeoDescription(page.seoDescription);
                setOpen(page.blocks[0]?.id ?? null);
              }}
              done="Drafted. Read each block, change what is not yours, then press Save."
            />
          </div>
          )}

          {drafts.length > 0 && !site ? (
            <div className="mt-3">
              <TranslatePage
                productId={product.id}
                storeLanguage={lang}
                page={pageToSend}
                onResult={(page, sent) => {
                  // Only over the words it was given: an edit made meanwhile is never lost.
                  if (!unchangedSince(sent)) return false;
                  putVersions(page, onB);
                  setSeoTitle(page.seoTitle);
                  setSeoDescription(page.seoDescription);
                  if (page.test) {
                    setTestHeadline(page.test.headline);
                    setTestSub(page.test.sub);
                  }
                  return true;
                }}
              />
            </div>
          ) : null}

          {draftsA.length > 0 && !site ? (
            <section aria-labelledby="page-test-title" className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
              <p id="page-test-title" className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Icon name="chart" size={17} />
                Test a second version of the whole page
              </p>
              {other === null ? (
                <>
                  <p className="mt-1 text-xs text-ink-soft">
                    {`Make version B from this page and change anything in it: blocks, their order, words, pictures, video. Half your visitors see each version. ${product.free ? `Once each has been seen ${MIN_VIEWS} times, there are at least ${MIN_EXPECTED_SIGNUPS * 2} sign-ups between them and one brings clearly more` : `Once each has ${MIN_VIEWS} views and ${MIN_SALES} paid sales, and one clearly brings more gross payments per visitor`}, your page shows that one to everybody by itself. The price and what is sold stay the same for everyone.`}
                  </p>
                  <button type="button" onClick={startPageTest} className="btn btn-secondary btn-sm mt-3">
                    Make version B
                  </button>
                </>
              ) : (
                <>
                  <div className="mt-3 inline-flex rounded-full bg-white p-1 ring-1 ring-line" role="group" aria-label="The version you are editing">
                    {([false, true] as const).map((b) => (
                      <button
                        key={String(b)}
                        type="button"
                        aria-pressed={onB === b}
                        onClick={() => switchVersion(b)}
                        className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold transition-colors ${onB === b ? "bg-lilac text-violet-ink ring-1 ring-violet-brand/40" : "text-ink-soft hover:text-ink"}`}
                      >
                        {b ? "Version B" : "Version A"}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">
                    {`You are editing version ${onB ? "B" : "A"}: the blocks below and the preview are ${onB ? "B's" : "A's"}. Changing either version after a save starts the count again, so a result is never about a page visitors did not see.`}
                  </p>
                  <div className="mt-3">
                    <TestResults key={product.id+":page:"+(initial.variant?.id??"new")} productId={product.id} running={initial.variant !== null} what="page" sold={!product.free} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => endPageTest("a")} className="btn btn-secondary btn-sm">
                      Keep version A, end the test
                    </button>
                    <button type="button" onClick={() => endPageTest("b")} className="btn btn-secondary btn-sm">
                      Keep version B, end the test
                    </button>
                  </div>
                </>
              )}
            </section>
          ) : null}

          <ol className="mt-6">
            {drafts.map((draft, index) => {
              const block = draft.block;
              const isOpen = open === block.id;
              const locked = block.kind === "hero";
              return (
                <li
                  key={block.id}
                  id={`row-${block.id}`}
                  className="relative scroll-mt-28"
                  onDragOver={(event) => {
                    if (dragged === null || locked) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    if (over !== index) setOver(index);
                  }}
                  onDrop={(event) => {
                    if (dragged === null || locked) return;
                    event.preventDefault();
                    moveTo(dragged, index);
                    setDragged(null);
                    setOver(null);
                  }}
                >
                  <div className={`rounded-2xl border bg-white transition-shadow ${over === index && dragged !== null && dragged !== index && !locked ? "border-violet-brand ring-2 ring-violet-brand/30" : "border-line"} ${dragged === index ? "opacity-60" : ""}`}>
                  <div className="flex items-center gap-2 p-2 pl-3 sm:gap-3">
                    {/* The handle: dragged with a mouse to put the block somewhere else. The arrows beside it do the same from a keyboard or a phone. */}
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep ${locked ? "" : "cursor-grab active:cursor-grabbing"}`}
                      draggable={!locked}
                      title={locked ? undefined : "Drag to move this block"}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", block.id);
                        const row = event.currentTarget.closest("li");
                        if (row) event.dataTransfer.setDragImage(row, 24, 24);
                        setDragged(index);
                      }}
                      onDragEnd={() => {
                        setDragged(null);
                        setOver(null);
                      }}
                    >
                      <Icon name={KIND_ICONS[block.kind]} size={17} />
                    </span>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`panel-${block.id}`}
                      onClick={() => setOpen(isOpen ? null : block.id)}
                      className="flex min-h-[44px] min-w-0 flex-1 flex-col items-start justify-center text-left"
                    >
                      <span className="text-sm font-semibold text-ink">{`${index + 1}. ${kindLabel(block.kind)}`}</span>
                      <span className="w-full truncate text-xs text-ink-soft">
                        {block.saved ? "Saved section · " : ""}
                        {block.screens === "phone" ? "Phones only · " : block.screens === "computer" ? "Computers and tablets only · " : ""}
                        {summaryLine(block)}
                        {reach && reach.visitors >= MIN_DEPTH_VISITORS && reach.shares[block.id] !== undefined
                          ? ` · ${reach.shares[block.id]}% of visitors reach it`
                          : ""}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center">
                      <button
                        type="button"
                        onClick={() => move(index, -1)}
                        disabled={locked || index === 0 || (index === 1 && hasHero)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-paper hover:text-ink disabled:opacity-30"
                        aria-label={`Move block ${index + 1} up`}
                      >
                        <Icon name="chevron-down" size={18} className="rotate-180" />
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={locked || index === drafts.length - 1}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-paper hover:text-ink disabled:opacity-30"
                        aria-label={`Move block ${index + 1} down`}
                      >
                        <Icon name="chevron-down" size={18} />
                      </button>
                      {canDuplicate(block) ? (
                        <button
                          type="button"
                          onClick={() => duplicate(index)}
                          disabled={drafts.length >= MAX_BLOCKS}
                          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-paper hover:text-ink disabled:opacity-30"
                          aria-label={`Duplicate block ${index + 1}, ${kindLabel(block.kind)}`}
                        >
                          <Icon name="copy" size={17} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => remove(index)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-danger-soft hover:text-danger"
                        aria-label={`Remove block ${index + 1}, ${kindLabel(block.kind)}`}
                      >
                        <Icon name="trash" size={17} />
                      </button>
                    </div>
                  </div>
                  {isOpen ? (
                    <div id={`panel-${block.id}`} className="border-t border-line p-4 sm:p-5">
                      {blockFields(draft, index)}
                      {block.kind !== "hero" ? (
                        <div className="mt-5 border-t border-line pt-4">
                          <p className="field-label" id={`screens-${block.id}`}>
                            Shows on
                          </p>
                          <div role="group" aria-labelledby={`screens-${block.id}`} className="flex flex-wrap gap-2">
                            {BLOCK_SHOWS.map((option) => {
                              const on = (block.screens ?? "all") === option.value;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  aria-pressed={on}
                                  onClick={() =>
                                    setDrafts((all) =>
                                      all.map((d, i) => {
                                        if (i !== index) return d;
                                        const next = { ...d.block } as PageBlock;
                                        if (option.value === "all") delete next.screens;
                                        else next.screens = option.value;
                                        return { ...d, block: next };
                                      }),
                                    )
                                  }
                                  className={`inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold ring-1 ${on ? "bg-lilac text-violet-ink ring-violet-brand/40" : "text-ink-soft ring-line"}`}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                          <p className="mt-1 text-xs text-ink-soft">
                            A shorter list for phones, a wide table only where it fits. Preview at Phone or Wide width to see each.
                          </p>
                        </div>
                      ) : null}
                      {site ? null : (
                        <BlockRewrite
                          key={block.id}
                          productId={product.id}
                          block={block}
                          page={pageToSend}
                          onChange={(next) => setDrafts((all) => all.map((d, i) => (i === index ? { ...d, block: next } : d)))}
                        />
                      )}
                    </div>
                  ) : null}
                  </div>
                  {/* Between two blocks: a block added right here, rather than at the end and moved up. */}
                  {index < drafts.length - 1 ? (
                    picking === index + 1 && drafts.length < MAX_BLOCKS ? (
                      <div className="py-3">
                        <BlockPicker icons={KIND_ICONS} allowed={addable.map((k) => k.kind)} where={`after block ${index + 1}`} onPick={(kind) => add(kind, index + 1)} onClose={() => setPicking(null)} />
                      </div>
                    ) : drafts.length >= MAX_BLOCKS ? (
                      <div className="h-3" />
                    ) : (
                      <div className="flex h-9 items-center justify-center">
                        <button
                          type="button"
                          onClick={() => setPicking(index + 1)}
                          className="inline-flex h-7 items-center gap-1 rounded-full bg-white px-2.5 text-xs font-semibold text-ink-soft ring-1 ring-line transition hover:text-violet-deep hover:ring-violet-brand/50 focus-visible:ring-2 focus-visible:ring-violet-brand"
                          aria-label={`Add a block after block ${index + 1}`}
                        >
                          <Icon name="plus" size={13} />
                          Add here
                        </button>
                      </div>
                    )
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="mt-4">
            {drafts.length >= MAX_BLOCKS ? (
              <p className="rounded-2xl border-2 border-dashed border-line-strong p-3 text-sm text-ink-soft sm:p-4">{`${MAX_BLOCKS} blocks is the most one page can have.`}</p>
            ) : picking === drafts.length ? (
              <BlockPicker icons={KIND_ICONS} allowed={addable.map((k) => k.kind)} where="at the end" onPick={(kind) => add(kind)} onClose={() => setPicking(null)} />
            ) : (
              <button
                type="button"
                onClick={() => setPicking(drafts.length)}
                className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong p-3 text-sm font-semibold text-ink-soft transition hover:border-violet-brand/60 hover:text-violet-deep sm:p-4"
              >
                <Icon name="plus" size={17} />
                {`Add a block (${drafts.length} of ${MAX_BLOCKS})`}
              </button>
            )}
          </div>

          <SavedSections
            pageKey={pageKey}
            allowed={site ? site.kinds : BLOCK_KINDS.map((k) => k.kind).filter((kind) => kind !== "form")}
            blocks={drafts.map((d) => d.block)}
            room={MAX_BLOCKS - drafts.length}
            disabled={busy}
            onInsert={insertSection}
          />

          <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
            <p className="field-label">Page style</p>
            <p className="text-xs text-ink-soft">How the sections are set apart, in your store&apos;s colors. Switch to Preview to see it on this page.</p>
            <PageStylePicker value={style} onChange={setStyle} />
          </div>

          {product.free ? (
            <div className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
              <label htmlFor="next-product" className="field-label">
                After someone signs up, show
              </label>
              <select id="next-product" className="field" value={next} onChange={(e) => setNext(e.target.value)}>
                <option value="">Nothing more</option>
                {nextOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-soft">
                A card with that product&apos;s picture, price and a link to its own page, under &ldquo;Check your inbox&rdquo; and beside the download. Nothing is charged or added for them.
              </p>
            </div>
          ) : null}

          <details
            className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5"
            onToggle={(event) => {
              if (event.currentTarget.open) void loadVersions();
            }}
          >
            <summary className="cursor-pointer text-sm font-semibold text-ink">
              <span className="inline-flex items-center gap-2">
                <Icon name="history" size={17} />
                Earlier versions
              </span>
            </summary>
            <p className="mt-3 text-xs text-ink-soft">
              The page as it was before each of your last five saves, kept as long as the page is and counted in your store&apos;s data room. Loading one changes nothing live until you press Save.
            </p>
            {versionNote ? (
              <p className="notice notice-error mt-3" role="alert">
                {versionNote}
              </p>
            ) : versions === null ? (
              <p className="mt-3 text-sm text-ink-soft">Reading…</p>
            ) : versions.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">None yet. Each time you save, the page as it was is kept here.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-xl bg-white ring-1 ring-line">
                {versions.map((v) => (
                  <li key={v.index} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{whenSaved(v.at)}</span>
                      <span className="block truncate text-xs text-ink-soft">
                        {`${v.blocks} ${v.blocks === 1 ? "block" : "blocks"}${v.headline ? ` · “${v.headline}”` : ""}`}
                      </span>
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void bringBack(v.index)} aria-label={`Load the version from ${whenSaved(v.at)}`}>
                      Load
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>

          <details className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line sm:p-5">
            <summary className="cursor-pointer text-sm font-semibold text-ink">Search and sharing</summary>
            <div className="mt-4 space-y-4">
              {field(
                "seo-title",
                "Title in search results and shared links",
                <input id="seo-title" className="field" maxLength={MAX_SEO_TITLE} value={seoTitle} placeholder={`${product.title} — ${storeName}`} onChange={(e) => setSeoTitle(e.target.value)} />,
                counter(seoTitle, MAX_SEO_TITLE),
              )}
              {field(
                "seo-description",
                "Description",
                <textarea id="seo-description" className="field" rows={2} maxLength={MAX_SEO_DESCRIPTION} value={seoDescription} placeholder={product.summary || "One or two sentences on what it is."} onChange={(e) => setSeoDescription(e.target.value)} />,
                counter(seoDescription, MAX_SEO_DESCRIPTION),
              )}
              {site ? null : (
                <p className="text-xs text-ink-soft">
                  The picture a shared link unfolds into is made from the product&apos;s picture, its title, price and — once buyers review it — its stars.
                </p>
              )}
            </div>
          </details>
        </div>
        {sideBySide ? (
        <aside
          ref={beside}
          aria-label="The page as visitors see it"
          className="sp-beside sticky top-24 mt-6 max-h-[calc(100vh-7rem)] overflow-y-auto rounded-2xl"
          onClick={(event) => {
            // A press on a part of the page opens its block for editing, beside it.
            const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-block]") : null;
            const id = target?.dataset.block;
            if (!id || !drafts.some((d) => d.block.id === id)) return;
            setOpen(id);
            document.getElementById(`row-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          <p className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-ink-soft">
            <span>{`As visitors see it${other ? (onB ? ", version B" : ", version A") : ""}, on a phone · press a part to edit it`}</span>
            {dirty ? <span>Unsaved</span> : null}
          </p>
          {pagePreview(false)}
        </aside>
        ) : null}
        </div>
      )}

      {error ? (
        <p className="notice notice-error mt-4" role="alert">
          {error}
        </p>
      ) : null}

      {drafts.length > 0 ? (
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl bg-paper p-4 ring-1 ring-line">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={!hidden} onChange={(e) => setHidden(!e.target.checked)} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">Visitors see this page</span>
            <span className="mt-0.5 block text-xs text-ink-soft">
              {site
                ? hidden
                  ? "Off: the page is not shown, and not in your store's menu, while you work on it. Save as often as you like; switch it on and save when it is ready, or have it show by itself at a moment you choose."
                  : "On: once you save, visitors see it at its address, and in your store's menu if it is there."
                : hidden
                  ? "Off: visitors see the product's plain page while you work on this one. Save as often as you like; switch it on and save when it is ready, or have it show by itself at a moment you choose."
                  : "On: once you save, this is the product's page. Switch it off to keep working on it out of sight."}
            </span>
          </span>
        </label>
      ) : null}
      {drafts.length > 0 && hidden ? (
        <div className="mt-3 rounded-2xl bg-paper p-4 ring-1 ring-line">
          {field(
            "page-show-from",
            "Show it by itself at (optional)",
            <input
              id="page-show-from"
              type="datetime-local"
              className="field"
              value={toLocalField(showFrom)}
              onChange={(e) => setShowFrom(fromLocalField(e.target.value))}
            />,
          )}
          <p className="mt-1 text-xs text-ink-soft">
            {showFrom && clock && showFrom * 1000 <= clock
              ? "That moment has passed: once saved, visitors see this page."
              : showFrom
                ? `Visitors see it from ${whenSaved(showFrom * 1000)}, your time, without you doing anything. Leave it empty to show it only when you switch it on.`
                : "Say when, in your own time, and the page shows itself then: a launch at nine on Monday with nobody at the keyboard."}
          </p>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => send(pageToSend(), "Page saved.")} aria-busy={busy} disabled={busy || !dirty} className="btn btn-primary">
          {busy ? "Saving…" : "Save the page"}
        </button>
        {dirty ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              putVersions(initial, false);
              setSeoTitle(initial.seoTitle);
              setSeoDescription(initial.seoDescription);
              setNext(initial.next ?? "");
              setStyle(initial.style);
              setHidden(initial.hidden);
              setShowFrom(initial.showFrom);
              setTesting(initial.test !== null);
              setTestHeadline(initial.test?.headline ?? "");
              setTestSub(initial.test?.sub ?? "");
              setError(null);
            }}
          >
            Undo changes
          </button>
        ) : null}
        {initial.blocks.length > 0 && !dirty && !site ? (
          confirmClear ? (
            <span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
              Back to the plain page?
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => send(null, "Page cleared.")}>
                Yes, clear it
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmClear(false)}>
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmClear(true)}>
              Clear the page
            </button>
          )
        ) : null}
      </div>
    </section>
  );
}

/** A list of one-line points. */
/** The rows of a comparison: what is compared, and a cell for each column, with a tick and a cross a press away. */
/** Things said elsewhere: the words, who said them, and where (lib/sales-page.ts, QuotesBlock). */
function QuotesEditor({ base, items, onChange }: { base: string; items: Quote[]; onChange: (items: Quote[]) => void }) {
  const [pasteBlocked, setPasteBlocked] = useState(false);
  const set = (i: number, patch: Partial<Quote>) => onChange(items.map((item, j) => (j === i ? { ...item, ...patch } : item)));
  return (
    <div className="space-y-3">
      {pasteBlocked ? <p role="alert" className="text-sm font-semibold text-danger">That paste exceeds the {MAX_QUOTE}-character quote limit. Nothing was pasted. Choose a complete quotation that fits.</p> : null}
      {items.map((item, i) => {
        const badLink = item.url.trim() !== "" && !quoteUrl(item.url);
        const noLink = item.text.trim() !== "" && item.url.trim() === "";
        return (
          <div key={i} className="rounded-xl bg-paper p-3 ring-1 ring-line">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">{`Said elsewhere ${i + 1}`}</p>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                aria-label={`Remove what was said elsewhere ${i + 1}`}
              >
                <Icon name="close" size={15} />
              </button>
            </div>
            <label htmlFor={`${base}-q${i}t`} className="mt-1 block text-xs font-semibold text-ink-soft">
              Their words, as they said them
            </label>
            <textarea
              id={`${base}-q${i}t`}
              className="field mt-1"
              rows={3}
              maxLength={MAX_QUOTE}
              value={item.text}
              onPaste={(event) => {
                const input = event.currentTarget;
                const text = event.clipboardData.getData("text/plain");
                if (!text) return;
                const blocked = pasteExceedsLimit(input.value, input.selectionStart, input.selectionEnd, text, MAX_QUOTE);
                if (blocked) event.preventDefault();
                setPasteBlocked(blocked);
              }}
              onChange={(event) => {
                setPasteBlocked(false);
                set(i, { text: event.target.value });
              }}
            />
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor={`${base}-q${i}n`} className="text-xs font-semibold text-ink-soft">
                  Who said it (optional)
                </label>
                <input id={`${base}-q${i}n`} className="field mt-1" maxLength={MAX_QUOTE_NAME} value={item.name} placeholder="Their name or handle" onChange={(e) => set(i, { name: e.target.value })} />
              </div>
              <div className="min-w-0">
                <label htmlFor={`${base}-q${i}u`} className="text-xs font-semibold text-ink-soft">
                  Where it was said
                </label>
                <input
                  id={`${base}-q${i}u`}
                  className="field mt-1"
                  type="url"
                  inputMode="url"
                  maxLength={MAX_QUOTE_URL}
                  value={item.url}
                  placeholder="https://x.com/…/status/…"
                  aria-invalid={badLink || noLink}
                  aria-describedby={badLink || noLink ? `${base}-q${i}e` : undefined}
                  onChange={(e) => set(i, { url: e.target.value })}
                />
              </div>
            </div>
            {badLink || noLink ? (
              <p id={`${base}-q${i}e`} className="mt-1 text-xs font-semibold text-danger">
                {badLink ? "That is not a full https address of a public page." : "Add the address of the post, video or comment where it was said."}
              </p>
            ) : null}
          </div>
        );
      })}
      {items.length < MAX_QUOTES ? (
        <button type="button" onClick={() => onChange([...items, { text: "", name: "", url: "" }])} className="btn btn-ghost btn-sm">
          <Icon name="plus" size={15} />
          {`Add one (${items.length} of ${MAX_QUOTES})`}
        </button>
      ) : null}
    </div>
  );
}

function CompareEditor({ base, rows, onChange }: { base: string; rows: CompareRow[]; onChange: (rows: CompareRow[]) => void }) {
  const set = (i: number, patch: Partial<CompareRow>) => onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const cell = (i: number, side: "a" | "b", label: string) => {
    const value = rows[i][side];
    return (
      <div className="min-w-0">
        <label htmlFor={`${base}-r${i}${side}`} className="text-xs font-semibold text-ink-soft">
          {label}
        </label>
        <div className="mt-1 flex items-center gap-1.5">
          <input
            id={`${base}-r${i}${side}`}
            className="field min-w-0"
            maxLength={MAX_CELL}
            value={value === CELL_YES ? "" : value === CELL_NO ? "" : value}
            placeholder={value === CELL_YES ? "A check mark" : value === CELL_NO ? "A cross" : "A few words"}
            onChange={(e) => set(i, { [side]: e.target.value })}
          />
          <button
            type="button"
            aria-pressed={value === CELL_YES}
            onClick={() => set(i, { [side]: value === CELL_YES ? "" : CELL_YES })}
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-1 ring-line ${value === CELL_YES ? "bg-mint-soft text-mint-deep" : "text-ink-soft hover:bg-paper"}`}
            aria-label={`A check mark in ${label.toLowerCase()}`}
          >
            <Icon name="check" size={16} />
          </button>
          <button
            type="button"
            aria-pressed={value === CELL_NO}
            onClick={() => set(i, { [side]: value === CELL_NO ? "" : CELL_NO })}
            className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-1 ring-line ${value === CELL_NO ? "bg-danger-soft text-danger" : "text-ink-soft hover:bg-paper"}`}
            aria-label={`A cross in ${label.toLowerCase()}`}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-3">
      {rows.map((row, i) => (
        <div key={i} className="rounded-xl bg-paper p-3 ring-1 ring-line">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">{`Row ${i + 1}`}</p>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
              aria-label={`Remove row ${i + 1}`}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
          <label htmlFor={`${base}-r${i}l`} className="sr-only">{`What row ${i + 1} compares`}</label>
          <input
            id={`${base}-r${i}l`}
            className="field mt-1"
            maxLength={MAX_ITEM}
            value={row.label}
            placeholder="What is compared, e.g. Feedback on your work"
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {cell(i, "a", "Your column")}
            {cell(i, "b", "The other column")}
          </div>
        </div>
      ))}
      {rows.length < MAX_COMPARE_ROWS ? (
        <button type="button" onClick={() => onChange([...rows, { label: "", a: CELL_YES, b: CELL_NO }])} className="btn btn-ghost btn-sm">
          <Icon name="plus" size={15} />
          {`Add a row (${rows.length} of ${MAX_COMPARE_ROWS})`}
        </button>
      ) : null}
    </div>
  );
}

function ListEditor({
  base,
  label,
  items,
  max,
  maxLength,
  onChange,
}: {
  base: string;
  label: string;
  items: string[];
  max: number;
  maxLength: number;
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <label htmlFor={`${base}-i${i}`} className="sr-only">{`${label} ${i + 1}`}</label>
          <input
            id={`${base}-i${i}`}
            className="field"
            maxLength={maxLength}
            value={item}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
            aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
      {items.length < max ? (
        <button type="button" onClick={() => onChange([...items, ""])} className="btn btn-ghost btn-sm">
          <Icon name="plus" size={15} />
          {`Add a ${label.toLowerCase()} (${items.length} of ${max})`}
        </button>
      ) : null}
      {items.some((item) => !item.trim()) ? <p className="text-xs text-ink-soft">Empty points are left out when you save.</p> : null}
    </div>
  );
}

/** A list of pairs: a part and a line about it, or a question and its answer. */
function PairEditor({
  base,
  first,
  second,
  items,
  max,
  onChange,
  addLabel,
  needsBoth = false,
}: {
  base: string;
  first: { label: string; max: number };
  second: { label: string; max: number; rows?: number };
  items: [string, string][];
  max: number;
  onChange: (items: [string, string][]) => void;
  addLabel: string;
  needsBoth?: boolean;
}) {
  const set = (i: number, k: 0 | 1, value: string) =>
    onChange(items.map((pair, j) => (j === i ? ((k === 0 ? [value, pair[1]] : [pair[0], value]) as [string, string]) : pair)));
  const incomplete = items.some(([a, b]) => (needsBoth ? !a.trim() || !b.trim() : !a.trim()));
  return (
    <div className="space-y-3">
      {items.map(([a, b], i) => (
        <div key={i} className="rounded-xl bg-paper p-3 ring-1 ring-line">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">{`${first.label} ${i + 1}`}</p>
            <button
              type="button"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
              aria-label={`Remove ${first.label.toLowerCase()} ${i + 1}`}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <label htmlFor={`${base}-a${i}`} className="sr-only">{`${first.label} ${i + 1}`}</label>
          <input id={`${base}-a${i}`} className="field mt-1" maxLength={first.max} value={a} placeholder={first.label} onChange={(e) => set(i, 0, e.target.value)} />
          <label htmlFor={`${base}-b${i}`} className="sr-only">{`${second.label}, ${first.label.toLowerCase()} ${i + 1}`}</label>
          <textarea
            id={`${base}-b${i}`}
            className="field mt-2"
            rows={second.rows ?? 2}
            maxLength={second.max}
            value={b}
            placeholder={second.label}
            onChange={(e) => set(i, 1, e.target.value)}
          />
        </div>
      ))}
      {items.length < max ? (
        <button type="button" onClick={() => onChange([...items, ["", ""]])} className="btn btn-ghost btn-sm">
          <Icon name="plus" size={15} />
          {`${addLabel} (${items.length} of ${max})`}
        </button>
      ) : null}
      {incomplete ? (
        <p className="text-xs text-ink-soft">{needsBoth ? "A question without an answer, or an answer without a question, is left out when you save." : "A part without a name is left out when you save."}</p>
      ) : null}
    </div>
  );
}

/** "1 time", "2 times", "1,200 checkouts". */
function times(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : `${word}s`}`;
}

/**
 * How the saved headline test is going, read from the counts (lib/headline-test.ts):
 * for a product sold for money, the sales and the money each version brought
 * per visitor, the chance one brings more, and how long it has left at the
 * traffic it has had; for a free one, the checkouts (sign-ups) each opened.
 * Shown only once a test is saved: a test being typed has nothing to show yet.
 */
function TestResults({ productId, running, what, sold }: { productId: string; running: boolean; what: "headline" | "page"; sold: boolean }) {
  const [failed,setFailed]=useState(false);
  const [refreshIndex,setRefreshIndex]=useState(0);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [currency, setCurrency] = useState("usd");
  const [declared, setDeclared] = useState<Measure | null>(null);
  const [shareB, setShareB] = useState(0.5);
  useEffect(() => {
    if (!running) return;
    let live = true;
    const controller = new AbortController();
    fetch(`/api/store/ab?id=${encodeURIComponent(productId)}`, { cache: "no-store", signal: controller.signal })
      .then((r) => {if(!r.ok)throw new Error("Test counts unavailable");return r.json();})
      .then((data: { ok?: boolean; counts?: Counts; currency?: string; declared?: Measure | null; shareB?: number }) => {
        if (live && data.ok && data.counts) {
          setFailed(false);
          setCounts(data.counts);
          if (data.currency) setCurrency(data.currency);
          setDeclared(data.declared === "money" || data.declared === "checkouts" ? data.declared : null);
          setShareB(typeof data.shareB==="number"?data.shareB:NaN);
        } else if(live)setFailed(true);
      })
      .catch(() => {if(live)setFailed(true);});
    return () => {
      live = false;
      controller.abort();
    };
  }, [productId, running, refreshIndex]);
  if (!running) return <p className="text-xs text-ink-soft">Save the page and the test starts with the next visitor.</p>;
  function refresh() {
    setCounts(null);
    setFailed(false);
    setRefreshIndex(index=>index+1);
  }
  const loading = !failed && counts === null;
  return (
    <div aria-busy={loading}>
      <TestResultsBody counts={counts} failed={failed} currency={currency} declared={declared} shareB={shareB} what={what} sold={sold}/>
      <button type="button" className="btn btn-ghost btn-sm mt-2 inline-flex min-h-11 items-center justify-center" disabled={loading} onClick={refresh}>
        {loading ? "Refreshing results…" : "Refresh results"}
      </button>
    </div>
  );
}

function TestResultsBody({counts,failed,currency,declared,shareB,what,sold}:{
  counts: Counts|null; failed: boolean; currency: string; declared: Measure|null; shareB: number;
  what: "headline"|"page"; sold: boolean;
}) {
  if (failed) return <TestCountsNotice retryInPlace/>;
  if (!counts) return <TestCountsNotice loading/>;
  const measure = sold ? "money" : "checkouts";
  const standing = testState(counts, measure, { declared, shareB });
  if(standing.state==="unavailable")return <TestCountsNotice retryInPlace/>;
  const won = standing.winner;
  const edge = Math.round(boundary(counts.va + counts.vb) * 100) / 100;
  const page = what === "page";
  const [a, b] = page ? ["Version A", "Version B"] : ["First headline", "Second headline"];
  const money = (cents: number) => formatMoney(Math.round(cents), currency);
  const line = (name: string, views: number, checkouts: number, sales: number, cents: number) =>
    sold
      ? `${name}: seen ${times(views, "time")}, ${times(sales, "sale")} paid, ${money(cents)} in gross payments, ${money(perVisitor(cents, views))} per visitor.`
      : `${name}: seen ${times(views, "time")}, ${times(checkouts, "sign-up")} (${rate(checkouts, views)}%).`;
  const chance = sold ? chanceBBetter(counts) : null;
  const days = won ? null : daysLeft(counts, measure);
  const enough = sold ? `${MIN_VIEWS} views and ${MIN_SALES} paid sales` : `${MIN_VIEWS} views, with ${MIN_EXPECTED_SIGNUPS * 2} sign-ups between them`;
  return (
    <div className="text-sm text-ink" data-test-results>
      {sold ? (
        <p className="mb-2 rounded-lg bg-paper p-3 text-xs text-ink-soft" data-experiment-payment-basis>
          Gross buyer payments are measured here, including any tax collected at checkout. Refunds, disputes and payment fees are not deducted. This is not net revenue or profit.
        </p>
      ) : null}
      <p>{line(a, counts.va, counts.ca, counts.sa ?? 0, counts.ra ?? 0)}</p>
      <p>{line(b, counts.vb, counts.cb, counts.sb ?? 0, counts.rb ?? 0)}</p>
      {chance !== null && !won ? (
        <p className="mt-1">
          {chance >= 0.5
            ? `${b === "Second headline" ? "The second headline" : "Version B"} has a ${Math.round(chance * 100)}% chance of bringing more gross payments per visitor.`
            : `${a === "First headline" ? "The first headline" : "Version A"} has a ${Math.round((1 - chance) * 100)}% chance of bringing more gross payments per visitor.`}
        </p>
      ) : null}
      <p className="mt-1 font-semibold">
        {won === "b"
          ? page
            ? "Version B wins. Your page now shows it to everybody. Keep version B and save to make it the page."
            : "The second headline wins. Your page now shows it to everybody. Make it the hero's own headline and switch the test off to keep it."
          : won === "a"
            ? page
              ? "Version A wins. Your page now shows it to everybody. Keep version A and save, or change version B and save to test again."
              : "The first headline wins. Your page now shows it to everybody. Switch the test off, or try another second headline."
            : standing.state === "measure_changed"
              ? `No winner can be called: this test was started on ${declared === "money" ? "gross payments per visitor" : "sign-ups"} and the product is now ${sold ? "sold for money" : "free"}. Change ${page ? "version B" : "the second headline"} and save to start a new test.`
              : standing.state === "split"
                ? `No winner while the split is off: the versions were seen ${times(counts.va, "time")} and ${times(counts.vb, "time")}, further from the share each should get than chance allows. Something may be counting one version more (a cached page, a link that always opens one); the test goes on counting.`
                : standing.state === "maturing"
                  ? `One version is ahead, but a test decided by gross payments waits until it has run ${REFUND_DAYS} days. This waiting period does not deduct refunds from either version.`
                  : `Still running: no clear winner yet. Each needs at least ${enough}, and a lead clear enough to hold however often the test is read (now ${edge} standard errors).`}
      </p>
      <p className="mt-1 text-xs text-ink-soft">
        {`The test is read on every visit, so the line a winner must cross is set to call a false winner no more than one time in twenty over the whole test, not at each look.${declared ? ` Decided by ${declared === "money" ? "gross payments per visitor" : "sign-ups"}, as when it was saved.` : ""}`}
      </p>
      {!won ? (
        <p className="mt-1 text-xs text-ink-soft">
          {days === null
            ? sold
              ? "How long it has left can be said once something has sold."
              : "How long it has left can be said after its first day."
            : days === 0
              ? "Both have what they need: it ends as soon as one is clearly ahead."
              : `At the traffic it has had, at least ${days === 1 ? "1 more day" : `${days} more days`} before a winner can be called${days > 60 ? ": your page may not get enough visitors for this test, and a bigger change between the versions shows sooner" : ""}.`}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-ink-soft">
        {`${sold ? "Sales are read from your own Stripe account a few minutes after they are paid, at what the buyer paid. " : ""}Visitors asked for consent before a cookie, as in the EU and UK, see ${page ? "version A" : "the first headline"} and are not counted.`}
      </p>
    </div>
  );
}

const PICTURE_PROBLEMS: Record<string, string> = {
  unreadable: "That picture could not be opened. Try a JPEG, PNG or WebP.",
  source: "That picture is over 30 MB. Pick a smaller one, or a screenshot of it.",
  too_big: "That picture is still over 1 MB after shrinking. Try a simpler one.",
  failed: "That picture could not be sent. Check your connection and try again.",
};

/** The long side a page's picture is shrunk to: sharp across the page's column on any screen. */
const PAGE_PICTURE_SIDE = 1400;

/**
 * The pictures of one block: chosen from the creator's device, shrunk in the
 * browser and sent straight to the store's own picture folder, exactly as a
 * product's picture is (components/product-image-editor.tsx). They join the
 * page when it is saved; a picture taken off a saved page is deleted then.
 */
function PicturesEditor({
  base,
  productId,
  pageId,
  folder,
  items,
  room,
  onChange,
}: {
  base: string;
  productId: string;
  /** On one of the store's own pages (lib/site-page-rules.ts): the picture is that page's. */
  pageId?: string;
  folder: string;
  items: Picture[];
  /** How many pictures this block may hold, given what the rest of the page holds. */
  room: number;
  onChange: (items: Picture[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const left = Math.max(0, room - items.length);
  // A picture described by the writing help (lib/ai.ts, describePicture), the one being described now.
  const ai = useContext(AiOn);
  const [describing, setDescribing] = useState<string | null>(null);
  async function describe(i: number) {
    const picture = items[i];
    if (!picture || describing) return;
    setDescribing(picture.path);
    setError(null);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pageId ? { kind: "alt", page: pageId, path: picture.path } : { kind: "alt", product: productId, path: picture.path }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: string; error?: string };
      if (data.ok && data.value) set(i, { alt: data.value });
      else setError(data.error === "used" ? "This month's writing help is used up. It starts again with your next billing month." : "That description did not come back. Write it yourself, or try again in a moment.");
    } catch {
      setError("That description did not come back. Write it yourself, or try again in a moment.");
    } finally {
      setDescribing(null);
    }
  }

  async function choose(files: FileList | null) {
    if (!files || busy) return;
    const chosen = [...files].slice(0, left);
    if (chosen.length === 0) return;
    setError(null);
    setBusy(chosen.length);
    const added: Picture[] = [];
    try {
      for (const file of chosen) {
        if (file.size > MAX_SOURCE_BYTES) {
          setError(PICTURE_PROBLEMS.source);
          continue;
        }
        let shrunk: Awaited<ReturnType<typeof shrink>>;
        try {
          shrunk = await shrink(file, PAGE_PICTURE_SIDE);
        } catch (thrown) {
          setError(thrown instanceof Error && thrown.message === "too_big" ? PICTURE_PROBLEMS.too_big : PICTURE_PROBLEMS.unreadable);
          continue;
        }
        const path = imagePath(folder, crypto.randomUUID().replace(/-/g, ""), shrunk.blob.type);
        try {
          await uploadPresigned(path, shrunk.blob, {
            access: "private",
            handleUploadUrl: "/api/store/image/upload",
            clientPayload: JSON.stringify(pageId ? { pageId } : { productId }),
            contentType: shrunk.blob.type,
          });
          added.push({ path, width: shrunk.width, height: shrunk.height, alt: "", caption: "" });
        } catch {
          setError(PICTURE_PROBLEMS.failed);
        }
        setBusy((n) => Math.max(0, n - 1));
      }
    } finally {
      if (added.length) onChange([...items, ...added]);
      setBusy(0);
      if (input.current) input.current.value = "";
    }
  }

  const set = (i: number, patch: Partial<Picture>) => onChange(items.map((picture, j) => (j === i ? { ...picture, ...patch } : picture)));
  const swap = (i: number, by: -1 | 1) => {
    const to = i + by;
    if (to < 0 || to >= items.length) return;
    const copy = [...items];
    [copy[i], copy[to]] = [copy[to], copy[i]];
    onChange(copy);
  };

  return (
    <div className="space-y-3">
      <input ref={input} type="file" accept={IMAGE_ACCEPT} multiple className="hidden" aria-hidden="true" tabIndex={-1} onChange={(event) => choose(event.target.files)} />
      {items.map((picture, i) => (
        <div key={picture.path} className="flex gap-3 rounded-xl bg-paper p-3 ring-1 ring-line">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl(picture)} alt="" width={picture.width} height={picture.height} className="h-20 w-20 shrink-0 rounded-lg object-cover ring-1 ring-line" />
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor={`${base}-pc${i}`} className="sr-only">{`A line under picture ${i + 1}`}</label>
            <input id={`${base}-pc${i}`} className="field" maxLength={MAX_PICTURE_CAPTION} value={picture.caption} placeholder="A line under it (optional)" onChange={(e) => set(i, { caption: e.target.value })} />
            <label htmlFor={`${base}-pa${i}`} className="sr-only">{`What picture ${i + 1} shows`}</label>
            <div className="flex gap-2">
              <input id={`${base}-pa${i}`} className="field min-w-0 flex-1" maxLength={MAX_ALT_LENGTH} value={picture.alt} placeholder="What it shows, for someone who cannot see it" onChange={(e) => set(i, { alt: e.target.value })} />
              {ai.on ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm shrink-0 ring-1 ring-line"
                  onClick={() => void describe(i)}
                  disabled={describing !== null || ai.left <= 0}
                  aria-busy={describing === picture.path}
                  aria-label={`Describe picture ${i + 1} with AI`}
                  title="Describe it with AI: one plain sentence of what it shows, in your store's language"
                >
                  <Icon name="sparkle" size={14} />
                  {describing === picture.path ? "Looking…" : "Describe"}
                </button>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-center">
            <button type="button" onClick={() => swap(i, -1)} disabled={i === 0} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-white hover:text-ink disabled:opacity-30" aria-label={`Move picture ${i + 1} earlier`}>
              <Icon name="chevron-down" size={16} className="rotate-180" />
            </button>
            <button type="button" onClick={() => swap(i, 1)} disabled={i === items.length - 1} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-white hover:text-ink disabled:opacity-30" aria-label={`Move picture ${i + 1} later`}>
              <Icon name="chevron-down" size={16} />
            </button>
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger" aria-label={`Remove picture ${i + 1}`}>
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      ))}
      {left > 0 ? (
        <button type="button" onClick={() => input.current?.click()} disabled={busy > 0} aria-busy={busy > 0} className="btn btn-secondary btn-sm">
          <Icon name="camera" size={15} />
          {busy > 0 ? `Sending ${busy} ${busy === 1 ? "picture" : "pictures"}…` : `Add pictures (${items.length} of ${room})`}
        </button>
      ) : (
        <p className="text-xs text-ink-soft">{`This block is full. A block holds ${MAX_PICTURES} pictures and a page ${MAX_PAGE_PICTURES}.`}</p>
      )}
      {error ? (
        <p className="text-xs font-semibold text-danger" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-xs text-ink-soft">Your own pictures: pages of the book, a screen of the course, the finished result. Each is shrunk before it is sent, shown once, and opens full size when a visitor presses it.</p>
      )}
    </div>
  );
}
