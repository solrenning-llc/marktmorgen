"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/components/use-hydrated";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { parseSections, parseAnnouncement, type Announcement, MAX_ANNOUNCEMENT, MAX_SECTIONS, MAX_SECTION_TITLE, type StoreSection } from "@/lib/store-sections";

const FAILED = "We could not confirm these settings. Reload this page to check before trying again.";
const GONE = "One of those products is no longer in your store. Reload the page and try again.";

async function post(url: string, body: unknown, matches: (data: Record<string, unknown>) => boolean): Promise<string | null> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const raw: unknown = await response.json().catch(() => null);
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    return response.ok && data?.ok === true && !data.error && matches(data) ? null : data?.ok !== true && data?.error === "unknown" ? GONE : FAILED;
  } catch {
    return FAILED;
  }
}

/**
 * Two things about how the store page is laid out (lib/store-sections.ts):
 * headings that cut a long list of products into sections, and one line of
 * the creator's own news across the top. Each is saved on its own.
 */
export function StoreLayoutEditor({
  sections,
  announcement,
  products,
}: {
  sections: StoreSection[];
  announcement: Announcement | null;
  /** The store's published products, in its own order, to start a section at or to link the news to. */
  products: { id: string; title: string }[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const fieldId = useId();
  const [savedRows, setSavedRows] = useState(sections);
  const [savedNews, setSavedNews] = useState(announcement);
  const [rows, setRows] = useState<StoreSection[]>(sections);
  const [text, setText] = useState(announcement?.text ?? "");
  const [link, setLink] = useState(announcement?.product ?? "");
  const [busy, setBusy] = useState<"sections" | "news" | null>(null);
  const [error, setError] = useState<{ on: "sections" | "news"; text: string } | null>(null);

  const unavailable = !hydrated || busy !== null;
  const order = new Map(products.map((product, index) => [product.id, index]));
  const taken = new Set(rows.map((row) => row.at));
  const free = products.filter((product) => !taken.has(product.id));
  const sectionsChanged = JSON.stringify(rows) !== JSON.stringify(savedRows);
  const incomplete = rows.some((row) => !row.title.trim() || !row.at);
  const newsChanged = text.trim() !== (savedNews?.text ?? "") || link !== (savedNews?.product ?? "");

  async function save(what: "sections" | "news") {
    if (unavailable) return;
    setBusy(what);
    setError(null);
    const expectedSections = parseSections([...rows].sort((a, b) => (order.get(a.at) ?? 0) - (order.get(b.at) ?? 0)));
    const expectedNews = parseAnnouncement({ text: text.trim(), product: link || null });
    const problem = what === "sections"
      ? await post("/api/store/sections", { sections: [...rows].sort((a, b) => (order.get(a.at) ?? 0) - (order.get(b.at) ?? 0)) }, data => Array.isArray(data.savedSections) && data.sections === expectedSections.length && JSON.stringify(parseSections(data.savedSections)) === JSON.stringify(expectedSections) && data.savedSections.length === expectedSections.length)
      : await post("/api/store/announcement", { text: text.trim(), product: link || null }, data => Object.prototype.hasOwnProperty.call(data, "announcement") && data.on === (expectedNews !== null) && (expectedNews === null ? data.announcement === null : JSON.stringify(parseAnnouncement(data.announcement)) === JSON.stringify(expectedNews)));
    setBusy(null);
    if (problem) {
      setError({ on: what, text: problem });
      return;
    }
    if (what === "sections") { setSavedRows(expectedSections); setRows(expectedSections); }
    else { setSavedNews(expectedNews); setText(expectedNews?.text ?? ""); setLink(expectedNews?.product ?? ""); }
    toast(what === "sections" ? "Section settings saved." : "News settings saved.");
    router.refresh();
  }

  return (
    <div data-layout-editor data-layout-ready={hydrated} aria-busy={unavailable} className="card p-6 sm:p-8">
      <h2 className="text-lg font-semibold tracking-[-0.02em] text-ink">Sections and news on your store</h2>
      <p className="mt-2 text-ink-soft">
        Cut a long store into sections with a heading over each, and put one line of your own news across the top.
      </p>

      <div className="mt-6">
        <p className="font-semibold text-ink">Sections</p>
        <p className="mt-1 text-sm text-ink-soft">
          A section starts at the product you pick and runs down to the next heading. Move that product in your list and its heading moves with it. A heading with nothing published under it is not shown.
        </p>
        {products.length < 2 ? (
          <p className="mt-3 text-sm text-ink-soft">Publish two products or more and you can put headings between them.</p>
        ) : (
          <>
            <ul className="mt-3 space-y-3">
              {rows.map((row, index) => (
                <li key={index} className="flex flex-wrap items-end gap-3 rounded-2xl bg-paper p-3 ring-1 ring-line">
                  <label className="min-w-[12rem] flex-1">
                    <span className="field-label">{`Heading ${index + 1}`}</span>
                    <input disabled={unavailable}
                      className="field mt-1"
                      maxLength={MAX_SECTION_TITLE}
                      value={row.title}
                      placeholder="For example: Courses"
                      onChange={(event) => {
                        const title = event.currentTarget.value;
                        setRows((all) => all.map((r, i) => (i === index ? { ...r, title } : r)));
                      }}
                    />
                  </label>
                  <label className="min-w-[12rem] flex-1">
                    <span id={`${fieldId}-start-label-${index}`} className="field-label">Starts at</span>
                    <select aria-labelledby={`${fieldId}-start-label-${index}`} disabled={unavailable} className="field mt-1" value={row.at} onChange={(event) => {
                      const at = event.currentTarget.value;
                      setRows((all) => all.map((r, i) => (i === index ? { ...r, at } : r)));
                    }}>
                      {row.at && !order.has(row.at) ? <option value={row.at}>A product that is no longer published</option> : null}
                      {products
                        .filter((product) => product.id === row.at || !taken.has(product.id))
                        .map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                    aria-label={`Remove heading ${index + 1}`}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {rows.length < MAX_SECTIONS && free.length > 0 ? (
                <button type="button" disabled={unavailable} className="btn btn-secondary btn-sm" onClick={() => setRows((all) => [...all, { title: "", at: free[0].id }])}>
                  <Icon name="plus" size={15} />
                  {`Add a section (${rows.length} of ${MAX_SECTIONS})`}
                </button>
              ) : null}
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void save("sections")} disabled={unavailable || !sectionsChanged || incomplete} aria-busy={busy === "sections"}>
                {busy === "sections" ? "Saving…" : "Save sections"}
              </button>
              {incomplete ? <span className="text-xs text-ink-soft">Give every section a heading.</span> : null}
            </div>
          </>
        )}
        {error?.on === "sections" ? (
          <p className="notice notice-error mt-3" role="alert">
            {error.text}
          </p>
        ) : null}
      </div>

      <div className="mt-8 border-t border-line pt-6">
        <p className="font-semibold text-ink">A line of news across the top</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your own words, shown above everything on your store page: something new, a date, where to start. It can lead to one of your products. Leave it empty for none.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-[2]">
            <span className="flex items-baseline justify-between gap-3">
              <span className="field-label">What it says</span>
              <span className="text-xs tabular-nums text-ink-mute">{`${text.length}/${MAX_ANNOUNCEMENT}`}</span>
            </span>
            <input disabled={unavailable} className="field mt-1" maxLength={MAX_ANNOUNCEMENT} value={text} placeholder="New: the spring meal plan is out" onChange={(event) => setText(event.target.value)} />
          </label>
          <label className="min-w-[12rem] flex-1">
            <span className="field-label">Leads to</span>
            <select disabled={unavailable} className="field mt-1" value={link} onChange={(event) => setLink(event.target.value)}>
              <option value="">Nowhere</option>
              {link && !order.has(link) ? <option value={link}>A product that is no longer published</option> : null}
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" onClick={() => void save("news")} disabled={unavailable || !newsChanged} aria-busy={busy === "news"}>
            {busy === "news" ? "Saving…" : "Save"}
          </button>
        </div>
        {error?.on === "news" ? (
          <p className="notice notice-error mt-3" role="alert">
            {error.text}
          </p>
        ) : null}
      </div>
    </div>
  );
}
