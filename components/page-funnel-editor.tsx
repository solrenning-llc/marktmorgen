"use client";

import { funnelLaunchChecklist } from "@/lib/funnel-launch-checklist";
import { FunnelNextCheck } from "@/components/funnel-next-check";
import { funnelNextCheck } from "@/lib/funnel-next-check";
import { useRef, useState } from "react";
import Link from "next/link";
import type { FunnelStepEditorLink } from "@/lib/funnel-editor-links";
import { FunnelSharingReview, type FunnelPaymentReview } from "@/components/funnel-sharing-review";
import { funnelLaunchIssues, type FunnelLaunchIssue } from "@/lib/funnel-launch-review";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { useLeaveGuard } from "@/components/leave-guard";
import { readFunnelMutationResult, type FunnelMutation } from "@/lib/funnel-mutation-response";
import { funnelReachRatioMetric, funnelStepMetrics } from "@/lib/funnel-metrics";
import { DIAGNOSIS_NOTE, funnelFindings } from "@/lib/funnel-diagnosis";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import {
  MAX_FUNNEL_NAME,
  MAX_FUNNEL_PAGES,
  MAX_FUNNEL_SLUG,
  MAX_PAGE_FUNNELS,
  type PageFunnel,
  type PageFunnelStep,
  funnelSlugFrom,
} from "@/lib/page-funnel";

/** A page or product that can be a step, as the studio lists it. */
export type StepChoice = { kind: PageFunnelStep["kind"]; id: string; title: string; note: string };

/** One saved funnel, with its steps as the store stands and how many people each reached. */
export type SavedFunnel = {
  funnel: PageFunnel;
  pageIssues?: FunnelLaunchIssue[];
  steps: { editor?: FunnelStepEditorLink | null; title: string; open: boolean; why: string; free: boolean; product: boolean; seen: number | null; done: number | null }[];
};

type Draft = { id: string; name: string; slug: string; slugTouched: boolean; on: boolean; steps: PageFunnelStep[] };

const MESSAGES: Record<string, string> = {
  name: "Give the funnel a name. Only you see it.",
  slug: "The address can have only lowercase letters, numbers and dashes.",
  taken: "Another funnel of this store already has that address.",
  steps: "A funnel needs at least one step, each page or product once.",
  full: `A store can have ${MAX_PAGE_FUNNELS} funnels. Remove one to add another.`,
  page: "One of the pages was deleted. Choose another.",
  gone: "One of the products was deleted. Choose another.",
  call: "A call is booked on a page of its own, so it cannot be a step.",
  unknown: "That funnel is already gone. Reload the page.",
  server_error: "We could not confirm the result. Reload and review your funnels before trying again.",
  ...STUDIO_MESSAGES,
};

const key = (step: Pick<PageFunnelStep, "kind" | "id">) => `${step.kind}:${step.id}`;

/**
 * The studio's funnels of pages (lib/page-funnel.ts): each with its address,
 * its steps in order with how many people reached each, and an editor that
 * picks the store's own pages and products' pages, in the order visitors
 * walk them.
 */
export function PageFunnelEditor({
  saved,
  choices,
  base,
  paymentReview,
  formsHref,
  ai,
}: {
  saved: SavedFunnel[];
  choices: StepChoice[];
  /** The funnels' addresses start with this: https://marktmorgen.com/@chef/go/ */
  base: string;
  paymentReview?: FunnelPaymentReview;
  formsHref?: string | null;
  /** AI writing for explaining each funnel check (26 [E9]): on only for a plan with it and a role that may edit pages. */
  ai?: { on: boolean; left: number | null };
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const flight = useRef(false);
  const recovery = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  const locked = busy || uncertain;
  useLeaveGuard(draft !== null || busy || uncertain);

  const pages = choices.filter((c) => c.kind === "page");
  const products = choices.filter((c) => c.kind === "product");
  const titleOf = (step: PageFunnelStep) => choices.find((c) => key(c) === key(step))?.title ?? "No longer available";

  function start(funnel: PageFunnel | null) {
    if (flight.current || recovery.current) return;
    setError(null);
    setDraft(
      funnel
        ? { id: funnel.id, name: funnel.name, slug: funnel.slug, slugTouched: true, on: funnel.on, steps: funnel.steps }
        : { id: "", name: "", slug: "", slugTouched: false, on: true, steps: choices.length ? [{ kind: choices[0].kind, id: choices[0].id }] : [] },
    );
  }

  function patch(change: Partial<Draft>) {
    if (flight.current || recovery.current) return;
    setDraft((d) => (d ? { ...d, ...change } : d));
  }

  function setStep(index: number, value: string) {
    if (flight.current || recovery.current) return;
    const [kind, ...rest] = value.split(":");
    if (kind !== "page" && kind !== "product") return;
    setDraft((d) => (d ? { ...d, steps: d.steps.map((s, i) => (i === index ? { kind, id: rest.join(":") } : s)) } : d));
  }

  function move(index: number, by: -1 | 1) {
    if (flight.current || recovery.current) return;
    setDraft((d) => {
      if (!d) return d;
      const to = index + by;
      if (to < 0 || to >= d.steps.length) return d;
      const steps = d.steps.slice();
      [steps[index], steps[to]] = [steps[to], steps[index]];
      return { ...d, steps };
    });
  }

  function addStep() {
    if (flight.current || recovery.current) return;
    setDraft((d) => {
      if (!d || d.steps.length >= MAX_FUNNEL_PAGES) return d;
      const used = new Set(d.steps.map(key));
      const pick = choices.find((c) => !used.has(key(c)));
      return pick ? { ...d, steps: [...d.steps, { kind: pick.kind, id: pick.id }] } : d;
    });
  }

  async function send(body: FunnelMutation, done: string) {
    if (flight.current || recovery.current) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/page-funnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data: unknown = await response.json().catch(() => null);
      const result = readFunnelMutationResult(response.status, data, body);
      if (result.state === "confirmed") {
        toast(done);
        setDraft(null);
        setRemoving(null);
        router.refresh();
        return;
      }
      if (result.state === "rejected") {
        setError(MESSAGES[result.error] ?? "This change was declined. Review the request and try again.");
      } else {
        recovery.current = true;
        setUncertain(true);
        setError(MESSAGES.server_error);
      }
    } catch {
      recovery.current = true;
      setUncertain(true);
      setError(MESSAGES.server_error);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  function save() {
    if (flight.current || recovery.current) return;
    if (!draft) return;
    const repeated = new Set(draft.steps.map(key)).size !== draft.steps.length;
    if (repeated) {
      setError("Each page or product can be one step of a funnel, once.");
      return;
    }
    send(
      { funnel: { id: draft.id || undefined, name: draft.name, slug: draft.slug, on: draft.on, steps: draft.steps } },
      draft.id ? "Funnel saved." : "Funnel made.",
    );
  }

  return (
    <section aria-labelledby="page-funnels-title" className="card min-w-0 p-5 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h2 id="page-funnels-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Pages in order
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            {`Your own pages and your products' pages, one after another, from one address. Each step leads to the next: a page's buttons, the page after a free sign-up, and the thank-you page after paying, once its offers are answered. Up to ${MAX_FUNNEL_PAGES} steps in a funnel and ${MAX_PAGE_FUNNELS} funnels in a store.`}
          </p>
        </div>
        {draft === null && saved.length < MAX_PAGE_FUNNELS ? (
          <button type="button" className="btn btn-primary" onClick={() => start(null)} disabled={locked || choices.length === 0}>
            <Icon name="plus" size={18} />
            New funnel
          </button>
        ) : null}
      </div>

      {choices.length === 0 ? (
        <p className="notice notice-warn mt-6 text-sm">
          A step is one of your pages or a product&apos;s page. Publish a product, or make a page under Pages, and it appears here.
        </p>
      ) : null}

      {saved.length === 0 && draft === null && choices.length > 0 ? (
        <p className="mt-6 rounded-2xl bg-paper p-4 text-sm text-ink-soft ring-1 ring-line">
          No funnels yet. A common one: a page that gives a guide for an email, a page with a video, then the sales page of what
          you sell.
        </p>
      ) : null}

      <ul className="mt-6 space-y-4">
        {saved.map(({ funnel, steps, pageIssues = [] }) => {
          const launchIssues = [...funnelLaunchIssues(funnel.on, steps, paymentReview?.available ?? null), ...pageIssues];
          const first = steps.find((s) => s.open)?.seen ?? null;
          const last = [...steps].reverse().find((s) => s.open);
          const findings = funnelFindings(steps);
          const checklist = funnelLaunchChecklist(funnel.name,funnel.on,steps,launchIssues);
          return (
            <li key={funnel.id} id={`funnel-review-${funnel.id}`} className="scroll-mt-24 rounded-2xl border border-line bg-white p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
                    {funnel.name}
                    <span className={`tag ${funnel.on ? "tag-live" : ""}`}>{funnel.on ? "On" : "Off"}</span>
                  </p>
                  <p className="mt-1 break-all text-sm text-ink-soft">{`${base}${funnel.slug}`}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(`${base}${funnel.slug}`);
                        toast("Address copied.");
                      } catch {
                        toast("Copy the address from above.");
                      }
                    }}
                  >
                    <Icon name="copy" size={16} />
                    Copy address
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => start(funnel)} disabled={locked || draft !== null}>
                    Edit
                  </button>
                  {removing === funnel.id ? (
                    <span className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                      Remove it?
                      <button type="button" className="btn btn-danger btn-sm" disabled={locked} onClick={() => send({ action: "remove", id: funnel.id }, "Funnel removed.")}>
                        Yes, remove
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={locked} onClick={() => setRemoving(null)}>
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(funnel.id)} disabled={locked || draft !== null}>
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <FunnelNextCheck check={funnelNextCheck(launchIssues,findings)} editors={steps.map(step=>step.editor)} paymentReview={paymentReview} formsHref={formsHref} locked={locked} settingsDisabled={locked||draft!==null} onSettings={()=>start(funnel)} onNavigate={event=>{if(flight.current||recovery.current)event.preventDefault();}}/>

              <details aria-label="Saved funnel launch checklist" className="mt-3 rounded-xl border border-line p-3 text-sm">
                <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-semibold text-ink">Launch checklist to copy</summary>
                <p className="mt-2 text-xs text-ink-soft">Includes saved funnel and step names and launch issues. Buyer records and performance totals are not added. Review before sharing.</p>
                <textarea readOnly rows={12} wrap="soft" className="field mt-3 w-full max-w-full resize-y" aria-label={`Launch checklist for ${funnel.name}`} value={checklist}/>
                <button type="button" className="btn btn-ghost btn-sm mt-2" disabled={locked} onClick={async event=>{
                  const field=event.currentTarget.parentElement?.querySelector("textarea");
                  try {
                    await navigator.clipboard.writeText(checklist);
                    toast("Launch checklist copied. Review it before sharing.");
                  } catch {
                    field?.focus();
                    field?.select();
                    toast("Select the checklist text and copy it.");
                  }
                }}>Copy checklist</button>
                <p className="mt-2 text-xs text-ink-soft">Clipboard unavailable? Select the checklist text and copy it.</p>
              </details>

              <FunnelSharingReview
                issues={launchIssues}
                editors={steps.map(step => step.editor)}
                paymentReview={paymentReview}
                formsHref={formsHref}
                locked={locked}
                settingsDisabled={locked || draft !== null}
                onSettings={() => start(funnel)}
                onNavigate={event => { if (flight.current || recovery.current) event.preventDefault(); }}
                explain={ai?.on ? { funnelId: funnel.id, left: ai.left } : null}
              />

              <ol className="mt-4 space-y-2">
                {steps.map((step, index) => (
                  <li key={`${funnel.id}-${index}`} className="flex items-start gap-3 rounded-[12px] bg-paper px-3 py-2.5 text-sm ring-1 ring-line">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-brand text-xs font-bold text-white">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-ink">
                        {step.title}
                        <span className="ml-2 font-normal text-ink-mute">{step.product ? (step.free ? "free product" : "product") : "page"}</span>
                      </p>
                      {step.open ? (
                        <p className="mt-0.5 text-ink-soft">
                          {funnelStepMetrics(step)}
                        </p>
                      ) : (
                        <p className="mt-0.5 font-semibold text-ink">{step.why}</p>
                      )}
                      {step.editor ? (
                        <Link
                          href={step.editor.href}
                          prefetch={false}
                          aria-label={`${step.editor.label}: ${step.title}`}
                          aria-disabled={locked}
                          tabIndex={locked ? -1 : undefined}
                          onClick={(event) => {
                            if (flight.current || recovery.current) event.preventDefault();
                          }}
                          className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-violet-deep underline underline-offset-4 aria-disabled:opacity-40"
                        >
                          {step.editor.label}
                        </Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-ink-mute">
                {funnelReachRatioMetric(first, last?.seen ?? null)}
                {`Approximate counts since ${new Date(funnel.since * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}, when its steps were last changed. Each visitor is counted at most once per step; you and your team are excluded. Visitors may enter at different steps.`}
              </p>
              {findings.length ? (
                <div className="mt-3 rounded-xl border border-line p-3 text-sm" aria-label={`What the counts of ${funnel.name} point to`}>
                  <p className="font-semibold text-ink">What the counts point to</p>
                  <ul className="mt-2 space-y-2">
                    {findings.map((finding, index) => {
                      const editor = finding.stepIndex === undefined ? null : steps[finding.stepIndex]?.editor ?? null;
                      return (
                        <li key={`${finding.code}-${index}`}>
                          <p className="font-semibold text-ink">{finding.title}</p>
                          <p className="text-ink-soft">{finding.detail}</p>
                          {editor ? (
                            <Link
                              href={editor.href}
                              prefetch={false}
                              aria-label={`${editor.label}: step ${(finding.stepIndex ?? 0) + 1}`}
                              aria-disabled={locked}
                              tabIndex={locked ? -1 : undefined}
                              onClick={(event) => {
                                if (flight.current || recovery.current) event.preventDefault();
                              }}
                              className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 font-semibold text-violet-deep underline underline-offset-4 aria-disabled:opacity-40"
                            >
                              {editor.label}
                            </Link>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-xs text-ink-mute">{DIAGNOSIS_NOTE}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {draft ? (
        <fieldset disabled={locked} className="mt-6 min-w-0 rounded-2xl border-2 border-violet-brand/40 bg-white p-4 sm:p-6">
          <p className="font-semibold text-ink">{draft.id ? "Edit the funnel" : "A new funnel"}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block" htmlFor="pf-name">
              <span className="field-label">Name, for you</span>
              <input
                id="pf-name"
                type="text"
                maxLength={MAX_FUNNEL_NAME}
                value={draft.name}
                placeholder="Launch of the course"
                onChange={(e) => patch({ name: e.target.value, ...(draft.slugTouched ? {} : { slug: funnelSlugFrom(e.target.value) }) })}
                className="field"
                required
              />
            </label>
            <label className="block" htmlFor="pf-slug">
              <span className="field-label">Address</span>
              <span className="flex items-center gap-1 text-sm text-ink-soft">
                <span className="shrink-0">…/go/</span>
                <input
                  id="pf-slug"
                  type="text"
                  maxLength={MAX_FUNNEL_SLUG}
                  value={draft.slug}
                  placeholder="launch"
                  onChange={(e) => patch({ slug: e.target.value.toLowerCase(), slugTouched: true })}
                  className="field"
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  aria-describedby="pf-slug-hint"
                  required
                />
              </span>
              <span id="pf-slug-hint" className="mt-1 block text-xs text-ink-mute">
                Lowercase letters, numbers and dashes.
              </span>
            </label>
          </div>

          <p className="field-label mt-5">Steps, in the order visitors walk them</p>
          <ol className="mt-2 space-y-2">
            {draft.steps.map((step, index) => (
              <li key={`${index}-${key(step)}`} className="flex items-center gap-2">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-violet-brand text-[0.8125rem] font-bold text-white">
                  {index + 1}
                </span>
                <label className="sr-only" htmlFor={`pf-step-${index}`}>{`Step ${index + 1}`}</label>
                <select id={`pf-step-${index}`} value={key(step)} onChange={(e) => setStep(index, e.target.value)} className="field min-w-0 flex-1">
                  {choices.some((c) => key(c) === key(step)) ? null : <option value={key(step)}>{titleOf(step)}</option>}
                  {pages.length ? (
                    <optgroup label="Your pages">
                      {pages.map((c) => (
                        <option key={key(c)} value={key(c)}>{`${c.title}${c.note ? ` (${c.note})` : ""}`}</option>
                      ))}
                    </optgroup>
                  ) : null}
                  {products.length ? (
                    <optgroup label="Products' pages">
                      {products.map((c) => (
                        <option key={key(c)} value={key(c)}>{`${c.title}${c.note ? ` (${c.note})` : ""}`}</option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper disabled:opacity-40"
                  aria-label={`Move step ${index + 1} up`}
                >
                  <Icon name="chevron-down" size={18} className="rotate-180" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === draft.steps.length - 1}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-paper disabled:opacity-40"
                  aria-label={`Move step ${index + 1} down`}
                >
                  <Icon name="chevron-down" size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => patch({ steps: draft.steps.filter((_, i) => i !== index) })}
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                  aria-label={`Remove step ${index + 1}`}
                >
                  <Icon name="trash" size={18} />
                </button>
              </li>
            ))}
          </ol>
          {draft.steps.length < MAX_FUNNEL_PAGES && draft.steps.length < choices.length ? (
            <button
              type="button"
              onClick={addStep}
              className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong text-sm font-bold text-ink-soft transition-colors hover:border-violet-brand hover:text-violet-deep"
            >
              <Icon name="plus" size={18} />
              {`Add a step (${draft.steps.length} of ${MAX_FUNNEL_PAGES})`}
            </button>
          ) : null}

          <label className="mt-5 flex min-h-11 items-center gap-3 text-sm font-semibold text-ink" htmlFor="pf-on">
            <input id="pf-on" type="checkbox" checked={draft.on} onChange={(e) => patch({ on: e.target.checked })} className="h-5 w-5" />
            On: its address leads through the steps
          </label>
          <p className="mt-1 text-xs text-ink-soft">
            Off, this funnel address is unavailable. Individual pages and products keep their own visibility.
          </p>

          <p className="mt-5 text-xs leading-relaxed text-ink-soft">
            A product step is its own page, with its price and checkout, and a paid one says “No thanks, continue” under the buy
            box. After paying, buyers get what they bought on the thank-you page and answer its offers first; then a button
            leads on. A step that cannot be shown right now, such as a page kept back or a product taken off, is passed over.
          </p>

          {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="button" onClick={save} aria-busy={busy} disabled={locked || !draft.name.trim() || draft.steps.length === 0} className="btn btn-primary">
              {busy ? "Saving…" : draft.id ? "Save the funnel" : "Make the funnel"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setDraft(null); setError(null); }} disabled={locked}>
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}

      {uncertain ? (
        <div className="notice notice-warn mt-4" role="status">
          <p>Your changes remain here. Reloading will discard this draft and show the saved funnels. Review them before trying again.</p>
          <button type="button" className="btn btn-ghost mt-3" onClick={() => window.location.reload()}>Reload and review</button>
        </div>
      ) : null}

      {error && !draft ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}
    </section>
  );
}
