"use client";

import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { FUNNEL_PAUSED } from "@/lib/import-limits";
import { DROPPED_WORDS, MAX_SAVED_PAGE_BYTES, MAX_TRIMMED_PAGE_CHARS, type PageDraft, trimSavedPage } from "@/lib/clickfunnels-page";
import { SaidLine, useSaid } from "@/components/said-line";
import { endWords, movedWords } from "@/lib/move-words";

/** A product of the store, as the funnel's choices need it (app/studio/import). */
export type FunnelProduct = { id: string; title: string; price: string; call: boolean; bumpable: boolean; hidden: boolean };

type Role = "page" | "checkout" | "upsell" | "downsell" | "skip";

type Chosen = { key: string; file: string; draft: PageDraft; role: Role; product: string; bumps: string[] };

type PlanAction =
  | { kind: "page"; file: string; title: string; slug: string; blocks: number; form: number; target: string; again: boolean }
  | { kind: "step"; position: number; title: string; what: "page" | "product" }
  | { kind: "bump"; file: string; owner: string; offered: string; price: string; pitch: string; again: boolean }
  | { kind: "offer"; file: string; owner: string; offered: string; price: string; headline: string; yes: string; no: string }
  | { kind: "funnel"; name: string; slug: string; steps: number };
type Plan = { actions: PlanAction[]; issues: { level: "error" | "warning"; file: string; text: string }[]; key: string; done: Saved | null };
type Saved = { funnel: { id: string; name: string; slug: string }; pages: string[]; bumps: number; offers: number };

const ROLE_WORDS: { value: Role; label: string; hint: string }[] = [
  { value: "page", label: "A page", hint: "One of your store's own pages, with this page's words. Kept from visitors until you let it out." },
  { value: "checkout", label: "A checkout (order form)", hint: "Your product's own page and checkout take this step's place. Its order bumps become boxes at that checkout." },
  { value: "upsell", label: "An offer after paying (upsell)", hint: "Offered in one click after the checkout before it, with this page's headline and first lines." },
  { value: "downsell", label: "An offer after a no (downsell)", hint: "Offered to whoever says no to the upsell just before it." },
  { value: "skip", label: "Leave it out", hint: "Nothing is made from this page." },
];

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  empty: "That file has nothing in it.",
  too_big: "That page is too large to read, even without its scripts and styles.",
  slow: "That was a lot in a short time. Wait a while and try again.",
  month: "Your store has used its figure for this for now (pages read, funnel checks or funnels made). More can be done when it opens again.",
  role: "Only the store's owner and Admins can make pages and funnels.",
  plan: "The funnel has problems to fix first: see the list below.",
  busy: "This funnel is being imported in another tab. Wait a moment and check again.",
  pages_changed: "Your store's pages changed while this was checked. Check the funnel again.",
  setup_incomplete: "The import stopped partway. Check the funnel again: anything already made is used again, not made twice.",
  unavailable: "Imports are not switched on yet.",
  try_again: "Nothing was made. Try again in a moment.",
  server_error: "Something went wrong on our side. Try again in a moment.",
  // 232 [CA1] unit 4b2: in place of the studio's words about uploads.
  renewal_unpaid: FUNNEL_PAUSED.renewal_unpaid,
  plan_disputed: FUNNEL_PAUSED.plan_disputed,
};

function summary(draft: PageDraft): string {
  const count = (kind: string) => draft.blocks.filter((b) => b.kind === kind).length;
  const parts: string[] = [];
  if (count("hero")) parts.push("a headline");
  if (count("text")) parts.push(`${count("text")} ${count("text") === 1 ? "section" : "sections"} of text`);
  if (count("video")) parts.push(`${count("video")} ${count("video") === 1 ? "video" : "videos"}`);
  if (count("cta")) parts.push(`${count("cta")} ${count("cta") === 1 ? "button" : "buttons"}`);
  if (draft.form) parts.push(`a form with ${draft.form.fields.length} ${draft.form.fields.length === 1 ? "question" : "questions"}`);
  if (draft.bumps.length) parts.push(`${draft.bumps.length} order ${draft.bumps.length === 1 ? "bump" : "bumps"}`);
  return parts.length ? `Read: ${parts.join(", ")}.` : "Nothing on it could be read as words, a video, a button or a form.";
}

/**
 * The funnel half of moving from ClickFunnels: the creator's own saved pages,
 * read on our side into blocks (app/api/store/import/funnel), each given its
 * role, then checked as a whole (the dry run) and made once.
 */
export function ClickFunnelsFunnel({ products, pagesLeft, funnelsHref, pagesHref }: { products: FunnelProduct[]; pagesLeft: number; funnelsHref: string; pagesHref: string }) {
  const [pages, setPages] = useState<Chosen[]>([]);
  // Each move said for screen readers; an end button says it is already there (WCAG 4.1.3, 2.4.3; lib/move-words.ts).
  const [said, say] = useSaid();
  const [name, setName] = useState("");
  const [reading, setReading] = useState("");
  const [plan, setPlan] = useState<{ plan: Plan; signature: string } | null>(null);
  const [saved, setSaved] = useState<{ saved: Saved; again: boolean; problems: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signature = JSON.stringify([name, pages.map((p) => [p.key, p.role, p.product, p.bumps])]);
  const planFresh = plan !== null && plan.signature === signature;
  const blocking = planFresh ? plan.plan.issues.filter((i) => i.level === "error") : [];

  async function post(payload: Record<string, unknown>) {
    const response = await fetch("/api/store/import/funnel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Record<string, unknown> & { ok?: boolean; error?: string };
  }

  async function choose(files: FileList | null) {
    setError(null);
    setSaved(null);
    if (!files?.length) return;
    const list = [...files].slice(0, 10 - pages.length);
    if (files.length > list.length) setError("One import reads up to 10 pages. The first ones chosen are read.");
    const added: Chosen[] = [];
    for (const file of list) {
      if (file.size > MAX_SAVED_PAGE_BYTES) {
        setError(`${file.name} is over 15 MB: save the page as "Webpage, HTML Only" and choose it again.`);
        continue;
      }
      setReading(file.name);
      try {
        const html = trimSavedPage(await file.text());
        if (html.length > MAX_TRIMMED_PAGE_CHARS) {
          setError(`${file.name} is too large to read, even without its scripts and styles.`);
          continue;
        }
        const data = await post({ action: "page", file: file.name, html });
        if (!data.ok || !data.draft) {
          setError(`${file.name}: ${MESSAGES[data.error ?? ""] ?? MESSAGES.server_error}`);
          continue;
        }
        const draft = data.draft as PageDraft;
        added.push({
          key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          file: file.name,
          draft,
          role: draft.checkout ? "checkout" : "page",
          product: "",
          bumps: draft.bumps.map(() => ""),
        });
      } catch {
        setError(`${file.name} could not be read.`);
      }
    }
    setReading("");
    setPages((current) => [...current, ...added]);
  }

  const change = (key: string, patch: Partial<Chosen>) => setPages((current) => current.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    const name = pages[index]?.file ?? "This page";
    if (to < 0 || to >= pages.length) {
      say(endWords(name, by < 0 ? "first" : "last"));
      return;
    }
    setPages((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(to, 0, item);
      return next;
    });
    say(movedWords(name, to, pages.length));
  };

  const body = () => ({
    name: name.trim() || "Funnel from ClickFunnels",
    pages: pages.map((p) => ({ file: p.file, role: p.role, product: p.product, bumps: p.bumps, draft: p.draft })),
  });

  async function check() {
    setError(null);
    setBusy(true);
    try {
      const data = await post({ action: "plan", ...body() });
      if (!data.ok || !data.plan) setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
      else setPlan({ plan: data.plan as Plan, signature });
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      const data = await post({ action: "save", ...body() });
      if (!data.ok || !data.saved) {
        setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
        if (data.plan) setPlan({ plan: data.plan as Plan, signature });
        return;
      }
      setSaved({ saved: data.saved as Saved, again: data.again === true, problems: Array.isArray(data.problems) ? (data.problems as string[]) : [] });
      toast(data.again === true ? "This funnel was already imported." : "Funnel imported, switched off until you are ready.");
    } catch {
      setError("We could not tell whether the funnel was made. Check the funnel again: anything already made is used again, not made twice.");
    } finally {
      setBusy(false);
    }
  }

  const choices = (role: Role) =>
    role === "checkout" ? products.filter((p) => !p.call) : role === "upsell" || role === "downsell" ? products.filter((p) => p.bumpable) : products;
  const bumpable = products.filter((p) => p.bumpable);

  return (
    <div className="space-y-5">
      <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-soft">
        <li>Open each published page of your funnel in your browser, at its own address, as a visitor sees it.</li>
        <li>
          Save it: <strong className="text-ink">File, then Save Page As</strong>, and choose <strong className="text-ink">Webpage, HTML Only</strong>.
        </li>
        <li>Choose the saved files here, in the funnel&apos;s order. You can change the order below.</li>
      </ol>
      <p className="text-xs text-ink-soft">
        {`Up to 10 pages per import; your store has room for ${pagesLeft} more of its own pages. We never sign in to ClickFunnels or fetch your pages: only the files you choose are read, and only their words, videos, buttons and forms are brought over. Nothing is saved until you import.`}
      </p>

      <div className="rounded-2xl border-2 border-dashed border-line-strong bg-white p-5 text-center">
        <Icon name="file" size={24} className="mx-auto text-violet-deep" />
        <label htmlFor="cf-pages" className="mt-2 block font-semibold text-ink">
          {reading ? `Reading ${reading}…` : pages.length ? "Add more saved pages" : "Choose your saved pages"}
        </label>
        <input
          id="cf-pages"
          type="file"
          multiple
          accept=".html,.htm,text/html"
          disabled={Boolean(reading) || pages.length >= 10}
          onChange={(e) => {
            void choose(e.target.files);
            e.target.value = "";
          }}
          className="mx-auto mt-3 block w-full max-w-xs text-sm file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-full file:border-0 file:bg-lilac file:px-4 file:font-bold file:text-violet-deep"
        />
      </div>

      {pages.length ? (
        <>
          <ol className="space-y-4" aria-label="Your funnel's pages, in order">
            {pages.map((page, index) => {
              const role = ROLE_WORDS.find((r) => r.value === page.role)!;
              const options = choices(page.role);
              return (
                <li key={page.key} className="rounded-2xl bg-white p-4 ring-1 ring-line">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-ink-mute">{`Step ${index + 1} · ${page.file}`}</p>
                      <p className="mt-0.5 font-semibold text-ink">{page.draft.title}</p>
                      <p className="mt-0.5 text-sm text-ink-soft">{summary(page.draft)}</p>
                    </div>
                    <div className="flex gap-1">
                      <button type="button" className="btn btn-ghost btn-sm aria-disabled:opacity-40" onClick={() => move(index, -1)} aria-disabled={index === 0 || undefined} aria-label={`Move ${page.file} up`}>
                        Up
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm aria-disabled:opacity-40" onClick={() => move(index, 1)} aria-disabled={index === pages.length - 1 || undefined} aria-label={`Move ${page.file} down`}>
                        Down
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPages((c) => c.filter((p) => p.key !== page.key))} aria-label={`Remove ${page.file}`}>
                        Remove
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <label className="block" htmlFor={`role-${page.key}`}>
                      <span className="field-label">What this page was</span>
                      <select id={`role-${page.key}`} className="field" value={page.role} onChange={(e) => change(page.key, { role: e.target.value as Role, product: "" })}>
                        {ROLE_WORDS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <span className="field-hint">{role.hint}</span>
                    </label>
                    {page.role !== "skip" ? (
                      <label className="block" htmlFor={`product-${page.key}`}>
                        <span className="field-label">
                          {page.role === "page" ? "Its buttons lead to (optional)" : page.role === "checkout" ? "The product it sells" : "The product it offers"}
                        </span>
                        <select id={`product-${page.key}`} className="field" value={page.product} onChange={(e) => change(page.key, { product: e.target.value })}>
                          <option value="">{page.role === "page" ? "The funnel's next step" : "Choose a product"}</option>
                          {options.map((p) => (
                            <option key={p.id} value={p.id}>
                              {`${p.title} (${p.price}${p.hidden ? ", draft" : ""})`}
                            </option>
                          ))}
                        </select>
                        {page.role !== "page" && options.length === 0 ? (
                          <span className="field-hint">No product of yours fits yet. Bring your products over first, or make one in the studio.</span>
                        ) : page.role === "upsell" || page.role === "downsell" ? (
                          <span className="field-hint">Offered at its own price here, never more. A product needs one price and something to hand over.</span>
                        ) : null}
                      </label>
                    ) : null}
                  </div>

                  {page.role === "checkout" && page.draft.bumps.length ? (
                    <fieldset className="mt-4 space-y-3">
                      <legend className="text-sm font-bold text-ink">Order bumps on this page</legend>
                      {page.draft.bumps.map((bump, b) => (
                        <label key={b} className="block" htmlFor={`bump-${page.key}-${b}`}>
                          <span className="field-label">{`“${bump.pitch}”`}</span>
                          <select
                            id={`bump-${page.key}-${b}`}
                            className="field"
                            value={page.bumps[b] ?? ""}
                            onChange={(e) => change(page.key, { bumps: page.bumps.map((x, i) => (i === b ? e.target.value : x)) })}
                          >
                            <option value="">Leave this bump out</option>
                            {bumpable.map((p) => (
                              <option key={p.id} value={p.id}>
                                {`Offer ${p.title} (${p.price}) at checkout`}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}

                  {page.draft.dropped.length ? (
                    <details className="mt-3 text-sm">
                      <summary className="flex min-h-11 cursor-pointer items-center gap-2 py-2 font-semibold text-ink">
                        <Icon name="chevron-down" size={15} />
                        {`Not brought over (${page.draft.dropped.reduce((n, d) => n + d.count, 0).toLocaleString("en-US")})`}
                      </summary>
                      <ul className="mt-1 space-y-2 text-ink-soft">
                        {page.draft.dropped.map((d) => (
                          <li key={d.what}>
                            <span className="font-semibold text-ink">{`${d.count.toLocaleString("en-US")} × `}</span>
                            {DROPPED_WORDS[d.what]}
                            {d.examples.length ? <span className="block text-xs text-ink-mute">{d.examples.join(" · ")}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {page.draft.blocks.length ? (
                    <details className="mt-1 text-sm">
                      <summary className="flex min-h-11 cursor-pointer items-center gap-2 py-2 font-semibold text-ink">
                        <Icon name="chevron-down" size={15} />
                        What comes across
                      </summary>
                      <ul className="mt-1 space-y-1.5 text-ink-soft">
                        {page.draft.blocks.map((block) => (
                          <li key={block.id} className="truncate">
                            {block.kind === "hero"
                              ? `Headline: ${block.headline}`
                              : block.kind === "text"
                                ? `Text: ${block.heading || block.body.slice(0, 120)}`
                                : block.kind === "video"
                                  ? "Video"
                                  : block.kind === "cta"
                                    ? `Button: ${block.label}`
                                    : block.kind === "form"
                                      ? `Form: ${page.draft.form?.fields.map((f) => f.label).join(", ") ?? ""}`
                                      : block.kind}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <SaidLine said={said} />

          <label className="block max-w-md" htmlFor="cf-funnel-name">
            <span className="field-label">The funnel&apos;s name</span>
            <input id="cf-funnel-name" className="field" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Funnel from ClickFunnels" />
            <span className="field-hint">Seen in your studio only. Its address is made from it.</span>
          </label>

          {planFresh ? <PlanReport plan={plan.plan} /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={check} disabled={busy || Boolean(reading)} aria-busy={busy && !planFresh} className={planFresh ? "btn btn-ghost" : "btn btn-primary"}>
              {planFresh ? "Check the funnel again" : "Check the funnel first (nothing is saved)"}
            </button>
            {planFresh && blocking.length === 0 && !plan.plan.done ? (
              <button type="button" onClick={save} disabled={busy} aria-busy={busy} className="btn btn-primary">
                {busy ? "Importing…" : "Import the funnel"}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {saved || (planFresh && plan.plan.done) ? (
        <div className="notice notice-info text-sm" role="status">
          <p className="font-semibold text-ink">
            {saved && !saved.again ? `Made: ${saved.saved.funnel.name}, switched off.` : `Already imported: ${(saved?.saved ?? plan!.plan.done!).funnel.name}. Nothing was made twice.`}
          </p>
          <p className="mt-1">
            Its pages are kept from visitors until you let them out. Check each page, add your pictures, then switch the funnel on.
          </p>
          {saved?.problems.length ? (
            <ul className="mt-2 list-disc pl-5">
              {saved.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 flex flex-wrap gap-4">
            <Link href={funnelsHref} className="inline-flex min-h-11 items-center font-bold text-violet-deep underline underline-offset-4">
              Open your funnels
            </Link>
            <Link href={pagesHref} className="inline-flex min-h-11 items-center font-bold text-violet-deep underline underline-offset-4">
              Open your pages
            </Link>
          </p>
        </div>
      ) : null}

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The dry run of the whole funnel: what will be made, how each page maps, and what has to change first. */
function PlanReport({ plan }: { plan: Plan }) {
  const errors = plan.issues.filter((i) => i.level === "error");
  const warnings = plan.issues.filter((i) => i.level === "warning");
  return (
    <section className="rounded-2xl bg-white p-4 ring-1 ring-line" aria-labelledby="cf-plan" aria-live="polite">
      <h3 id="cf-plan" className="text-sm font-bold text-ink">
        Dry run: what importing makes
      </h3>
      <p className="mt-1 text-xs text-ink-soft">Checked against your store as it is now. Nothing was saved.</p>
      {errors.length ? (
        <div className="mt-3">
          <p className="text-sm font-bold text-danger">To fix before importing</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
            {errors.map((i, n) => (
              <li key={n}>{i.file ? `${i.file}: ${i.text}` : i.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <ul className="mt-3 space-y-1.5 text-sm text-ink">
        {plan.actions.map((a, n) => (
          <li key={n}>
            {a.kind === "page"
              ? `${a.again ? "Used again" : "New page"}: ${a.title}, at /${a.slug}, ${a.blocks} ${a.blocks === 1 ? "block" : "blocks"}${a.form ? `, a form with ${a.form} ${a.form === 1 ? "question" : "questions"}` : ""}${a.target ? `, its buttons leading to ${a.target}` : ""}. Kept from visitors.`
              : a.kind === "step"
                ? `Step ${a.position}: ${a.what === "page" ? "the page" : "the product's own page and checkout"} ${a.title}`
                : a.kind === "bump"
                  ? `${a.again ? "Already there" : "Box at checkout"}: ${a.offered} for ${a.price} at ${a.owner}'s checkout, “${a.pitch}”`
                  : a.kind === "offer"
                    ? `Offer after paying for ${a.owner}: ${a.offered} for ${a.price}. Yes leads to ${a.yes}, no to ${a.no}.`
                    : `The funnel ${a.name}, ${a.steps} ${a.steps === 1 ? "step" : "steps"}, at /go/${a.slug}, switched off until you switch it on.`}
          </li>
        ))}
      </ul>
      {warnings.length ? (
        <div className="mt-3">
          <p className="text-sm font-bold text-ink">Good to know</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {warnings.map((i, n) => (
              <li key={n}>{i.file ? `${i.file}: ${i.text}` : i.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
