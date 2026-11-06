"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { useLeaveGuard } from "@/components/leave-guard";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { FUNNEL_TYPES, type FunnelType, choicesOf, pagesOf, slotProblem } from "@/lib/funnel-types";
import { FunnelFormSetup } from "@/components/funnel-form-setup";
import { readFunnelFormDrafts, type FunnelFormDraft } from "@/lib/funnel-form-draft";
import { MAX_FUNNEL_INTRO, type FunnelPageCopy } from "@/lib/funnel-page-copy";
import { MAX_HEADLINE } from "@/lib/sales-page";
import { readFunnelSetupResult } from "@/lib/funnel-setup-response";
import { MAX_FUNNEL_NAME } from "@/lib/page-funnel";
import { FunnelAiDraftPanel, followUpFits } from "@/components/funnel-ai-draft";
import { type FunnelAiDraft, type FunnelBlockCopy, placeholdersIn } from "@/lib/funnel-ai-rules";
import { MAX_DRAFTED_BODY, MAX_DRAFTED_SUBJECT } from "@/lib/sequence-draft";
import { readMailSaveError, sequenceFlowFrom } from "@/lib/funnel-ai-sequence";

/** A product a type can be built with, as the studio knows it. */
export type TypeProduct = { id: string; title: string; free: boolean; call: boolean; draft: boolean };

const MESSAGES: Record<string, string> = {
  type: "That kind of funnel is not offered any more. Reload the page.",
  forbidden: "Your role cannot make the store's pages, which this funnel needs. Ask the store's owner or an admin.",
  full: "This store already has as many funnels as it can. Remove one to add another.",
  pages_changed: "The store’s pages changed while this draft was being prepared. Review Pages, then reload before creating the funnel.",
  pages_full: "This funnel makes pages of its own, and the store has no room for them. Remove a page under Pages first.",
  slot_missing: "Choose a product for every step.",
  slot_free: "That step needs a free product: the one they sign up for.",
  slot_paid: "That step needs a paid product.",
  slot_call: "Choose one of your calls for the booking, and no call for the other steps.",
  slot_twice: "Each product can fill one step.",
  form_draft: "Complete each form question and check its email subscription setting before creating the funnel.",
  form_sensitive: "A form question asks for a password, a card number, a card's security code or an identity number, which a form never may. Change or remove it, then create the funnel. Nothing was made.",
  page_copy: "Check the page titles and introductions, then try again.",
  forms_full: "This store has no room for the required forms. Review Forms before trying again.",
  setup_incomplete: "We could not confirm completion. Some pages, forms or a funnel may already exist. Review them before creating another funnel.",
  server_error: "Something went wrong before setup started. Try again.",
  ...STUDIO_MESSAGES,
};

/**
 * Funnels to start from (lib/funnel-types.ts): pick a kind, choose the
 * store's own products for its steps, and the funnel is made with the pages
 * it needs, with optional starting copy and kept from visitors until ready.
 */
export function FunnelTypePicker({ products, pagesLeft, canMakePages, funnelsLeft, sid, ai = { on: false, left: 0 }, sequences = { canSave: false, note: "" } }: {
  products: TypeProduct[];
  /** How many more pages the store can have. */
  pagesLeft: number;
  /** Whether this person may make the store's pages. */
  canMakePages: boolean;
  funnelsLeft: number;
  sid: string;
  /** Whether writing with AI is on for this person, and the month's uses left (lib/ai.ts). */
  ai?: { on: boolean; left: number };
  /** Whether a drafted follow-up can be saved as a switched-off sequence, and why not. */
  sequences?: { canSave: boolean; note: string };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FunnelType | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [formDrafts, setFormDrafts] = useState<Record<string, FunnelFormDraft>>({});
  const [pageCopy, setPageCopy] = useState<Record<string, FunnelPageCopy>>({});
  const [reviewing, setReviewing] = useState(false);
  const requestActive = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<"setup" | "forms" | null>(null);
  const [made, setMade] = useState<{ pages: { title: string; id: string }[]; funnelId: string | null; drafts: string[]; sequence: "saved" | string | null } | null>(null);
  // What an AI draft added beyond the setup's own fields (components/funnel-ai-draft.tsx).
  const [blockCopy, setBlockCopy] = useState<Record<string, FunnelBlockCopy>>({});
  const [aiDraft, setAiDraft] = useState<Pick<FunnelAiDraft, "offers" | "sequence" | "missing" | "diagnostics"> | null>(null);
  const [saveSequence, setSaveSequence] = useState(false);
  useLeaveGuard(type !== null);
  const formDraftsValid = !type || readFunnelFormDrafts(formDrafts, type) !== null;
  const slots = type ? choicesOf(type) : [];
  const selected = slots.map(slot => picked[slot.key] || "").filter(Boolean);
  const repeated = new Set(selected).size !== selected.length;
  const draftSelections = slots.flatMap(slot => {
    const product = products.find(product => product.id === picked[slot.key]);
    return product?.draft ? [slot.label + ": " + product.title] : [];
  });
  const selectionIssues = slots.flatMap(slot => {
    const problem = slotProblem(slot, products.find(product => product.id === picked[slot.key]) ?? null);
    return problem ? [slot.label + ": " + MESSAGES["slot_" + problem]] : [];
  });
  const pagePlaceholders = placeholdersIn(JSON.stringify([pageCopy, blockCopy])).length;
  const sequencePlaceholders = aiDraft?.sequence ? placeholdersIn(JSON.stringify(aiDraft.sequence.steps)).length : 0;
  const sequenceBlocked = saveSequence && (sequencePlaceholders > 0 || !aiDraft?.sequence?.steps.every(step => step.subject.trim() && step.body.trim()));
  const capacityIssue = type && (funnelsLeft <= 0 ? MESSAGES.full : pagesOf(type).length > pagesLeft ? MESSAGES.pages_full : pagesOf(type).length > 0 && !canMakePages ? MESSAGES.forbidden : null);

  function choose(next: FunnelType) {
    setMade(null);
    setReviewing(false);
    setRecovery(null);
    setBlockCopy({});
    setAiDraft(null);
    setSaveSequence(false);
    setType(next);
    setName(next.label);
    setFormDrafts(Object.fromEntries(pagesOf(next).filter(page => page.form && page.blocks.includes("form")).map(page => [page.key, { fields: page.form!.fields.map(field => ({ ...field })), offerList: false }])));
    setPageCopy(Object.fromEntries(pagesOf(next).map(page => [page.key, { headline: page.title, intro: "" }])));
    setError(null);
    // The first product that fits each step, each product once.
    const used = new Set<string>();
    const start: Record<string, string> = {};
    const publishedFirst = products.slice().sort((a, b) => Number(a.draft) - Number(b.draft));
    for (const slot of choicesOf(next)) {
      const first = publishedFirst.find((p) => slotProblem(slot, p) === null && !used.has(p.id));
      if (first) {
        start[slot.key] = first.id;
        used.add(first.id);
      }
    }
    setPicked(start);
  }

  /** An AI draft fills the setup's own fields; the creator changes them before anything is created. */
  function applyDraft(draft: FunnelAiDraft) {
    if (!type || draft.type !== type.id) return;
    setPageCopy(current => ({ ...current, ...draft.pageCopy }));
    setFormDrafts(current => ({ ...current, ...draft.formDrafts }));
    setBlockCopy(draft.blockCopy);
    setAiDraft({ offers: draft.offers, sequence: draft.sequence, missing: draft.missing, diagnostics: draft.diagnostics });
    setSaveSequence(false);
  }

  async function build() {
    if (!type || !reviewing || !formDraftsValid || sequenceBlocked || requestActive.current || busy || recovery === "setup" || !name.trim() || selectionIssues.length > 0 || repeated || capacityIssue) return;
    requestActive.current = true;
    setBusy(true);
    setRecovery(null);
    setError(null);
    try {
      const response = await fetch("/api/store/page-funnels", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-nimbus-store": sid },
        body: JSON.stringify({ action: "from-type", type: type.id, name, products: picked, pageCopy, formDrafts, blockCopy }),
      });
      const data: unknown = await response.json().catch(() => null);
      const result = response.ok ? readFunnelSetupResult(data, pagesOf(type).length) : null;
      if (result) {
        toast("Funnel draft created.");
        // The drafted follow-up, saved switched off through the Email Studio's own route, only when asked for.
        let sequence: "saved" | string | null = null;
        const flow = saveSequence && aiDraft?.sequence ? sequenceFlowFrom(aiDraft.sequence, name, data) : null;
        if (saveSequence && aiDraft?.sequence) {
          sequence = "The follow-up emails could not be saved: the new form could not be confirmed. Write the sequence in the Email Studio.";
          if (flow) {
            try {
              const saved = await fetch("/api/store/mail", { method: "POST", headers: { "Content-Type": "application/json", "x-nimbus-store": sid }, body: JSON.stringify({ action: "flow", flow }) });
              sequence = readMailSaveError(saved.ok, await saved.json().catch(() => null));
            } catch {
              sequence = readMailSaveError(false, null);
            }
          }
        }
        setMade({ ...result, drafts: draftSelections, sequence });
        setType(null);
        router.refresh();
        return;
      }
      const rawError = data && typeof data === "object" && "error" in data ? data.error : null;
      const errorCode = data && typeof data === "object" && "ok" in data && data.ok === false && typeof rawError === "string" && Object.hasOwn(MESSAGES, rawError) ? rawError : null;
      const uncertain = errorCode === "setup_incomplete" || !errorCode;
      setRecovery(uncertain ? "setup" : errorCode === "forms_full" ? "forms" : null);
      setError(uncertain ? MESSAGES.setup_incomplete : MESSAGES[errorCode!]);
    } catch {
      setRecovery("setup");
      setError(MESSAGES.setup_incomplete);
    } finally {
      requestActive.current = false;
      setBusy(false);
    }
  }

  const reviewHref = `/studio/funnels${sid ? `?store=${encodeURIComponent(sid)}` : ""}${made?.funnelId ? `#funnel-review-${encodeURIComponent(made.funnelId)}` : ""}`;
  const productsHref = `/studio${sid ? `?store=${encodeURIComponent(sid)}` : ""}#products`;
  const pagesHref = (id: string) => `/studio/site?${sid ? `store=${encodeURIComponent(sid)}&` : ""}page=${encodeURIComponent(id)}`;

  return (
    <section aria-labelledby="funnel-types-title" className="card min-w-0 p-5 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h2 id="funnel-types-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
            Start from a kind of funnel
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Pick one, choose your products for its steps, and the funnel is made with the pages it needs. Add starting copy during review. New pages stay hidden and the funnel stays disabled until you prepare and enable them.
          </p>
        </div>
        {!open ? (
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)} disabled={funnelsLeft <= 0}>
            <Icon name="plus" size={18} />
            Choose a kind
          </button>
        ) : null}
      </div>

      {made ? (
        <div className="notice notice-success mt-6" role="status">
          <p className="font-semibold text-ink">Funnel draft created. Its address is disabled.</p>
          {made.pages.length ? (
            <>
              <p className="mt-1 text-sm text-ink-soft">Finish these page drafts, then make them visible when ready:</p>
              <ul className="mt-2 space-y-1 text-sm">
                {made.pages.map((page) => (
                  <li key={page.id}>
                    <a className="underline underline-offset-4" href={pagesHref(page.id)}>
                      {page.title}
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {made.drafts.length ? <div className="mt-4 text-sm"><p className="font-semibold">Products that were drafts at setup:</p><ul className="mt-2 list-disc space-y-1 pl-5">{made.drafts.map(draft => <li key={draft}>{draft}</li>)}</ul><p className="mt-2">Review their current status and publish them before sharing the funnel.</p><a className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4" href={productsHref}>Review products</a></div> : null}
          {made.sequence === "saved" ? <p className="mt-4 text-sm">The follow-up emails were saved as a switched-off sequence in the Email Studio. Review them and switch the sequence on there when the funnel is ready. <a className="font-semibold underline underline-offset-4" href={`/studio/email${sid ? `?store=${encodeURIComponent(sid)}` : ""}`}>Open the Email Studio</a></p> : made.sequence ? <p className="notice notice-warn mt-4 text-sm" role="status">{made.sequence}</p> : null}
          <p className="mt-4 text-sm text-ink-soft">Prepare the pages and products, review its settings, and test the customer journey. Enable the funnel in its settings only when it is ready.</p>
          <a className="btn btn-secondary mt-4" href={reviewHref}>{made.funnelId ? "Review funnel settings" : "Review funnels"}</a>
        </div>
      ) : null}

      {open && !type ? (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FUNNEL_TYPES.map((kind) => {
            const pages = pagesOf(kind).length;
            const tooMany = pages > pagesLeft;
            const blocked = pages > 0 && !canMakePages;
            return (
              <li key={kind.id} className="flex flex-col rounded-2xl border border-line bg-white p-4">
                <p className="font-semibold text-ink">{kind.label}</p>
                <p className="mt-1 flex-1 text-sm text-ink-soft">{kind.hint}</p>
                <ol className="mt-3 space-y-1 text-xs text-ink-soft">
                  {kind.slots
                    .filter((slot) => slot.kind !== "target")
                    .map((slot, i) => (
                      <li key={slot.key}>{`${i + 1}. ${slot.kind === "page" ? `Page: ${slot.title}` : slot.label}`}</li>
                    ))}
                </ol>
                {tooMany ? <p className="mt-3 text-xs text-ink-soft">{`Needs room for ${pages} more ${pages === 1 ? "page" : "pages"} under Pages.`}</p> : null}
                {blocked ? <p className="mt-3 text-xs text-ink-soft">Needs a role that can make the store&apos;s pages.</p> : null}
                <button type="button" className="btn btn-primary btn-sm mt-4 self-start" onClick={() => choose(kind)} disabled={tooMany || blocked}>
                  Use this
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {type ? (
        <fieldset disabled={busy} className="mt-6 min-w-0 rounded-2xl border border-line bg-white p-4 sm:p-6">
          <legend className="sr-only">Funnel setup</legend>
          <p className="text-xs font-semibold text-ink-soft">{reviewing ? "Step 3 of 3 · Review" : "Step 2 of 3 · Products"}</p>
          <p className="mt-1 font-semibold text-ink">{type.label}</p>
          <div hidden={reviewing}>
          <label className="mt-4 block">
            <span className="field-label">Name, for you</span>
            <input className="field mt-2" value={name} maxLength={MAX_FUNNEL_NAME} onChange={(e) => setName(e.target.value)} />
          </label>
          {choicesOf(type).map((slot) => {
            const fitting = products.filter((p) => slotProblem(slot, p) === null);
            return (
              <label key={slot.key} className="mt-4 block">
                <span className="field-label">{slot.label}</span>
                {fitting.length ? (
                  <select
                    className="field mt-2"
                    value={picked[slot.key] ?? ""}
                    onChange={(e) => {
                      setPicked((p) => ({ ...p, [slot.key]: e.target.value }));
                      // Offers and emails drafted for other products no longer fit: draft again.
                      setAiDraft(null);
                      setSaveSequence(false);
                    }}
                  >
                    <option value="">Choose…</option>
                    {fitting.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.draft ? `${p.title} (draft)` : p.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="mt-2 block text-sm text-ink-soft">
                    {slot.wants === "free"
                      ? "You have no free product yet. Add one under Products, then come back."
                      : slot.wants === "call"
                        ? "You have no call yet. Add one under Products, then come back."
                        : "You have no paid product yet. Add one under Products, then come back."}
                    <a className="mt-2 inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4" href={productsHref}>Review products</a>
                  </span>
                )}
              </label>
            );
          })}
          {pagesOf(type).length ? (
            <p className="mt-4 text-sm text-ink-soft">
              {`It makes ${pagesOf(type).length} ${pagesOf(type).length === 1 ? "page" : "pages"} of your own (${pagesOf(type)
                .map((p) => p.title)
                .join(", ")}), hidden from visitors while you prepare them. Add starting copy in the next step. A draft product is passed over until you publish it.`}
            </p>
          ) : null}
          {draftSelections.length > 0 ? <div className="notice notice-warn mt-4 text-sm" role="status"><p className="font-semibold">Some selected products are still drafts.</p><ul className="mt-2 list-disc space-y-1 pl-5">{draftSelections.map(selection => <li key={selection}>{selection}</li>)}</ul><p className="mt-2">You can create this setup, but publish these products and review the funnel before sharing it.</p><a className="mt-2 inline-flex min-h-11 items-center font-semibold underline underline-offset-4" href={productsHref}>Review products</a></div> : null}
          {selectionIssues.length > 0 || repeated || capacityIssue ? <div className="notice notice-warn mt-4 text-sm" role="status"><p className="font-semibold">Complete the setup before creating the funnel.</p><ul className="mt-2 list-disc space-y-1 pl-5">{selectionIssues.map(issue => <li key={issue}>{issue}</li>)}{repeated ? <li>{MESSAGES.slot_twice}</li> : null}{capacityIssue ? <li>{capacityIssue}</li> : null}</ul></div> : null}
          </div>
          {reviewing ? (
            <section aria-label="Review your funnel" className="mt-4">
              <h3 className="font-semibold text-ink">{name.trim()}</h3>
              <FunnelAiDraftPanel type={type} picked={picked} sid={sid} ai={ai} emailsPossible={followUpFits(type, picked)} onDraft={applyDraft} />
              <p className="mt-4 text-sm text-ink-soft">Your customer journey, in order:</p>
              <ol className="mt-3 space-y-3">
                {type.slots.filter(slot => slot.kind !== "target").map((slot, index) => {
                  const product = products.find(item => item.id === picked[slot.key]);
                  return <li key={slot.key} className="rounded-xl border border-line p-3">
                    <p className="text-sm font-semibold">{index + 1}. {slot.kind === "page" ? slot.title : product?.title}</p>
                    <p className="mt-1 text-xs text-ink-soft">{slot.kind === "page"
                      ? `New hidden page · ${slot.blocks.join(", ")}${slot.form ? " · includes a new form" : ""}`
                      : product?.draft ? "Existing product · draft; publish it before sharing" : "Existing product · keep its current settings"}</p>
                    {slot.kind === "page" ? <div className="mt-4 space-y-3">
                      <label className="block">
                        <span className="field-label">Page headline</span>
                        <input className="field mt-2" maxLength={MAX_HEADLINE} value={pageCopy[slot.key]?.headline ?? slot.title} onChange={event => setPageCopy(current => ({ ...current, [slot.key]: { headline: event.target.value, intro: current[slot.key]?.intro ?? "" } }))} />
                      </label>
                      <label className="block">
                        <span className="field-label">Introduction (optional)</span>
                        <textarea className="field mt-2" rows={3} maxLength={MAX_FUNNEL_INTRO} value={pageCopy[slot.key]?.intro ?? ""} onChange={event => setPageCopy(current => ({ ...current, [slot.key]: { headline: current[slot.key]?.headline ?? slot.title, intro: event.target.value } }))} placeholder="Describe what visitors will find on this page. Use facts you can support." />
                      </label>
                      <p className="text-xs text-ink-soft">{pageCopy[slot.key]?.intro.length ?? 0}/{MAX_FUNNEL_INTRO} characters. Saved as editable page text. Add videos, answers and other details in the page editor.</p>
                      {blockCopy[slot.key] ? <DraftedBlocks copy={blockCopy[slot.key]} onDiscard={() => setBlockCopy(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== slot.key)))} /> : null}
                      {slot.form && formDrafts[slot.key] ? <FunnelFormSetup value={formDrafts[slot.key]} onChange={next => setFormDrafts(current => ({ ...current, [slot.key]: next }))} /> : null}
                    </div> : null}
                  </li>;
                })}
              </ol>
              {aiDraft ? <DraftExtras draft={aiDraft} products={products} sid={sid} placeholders={pagePlaceholders} sequences={sequences} saveSequence={saveSequence} onSaveSequence={setSaveSequence} onSteps={steps => setAiDraft(current => current && current.sequence ? { ...current, sequence: { ...current.sequence, steps } } : current)} /> : null}
              <p className="notice notice-warn mt-4 text-sm">This creates a disabled funnel and hidden, unfinished pages. Existing products keep their current visibility. Review page copy, forms, delivery and checkout before enabling the funnel. No email is sent and no post-purchase offer is created by this setup; drafted follow-up emails are saved only if you check the box, as a switched-off sequence.</p>
              <p className="mt-3 text-sm text-ink-soft">{pagesOf(type).length} new pages · {pagesOf(type).filter(page => page.form && page.blocks.includes("form")).length} new forms · 1 new funnel</p>
            </section>
          ) : null}
          {reviewing && !formDraftsValid ? <p className="notice notice-warn mt-4 text-sm" role="status">{MESSAGES.form_draft}</p> : null}
          {error ? (
            <p className="notice notice-error mt-4" role="alert">
              {error}
            </p>
          ) : null}
          {recovery ? <nav aria-label="Review setup records" className="mt-4 flex flex-wrap gap-3">
            {recovery === "setup" ? <a className="underline" href={`/studio/site${sid ? `?store=${encodeURIComponent(sid)}` : ""}`}>Review pages</a> : null}
            <a className="underline" href={`/studio/forms${sid ? `?store=${encodeURIComponent(sid)}` : ""}`}>Review forms</a>
            {recovery === "setup" ? <a className="underline" href={`/studio/funnels${sid ? `?store=${encodeURIComponent(sid)}` : ""}`}>Review funnels</a> : null}
          </nav> : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary" onClick={() => reviewing ? void build() : setReviewing(true)} disabled={busy || (reviewing && (!formDraftsValid || sequenceBlocked)) || recovery === "setup" || !name.trim() || selectionIssues.length > 0 || repeated || Boolean(capacityIssue)} aria-busy={busy}>
              {busy ? "Creating draft…" : reviewing ? "Create disabled funnel" : "Review funnel"}
            </button>
            {reviewing && !recovery ? <button type="button" className="btn btn-secondary" onClick={() => setReviewing(false)} disabled={busy}>Back to products</button> : null}
            <button type="button" className="btn btn-secondary" onClick={() => setType(null)} disabled={busy}>
              {recovery === "setup" ? "Close setup" : "Cancel setup"}
            </button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

const BLOCK_NAMES: Record<keyof FunnelBlockCopy, string> = { sub: "line under the headline", text: "text", steps: "steps", fit: "who it is for", faq: "questions", cta: "button" };

/** What an AI draft wrote for a page's other blocks: shown to read, discarded with one press, edited in the page editor once created. */
function DraftedBlocks({ copy, onDiscard }: { copy: FunnelBlockCopy; onDiscard: () => void }) {
  const names = (Object.keys(copy) as (keyof FunnelBlockCopy)[]).map(key => BLOCK_NAMES[key]);
  return <details className="rounded-xl border border-line p-3 text-sm">
    <summary className="cursor-pointer font-semibold">Also drafted for this page: {names.join(", ")}</summary>
    <div className="mt-2 space-y-2 text-ink-soft">
      {copy.sub ? <p>{copy.sub}</p> : null}
      {copy.text ? <p className="whitespace-pre-line"><span className="font-semibold text-ink">{copy.text.heading}</span>{copy.text.heading ? " " : ""}{copy.text.body}</p> : null}
      {copy.steps ? <ol className="list-decimal space-y-1 pl-5">{copy.steps.items.map((item, i) => <li key={i}><span className="text-ink">{item.title}</span>{item.detail ? ` — ${item.detail}` : ""}</li>)}</ol> : null}
      {copy.fit ? <p>For: {copy.fit.yes.join("; ")}{copy.fit.no.length ? `. Not for: ${copy.fit.no.join("; ")}` : ""}</p> : null}
      {copy.faq ? <ul className="space-y-1">{copy.faq.map((item, i) => <li key={i}><span className="text-ink">{item.q}</span> {item.a}</li>)}</ul> : null}
      {copy.cta ? <p>Button: {copy.cta}</p> : null}
      <p className="text-xs">Saved into the hidden page&apos;s blocks, where you can change every word in the page editor.</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onDiscard}>Leave these blocks empty</button>
    </div>
  </details>;
}

/** The rest of an AI draft: what to add, what the store's records say, offers to set up yourself, and the follow-up emails. */
function DraftExtras({ draft, products, sid, placeholders, sequences, saveSequence, onSaveSequence, onSteps }: {
  draft: Pick<FunnelAiDraft, "offers" | "sequence" | "missing" | "diagnostics">;
  products: TypeProduct[];
  sid: string;
  placeholders: number;
  sequences: { canSave: boolean; note: string };
  saveSequence: boolean;
  onSaveSequence: (on: boolean) => void;
  onSteps: (steps: NonNullable<FunnelAiDraft["sequence"]>["steps"]) => void;
}) {
  const title = (id: string) => products.find(product => product.id === id)?.title ?? "A product";
  const store = sid ? `store=${encodeURIComponent(sid)}` : "";
  const steps = draft.sequence?.steps ?? [];
  const left = placeholdersIn(JSON.stringify(steps)).length;
  return <div className="mt-4 space-y-4">
    {placeholders > 0 ? <p className="notice notice-warn text-sm" role="status">{`${placeholders} ${placeholders === 1 ? "part is" : "parts are"} marked ⟦like this⟧ for you to write. The pages are created hidden, and a page holding one cannot be shown to visitors until you replace it in the page editor.`}</p> : null}
    {draft.missing.length ? <div className="rounded-xl border border-line p-3 text-sm"><p className="font-semibold">To add before you enable it</p><ul className="mt-2 list-disc space-y-1 pl-5">{draft.missing.map((item, i) => <li key={i}>{item}</li>)}</ul></div> : null}
    {draft.diagnostics.length ? <div className="rounded-xl border border-line p-3 text-sm"><p className="font-semibold">What your store&apos;s records show</p><ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">{draft.diagnostics.map((item, i) => <li key={i}>{item.text}</li>)}</ul></div> : null}
    {draft.offers.length ? <div className="rounded-xl border border-line p-3 text-sm">
      <p className="font-semibold">Offers you could add</p>
      <p className="mt-1 text-xs text-ink-soft">Suggestions only, from your own products. Nothing is set up or priced for you.</p>
      <ul className="mt-2 space-y-2">{draft.offers.map((offer, i) => <li key={i}>
        <span className="text-ink">{offer.kind === "bump" ? `At checkout for “${title(offer.for)}”: a box to add “${title(offer.offer)}”.` : `Right after paying for “${title(offer.for)}”: offer “${title(offer.offer)}”.`}</span>
        {offer.why ? <span className="text-ink-soft"> {offer.why}</span> : null}{" "}
        <a className="font-semibold underline underline-offset-4" href={offer.kind === "bump" ? `/studio${store ? `?${store}` : ""}#products` : `/studio/funnels?${store ? `${store}&` : ""}product=${encodeURIComponent(offer.for)}`}>{offer.kind === "bump" ? "Set up in the product" : "Set up offers after paying"}</a>
      </li>)}</ul>
    </div> : null}
    {draft.sequence ? <div className="rounded-xl border border-line p-3 text-sm">
      <p className="font-semibold">Follow-up emails</p>
      <p className="mt-1 text-xs text-ink-soft">{draft.sequence.trigger === "form" ? "Sent to people who send the funnel's form with their email and are on your list." : `Sent to people who get “${title(draft.sequence.productId ?? "")}”.`} An unsubscribe line is added to every email.</p>
      <ol className="mt-3 space-y-3">{steps.map((step, i) => <li key={i} className="rounded-lg border border-line p-3">
        <p className="text-xs text-ink-soft">{`Email ${i + 1} · ${i === 0 ? (step.delayHours === 0 ? "right away" : "after 1 day") : `${Math.round(step.delayHours / 24)} ${Math.round(step.delayHours / 24) === 1 ? "day" : "days"} after the one before`}`}</p>
        <label className="mt-2 block"><span className="field-label">Subject of email {i + 1}</span><input className="field mt-2" maxLength={MAX_DRAFTED_SUBJECT} value={step.subject} onChange={event => onSteps(steps.map((s, at) => at === i ? { ...s, subject: event.target.value } : s))} /></label>
        <label className="mt-2 block"><span className="field-label">Body of email {i + 1}</span><textarea className="field mt-2" rows={6} maxLength={MAX_DRAFTED_BODY} value={step.body} onChange={event => onSteps(steps.map((s, at) => at === i ? { ...s, body: event.target.value } : s))} /></label>
      </li>)}</ol>
      {sequences.canSave ? <>
        <label className="mt-3 flex min-h-11 items-start gap-2"><input className="mt-1" type="checkbox" checked={saveSequence} onChange={event => onSaveSequence(event.target.checked)} /><span>Save these as a switched-off sequence in the Email Studio when the funnel is created</span></label>
        {saveSequence && left > 0 ? <p className="notice notice-warn mt-2 text-sm" role="status">{`Replace the ${left} ${left === 1 ? "part" : "parts"} marked ⟦like this⟧ in the emails, or uncheck saving them, before creating the funnel.`}</p> : null}
      </> : <p className="mt-3 text-xs text-ink-soft">{sequences.note || "Copy these into a sequence in the Email Studio."}</p>}
    </div> : null}
  </div>;
}
