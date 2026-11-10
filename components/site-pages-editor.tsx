"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { MAX_SITE_PAGES, MAX_SITE_TITLE, MAX_SLUG, SITE_STARTERS, type SitePage, slugFrom } from "@/lib/site-page-rules";
import { pageFileName } from "@/lib/site-page-file";

const MESSAGES: Record<string, string> = {
  too_many: `A store has up to ${MAX_SITE_PAGES} pages of its own. Remove one first.`,
  title: "Give the page a title.",
  slug: "An address is lowercase letters and numbers, with a dash between words.",
  reserved: "That address is already a part of every store. Choose another.",
  taken: "Another of your pages has that address.",
  unknown: "That is not there anymore. Reload the page.",
  forbidden: "Your role on this store does not include its pages.",
  page_unread: "This page could not be read just now, so no copy was made. Try again in a moment.",
  copy_conflict: "Your pages changed while the copy was being made, so none was made. Reload the page and try again.",
  copy_failed: "The page could not be saved just now. Reload to check your pages before trying again.",
  copy_full: "Your store has no room left for this page's blocks, so none was added. Remove something you no longer need first.",
  file: "That file is not a page from Marktmorgen, or it was changed so its blocks cannot be kept as they are. Nothing was added.",
  too_big: "That page is bigger than a page may be. Nothing was added.",
  kind: "That file holds a kind of block a store's own page cannot have. Nothing was added.",
  forms_unread: "Your forms could not be read just now, so the page was not brought in. Try again in a moment.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = { ok?: boolean; error?: string; pages?: SitePage[]; id?: string; pictures?: number; file?: unknown; left?: { pictures: number; refs: number; reviewPicks: number } };

async function call(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/site-page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/**
 * The list of a store's own pages (lib/site-page-rules.ts): each one to open,
 * a new one blank or from a starter, and, for the one open, its title,
 * address, place in the menu, where its buttons lead, its order and its
 * removal. Its blocks are edited below it, in the page editor.
 */
export function SitePagesList({ pages, selected, sid }: { pages: SitePage[]; selected: string | null; sid: string | null }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hrefFor = (id: string) => `/studio/site?${sid ? `store=${sid}&` : ""}page=${id}`;
  const open = (id: string) => router.push(hrefFor(id));

  async function add(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const a = await call({ action: "add", ...payload });
    setBusy(false);
    if (!a.ok || !a.id) return setError(MESSAGES[a.error ?? ""] ?? MESSAGES.server_error);
    setTitle("");
    toast("Page added. Fill in its blocks and press Save.");
    open(a.id);
    router.refresh();
  }

  /** 582 [KB3]: a page from a file "Download as a file" made, here or in another store; then it is opened. */
  async function bring(chosen: File | undefined) {
    if (!chosen) return;
    setError(null);
    // Read only a file that could be a page at all, then measured as the route receives it: compact.
    if (chosen.size > MAX_PAGE_FILE_BYTES * 4) return setError(MESSAGES.too_big);
    let file: unknown;
    try {
      file = JSON.parse(await chosen.text());
    } catch {
      return setError(MESSAGES.file);
    }
    if (new TextEncoder().encode(JSON.stringify({ action: "import", file })).length > MAX_PAGE_FILE_BYTES) return setError(MESSAGES.too_big);
    setBusy(true);
    const a = await call({ action: "import", file });
    setBusy(false);
    if (!a.ok || !a.id) return setError(MESSAGES[a.error ?? ""] ?? MESSAGES.server_error);
    toast(importDoneWords(a.left ?? { pictures: 0, refs: 0, reviewPicks: 0 }));
    open(a.id);
    router.refresh();
  }

  const missing = SITE_STARTERS.filter((s) => !pages.some((p) => p.slug === s.slug));
  return (
    <nav aria-label="Your pages" className="card min-w-0 p-3 lg:sticky lg:top-24">
      <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">Your pages</p>
      {pages.length ? (
        <ul className="space-y-1">
          {pages.map((page) => (
            <li key={page.id}>
              <Link
                href={hrefFor(page.id)}
                aria-current={page.id === selected ? "page" : undefined}
                className={`flex min-h-[44px] items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-sm transition-colors ${
                  page.id === selected ? "bg-lilac text-violet-ink" : "text-ink-soft hover:bg-paper hover:text-ink"
                }`}
              >
                <span className="min-w-0 truncate font-semibold">{page.title}</span>
                <span className="shrink-0 text-xs text-ink-mute">{`/${page.slug}`}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 text-sm text-ink-soft">None yet.</p>
      )}
      {pages.length < MAX_SITE_PAGES ? (
        <div className="mt-3 border-t border-line px-1 pt-3">
          {missing.length ? (
            <>
              <p className="px-2 text-xs font-semibold text-ink-soft">Start one</p>
              <div className="mt-2 flex flex-wrap gap-2 px-1">
                {missing.map((starter) => (
                  <button key={starter.slug} type="button" title={starter.hint} disabled={busy} className="btn btn-secondary btn-sm" onClick={() => void add({ starter: starter.slug })}>
                    {starter.title}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <label className="mt-3 block px-1 text-xs font-semibold text-ink-soft">
            <span className="block">Or bring in a page from a file</span>
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              aria-describedby="site-page-file-help"
              className="mt-1 block min-h-11 w-full text-sm text-ink"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = "";
                void bring(chosen);
              }}
            />
            <span id="site-page-file-help" className="mt-1 block font-normal">{IMPORT_HELP}</span>
          </label>
          <form
            className="mt-3 flex gap-2 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) void add({ title });
            }}
          >
            <label htmlFor="new-page-title" className="sr-only">A new page&apos;s title</label>
            <input id="new-page-title" className="field min-w-0 flex-1" maxLength={MAX_SITE_TITLE} placeholder="Or a page of your own" value={title} onChange={(e) => setTitle(e.target.value)} />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !title.trim()} aria-busy={busy}>
              Add
            </button>
          </form>
        </div>
      ) : null}
      {error ? (
        <p className="notice notice-error mt-3 text-sm" role="alert">{error}</p>
      ) : null}
    </nav>
  );
}

/** The most a page's file may weigh: the route's own body (app/api/store/site-page/route.ts, MAX_BODY_BYTES). */
export const MAX_PAGE_FILE_BYTES = 200_000;

/** What "Download as a file" keeps, said before it is pressed (582 [KB3]). */
export const EXPORT_HELP = "Download as a file: this page's title and blocks, as last saved, to keep or to bring into another of your stores. Pictures are not in the file.";

/** What a file brings, said beside the file box (582 [KB3]). */
export const IMPORT_HELP = "A page you downloaded from a store here. It comes in hidden from visitors and out of the menu. Pictures, and the products and forms this store does not have, are left out.";
// The file names the page's products and forms by their ids, never resolved in another store; no buyer, order or address is in it.

/** What is said once a page is downloaded. */
export function exportDoneWords(pictures: number): string {
  return pictures ? `Page downloaded. Its ${pictures === 1 ? "picture is" : `${pictures} pictures are`} not in the file.` : "Page downloaded.";
}

/** What is said once a page is brought in, with what was left out counted. */
export function importDoneWords(left: { pictures: number; refs: number; reviewPicks: number }): string {
  const out = [
    left.pictures ? `${left.pictures === 1 ? "a picture" : `${left.pictures} pictures`}` : "",
    left.refs ? `${left.refs === 1 ? "a product, form or call" : `${left.refs} products, forms or calls`} this store does not have` : "",
    left.reviewPicks ? "the reviews picked to show first" : "",
  ].filter(Boolean);
  return out.length ? `Page brought in and opened, hidden from visitors. Left out: ${out.join(", ")}.` : "Page brought in and opened, hidden from visitors.";
}

/** What "Make a copy" makes, said before it is pressed (582 [KB3]). */
export const COPY_HELP = "Make a copy: the same blocks and words, as last saved, on a new page, hidden from visitors and out of the menu until you show it. Pictures stay with this page, so add them again in the copy.";

/** What is said once the copy is made, with the pictures left out counted. */
export function copyDoneWords(pictures: number): string {
  return pictures
    ? `Copy made and opened, hidden from visitors. Its ${pictures === 1 ? "picture" : `${pictures} pictures`} stayed with the original: add ${pictures === 1 ? "it" : "them"} again here.`
    : "Copy made and opened, hidden from visitors.";
}

/** The settings of the page that is open: title, address, menu, where its buttons lead, order, removal. */
export function SitePageSettings({
  page,
  pages,
  products,
  base,
  sid,
}: {
  page: SitePage;
  pages: SitePage[];
  products: { id: string; title: string }[];
  /** The store's own address, to show the page's: "https://marktmorgen.com/@chef". */
  base: string;
  sid: string | null;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [nav, setNav] = useState(page.nav);
  const [target, setTarget] = useState(page.target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const at = pages.findIndex((p) => p.id === page.id);
  const dirty = title !== page.title || slug !== page.slug || nav !== page.nav || target !== page.target;

  async function run(payload: Record<string, unknown>, done: string, after?: () => void) {
    setBusy(true);
    setError(null);
    const a = await call(payload);
    setBusy(false);
    if (!a.ok) return setError(MESSAGES[a.error ?? ""] ?? MESSAGES.server_error);
    toast(done);
    after?.();
    router.refresh();
  }

  /** 582 [KB3]: this page as a file on the creator's computer, as last saved. */
  async function download() {
    setBusy(true);
    setError(null);
    const a = await call({ action: "export", id: page.id });
    setBusy(false);
    if (!a.ok || !a.file) return setError(MESSAGES[a.error ?? ""] ?? MESSAGES.server_error);
    const url = URL.createObjectURL(new Blob([JSON.stringify(a.file, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = pageFileName(page);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast(exportDoneWords(typeof a.pictures === "number" ? a.pictures : 0));
  }

  /** 582 [KB3]: a copy of this page, kept back; then the copy is opened, its address in the list. */
  async function copy() {
    setBusy(true);
    setError(null);
    const a = await call({ action: "copy", id: page.id });
    setBusy(false);
    if (!a.ok || !a.id) return setError(MESSAGES[a.error ?? ""] ?? MESSAGES.server_error);
    toast(copyDoneWords(typeof a.pictures === "number" ? a.pictures : 0));
    router.push(`/studio/site?${sid ? `store=${sid}&` : ""}page=${a.id}`);
    router.refresh();
  }

  const move = (by: -1 | 1) => {
    const ids = pages.map((p) => p.id);
    const to = at + by;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    void run({ action: "order", ids }, "Order saved.");
  };

  return (
    <section aria-labelledby="site-page-settings" className="card mb-6 p-5 sm:p-6" data-site-page-settings>
      <h2 id="site-page-settings" className="text-lg font-semibold tracking-[-0.02em] text-ink">Page settings</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Title</span>
          <input className="field mt-1" maxLength={MAX_SITE_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="field-label">Address</span>
          <span className="mt-1 flex items-center gap-1">
            <span className="shrink-0 text-sm text-ink-mute">/</span>
            <input className="field" maxLength={MAX_SLUG} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, MAX_SLUG))} onBlur={() => setSlug(slugFrom(slug) || page.slug)} />
          </span>
          <span className="mt-1 block break-all text-xs text-ink-soft">{`${base}/${slug}`}</span>
        </label>
        <label className="block">
          <span className="field-label">Its buttons lead to</span>
          <select className="field mt-1" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Your store</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
        </label>
        <label className="flex items-start gap-3 self-end text-sm text-ink">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={nav} onChange={(e) => setNav(e.target.checked)} />
          <span>In the menu at the top of your store and its pages</span>
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy || !dirty}
          aria-busy={busy}
          onClick={() => void run({ action: "meta", id: page.id, title, slug, nav, target }, "Page settings saved.")}
        >
          Save settings
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || at <= 0} onClick={() => move(-1)} aria-label="Move this page up in the menu">
          Move up
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || at >= pages.length - 1} onClick={() => move(1)} aria-label="Move this page down in the menu">
          Move down
        </button>
        {pages.length < MAX_SITE_PAGES ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || dirty} aria-busy={busy} aria-describedby="site-page-copy-help" onClick={() => void copy()}>
            Make a copy
          </button>
        ) : null}
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy} aria-busy={busy} aria-describedby="site-page-export-help" onClick={() => void download()}>
          Download as a file
        </button>
        {confirm ? (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-ink">Remove this page and its blocks?</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void run({ action: "remove", id: page.id }, "Page removed.", () => router.push(`/studio/site${sid ? `?store=${sid}` : ""}`))}
            >
              Remove
            </button>
            <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4" onClick={() => setConfirm(false)}>
              Keep it
            </button>
          </span>
        ) : (
          <button type="button" className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-danger" onClick={() => setConfirm(true)}>
            Remove this page
          </button>
        )}
      </div>
      <p id="site-page-export-help" className="mt-3 text-xs text-ink-soft">{EXPORT_HELP}</p>
      <p id="site-page-copy-help" className="mt-1 text-xs text-ink-soft">
        {pages.length < MAX_SITE_PAGES
          ? dirty
            ? "Save these settings first to make a copy."
            : COPY_HELP
          : `A store has up to ${MAX_SITE_PAGES} pages of its own, so there is no room for a copy. Remove one first.`}
      </p>
      {error ? (
        <p className="notice notice-error mt-3 text-sm" role="alert">{error}</p>
      ) : null}
    </section>
  );
}
