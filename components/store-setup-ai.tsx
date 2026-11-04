"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { Icon } from "@/components/icons";

type Kind = "download" | "course" | "call" | "membership";
type Setup = { bios: string[]; products: { title: string; summary: string; kind: Kind; price: string }[]; faq: { q: string; a: string }[]; questions?: { q: string; options: string[] }[] };
type Row = Setup["products"][number] & { keep: boolean };

const KIND_WORDS: Record<Kind, string> = {
  download: "A file to download",
  course: "A course (turn it into one from its editor)",
  call: "A call (set your hours from its editor)",
  membership: "A monthly membership",
};

/**
 * The store drafted with AI from a few sentences (lib/ai.ts,
 * writeStoreSetup): the line under the name, up to three products and the
 * questions and answers, shown before anything is kept. The creator picks a
 * line, changes or drops each product, and keeps what they want; products
 * are put up as drafts, never on sale until they add what each hands over.
 */
export function StoreSetupAi({ currency, left: startLeft, hasFaq, storeName }: { currency: string; left: number; hasFaq: boolean; storeName?: string }) {
  const router = useRouter();
  const [about, setAbout] = useState("");
  const [selling, setSelling] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [left, setLeft] = useState(startLeft);
  const [note, setNote] = useState("");
  const [setup, setSetup] = useState<Setup | null>(null);
  const [bio, setBio] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [keepFaq, setKeepFaq] = useState(!hasFaq);
  // 219 [OP5] unit 3: the answers pressed for the draft's questions, by question, and those already given,
  // which go first into every later draft so a long "What you sell" never cuts them off.
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [given, setGiven] = useState<{ q: string; a: string }[]>([]);
  const [announce, setAnnounce] = useState("");
  const questionsHeading = useRef<HTMLHeadingElement>(null);
  const draftHeading = useRef<HTMLHeadingElement>(null);
  // Where the eyes go when something new arrives: the questions, or the draft (2.4.3), and it is said (4.1.3).
  useEffect(() => {
    if (!setup) return;
    if (setup.questions?.length) questionsHeading.current?.focus();
    else if (setup.bios.length || setup.products.length) draftHeading.current?.focus();
  }, [setup]);
  const asking = Boolean(setup?.questions?.length);

  async function draft(answered: { q: string; a: string }[] = []) {
    if (drafting) return;
    setDrafting(true);
    setNote("");
    try {
      // The answers travel first, then what the creator sells, in their words, so the next draft starts from them.
      const all = [...given, ...answered];
      const notes = [...all.map((x) => `${x.q} ${x.a}`), selling].filter((x) => x.trim()).join("\n");
      const response = await fetch("/api/store/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "setup", about, notes }) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: Setup; left?: number; error?: string };
      if (data.ok && data.value) {
        setSetup(data.value);
        setPicked({});
        if (answered.length) setGiven(all);
        setAnnounce(data.value.questions?.length ? "A few questions before the draft." : "Your draft is ready below.");
        setBio(data.value.bios[0] ?? "");
        setRows(data.value.products.map((p) => ({ ...p, keep: true })));
        if (typeof data.left === "number") setLeft(data.left);
        return;
      }
      setNote(
        data.error === "used"
          ? "This month's writing help is used up. It starts again with your next billing month."
          : data.error === "notes"
            ? "Say in a sentence or two what you make and for whom."
            : "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.",
      );
    } catch {
      setNote("The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.");
    } finally {
      setDrafting(false);
    }
  }

  async function keep() {
    if (!setup || saving) return;
    // 219 [OP5]: a price is the creator's. A product kept with an empty price box waits here for one, rather than being lost.
    const unpriced = rows.findIndex((r) => r.keep && !r.price.trim());
    if (unpriced >= 0) {
      setNote(`Type a price for ${rows[unpriced].title.trim() || "each product you keep"}, or uncheck Keep it.`);
      document.getElementById(`setup-price-${unpriced}`)?.focus();
      return;
    }
    setSaving(true);
    setNote("");
    try {
      const response = await fetch("/api/store/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio, products: rows.filter((r) => r.keep).map(({ title, summary, kind, price }) => ({ title, summary, kind, price })), faq: keepFaq ? setup.faq : [] }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; done?: { bio: boolean; products: number; pages?: number; faq: boolean; refused: string[] } };
      if (data.ok && data.done) {
        const parts = [data.done.bio ? "the line under your name" : "", data.done.products ? `${data.done.products} draft product${data.done.products === 1 ? "" : "s"}${data.done.pages ? `, ${data.done.pages === data.done.products ? (data.done.products === 1 ? "with its sales page" : "each with its sales page") : `${data.done.pages} with a sales page`}` : ""}` : "", data.done.faq ? "your questions and answers" : ""].filter(Boolean);
        toast(parts.length ? `Kept: ${parts.join(", ")}.` : "Nothing was kept.");
        if (data.done.refused.length) setNote(`Not kept, because it has no price this store can charge yet: ${data.done.refused.join(", ")}. Type its price above and keep it again, or add it from Products.`);
        else setSetup(null);
        router.refresh();
        return;
      }
      setNote("Something went wrong on our side. Nothing was changed. Try again in a moment.");
    } catch {
      setNote("Something went wrong on our side. Nothing was changed. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section id="setup-ai" aria-labelledby="setup-ai-title" className="card mt-8 scroll-mt-32 p-6 sm:p-8">
      <h2 id="setup-ai-title" className="flex items-center gap-2 text-lg font-semibold tracking-[-0.02em] text-ink">
        <Icon name="sparkle" size={20} />
        Draft your store with AI
      </h2>
      {storeName ? <p className="mt-2 font-semibold text-ink">Your store: {storeName}. Keep your name, or edit it in Store details.</p> : null}
      <p className="mt-2 text-ink-soft">
        Say what you make and for whom. AI drafts the line under your name, up to three products with a summary (and the price,
        only where you give one), and the questions visitors ask, from your words only. You see it all first, change what you like, and keep only what
        you want: products stay hidden until you add what each one hands over and choose Publish yourself. Paid selling still follows the sales gates.
      </p>
      <p className="mt-3 text-sm text-ink-soft">One sentence is enough to start. This uses the existing writing allowance; no draft runs automatically. You can also add your first offer manually in Products.</p>
      <div className="mt-5 grid gap-4">
        <div>
          <label htmlFor="setup-about" className="field-label">What you do, and for whom</label>
          <textarea id="setup-about" rows={3} value={about} onChange={(e) => setAbout(e.target.value)} className="field mt-2" placeholder="I teach busy parents to cook a week of dinners in two hours on Sunday." />
        </div>
        <div>
          <label htmlFor="setup-selling" className="field-label">What you sell, or want to sell (optional)</label>
          <textarea id="setup-selling" rows={2} value={selling} onChange={(e) => setSelling(e.target.value)} className="field mt-2" placeholder="A meal planner PDF, a video course, maybe one-to-one calls." />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => draft()} disabled={drafting || !about.trim() || asking} aria-busy={drafting} className="btn btn-primary">
          <Icon name="sparkle" size={16} />
          {drafting ? "Drafting your store…" : setup ? "Draft it again" : "Draft my store"}
        </button>
        <span className="text-sm text-ink-soft">{`One draft counts once. ${left} left this month.`}</span>
      </div>

      {setup?.questions?.length ? (
        <section aria-labelledby="setup-questions-title" className="mt-6 rounded-2xl bg-paper p-4 ring-1 ring-line">
          <h3 id="setup-questions-title" ref={questionsHeading} tabIndex={-1} className="text-base font-semibold text-ink">{setup.questions.length === 1 ? "One question first" : `${setup.questions.length} quick questions first`}</h3>
          <p className="mt-1 text-sm text-ink-soft">You have not told us this yet. Choose one answer for each, then continue. The next draft counts once.</p>
          {setup.questions.map((question, i) => (
            <fieldset key={i} className="mt-4">
              <legend className="text-sm font-semibold text-ink">{question.q}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <label key={option} className={`btn btn-sm cursor-pointer focus-within:outline focus-within:outline-[3px] focus-within:outline-offset-2 focus-within:outline-[var(--ink)] forced-colors:focus-within:outline-[CanvasText] ${picked[i] === option ? "btn-primary" : "btn-secondary"}`}>
                    <input type="radio" name={`setup-question-${i}`} value={option} checked={picked[i] === option} onChange={() => setPicked({ ...picked, [i]: option })} className="sr-only" />
                    {/* Chosen is shown by a mark, not by color alone (1.4.1), and stays visible in forced colors. */}
                    {picked[i] === option ? <Icon name="check" size={14} /> : null}
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className="btn btn-primary mt-4"
            disabled={drafting || setup.questions.some((_, i) => !picked[i])}
            aria-busy={drafting}
            onClick={() => draft((setup.questions ?? []).map((question, i) => ({ q: question.q, a: picked[i] ?? "" })))}
          >
            {drafting ? "Drafting your store…" : "Continue"}
          </button>
        </section>
      ) : null}

      {setup && (setup.bios.length || setup.products.length) ? (
        <div className="mt-6 space-y-6">
          <h3 ref={draftHeading} tabIndex={-1} className="text-base font-semibold text-ink">Your draft</h3>
          {setup.bios.length ? (
            <fieldset>
              <legend className="field-label">The line under your name</legend>
              <div className="mt-2 space-y-2">
                {setup.bios.map((line) => (
                  <label key={line} className="flex items-start gap-3 rounded-2xl bg-paper p-3 text-ink ring-1 ring-line">
                    <input type="radio" name="setup-bio" checked={bio === line} onChange={() => setBio(line)} className="mt-1 size-5 shrink-0 accent-violet-brand" />
                    <span>{line}</span>
                  </label>
                ))}
                <label className="flex items-start gap-3 rounded-2xl bg-paper p-3 text-ink ring-1 ring-line">
                  <input type="radio" name="setup-bio" checked={bio === ""} onChange={() => setBio("")} className="mt-1 size-5 shrink-0 accent-violet-brand" />
                  <span>Keep my own</span>
                </label>
              </div>
            </fieldset>
          ) : null}

          {rows.length ? (
            <fieldset>
              <legend className="field-label">Products, as drafts</legend>
              <ul className="mt-2 space-y-3">
                {rows.map((row, i) => (
                  <li key={i} className="rounded-2xl bg-paper p-4 ring-1 ring-line">
                    <label className="flex items-center gap-3 text-sm font-semibold text-ink">
                      <input type="checkbox" checked={row.keep} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, keep: e.target.checked } : r)))} className="size-5 accent-violet-brand" />
                      {`Keep it — ${KIND_WORDS[row.kind]}`}
                    </label>
                    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_8rem]">
                      <div>
                        <label htmlFor={`setup-title-${i}`} className="text-xs font-semibold text-ink-soft">Name</label>
                        <input id={`setup-title-${i}`} value={row.title} maxLength={120} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))} className="field mt-1" />
                      </div>
                      <div>
                        <label htmlFor={`setup-price-${i}`} className="text-xs font-semibold text-ink-soft">{`Price, ${currency.toUpperCase()}`}</label>
                        <input id={`setup-price-${i}`} inputMode="decimal" value={row.price} aria-invalid={row.keep && !row.price.trim() ? true : undefined} aria-describedby={row.keep && !row.price.trim() ? `setup-price-${i}-need` : undefined} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, price: e.target.value } : r)))} className="field mt-1" />
                        {row.keep && !row.price.trim() ? <p id={`setup-price-${i}-need`} className="mt-1 text-xs font-semibold text-ink">You did not give a price. Type yours.</p> : null}
                      </div>
                    </div>
                    <label htmlFor={`setup-summary-${i}`} className="mt-3 block text-xs font-semibold text-ink-soft">What the buyer gets</label>
                    <input id={`setup-summary-${i}`} value={row.summary} maxLength={160} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, summary: e.target.value } : r)))} className="field mt-1" />
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm text-ink-soft">A price is filled in only from a price you wrote, in your store&apos;s currency; check that each sits on the right product. Where the box is empty, type your price.</p>
            </fieldset>
          ) : null}

          {setup.faq.length ? (
            <fieldset>
              <legend className="field-label">Questions and answers</legend>
              {hasFaq ? (
                <p className="mt-2 text-sm text-ink-soft">Your store already has its questions, so these are not kept. Use them in Questions on your store page if you like.</p>
              ) : (
                <label className="mt-2 flex items-center gap-3 text-sm font-semibold text-ink">
                  <input type="checkbox" checked={keepFaq} onChange={(e) => setKeepFaq(e.target.checked)} className="size-5 accent-violet-brand" />
                  Keep them on my store page
                </label>
              )}
              <dl className="mt-3 space-y-2">
                {setup.faq.map((item) => (
                  <div key={item.q} className="rounded-2xl bg-paper p-3 ring-1 ring-line">
                    <dt className="font-semibold text-ink">{item.q}</dt>
                    <dd className="mt-1 text-sm text-ink-soft">{item.a}</dd>
                  </div>
                ))}
              </dl>
            </fieldset>
          ) : null}

          <button type="button" onClick={keep} disabled={saving} aria-busy={saving} className="btn btn-primary">
            {saving ? "Keeping…" : "Keep what I chose"}
          </button>
        </div>
      ) : null}
      {note ? <p role="status" className="mt-4 text-sm font-semibold text-ink">{note}</p> : null}
      <p role="status" className="sr-only">{announce}</p>
    </section>
  );
}
