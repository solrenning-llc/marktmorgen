"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { COMPANY_REFUSALS, type Company, MAX_COMPANIES, MAX_COMPANY_NAME, MAX_COMPANY_NOTE, MAX_COMPANY_WEBSITE } from "@/lib/crm-companies-rules";

type Shown = Company & { addresses: Record<string, string> };
type Field = "name" | "website" | "note";
/** Where the focus goes once the screen has drawn a change, so it is never left on a button that went away (AAA audit C1). */
type FocusTo = { to: Field | "undo" | "list"; scroll?: boolean } | { to: "change" | "company"; id: string; scroll?: boolean };

/** The field each refusal is about (lib/crm-companies-rules.ts), so the message is told beside that field (AAA audit C2). */
const FIELD_OF: Partial<Record<string, Field>> = { name: "name", taken: "name", website: "website", note: "note" };
const DATA_FULL = "Your store has no room left for more records. Delete some you no longer need first.";

/**
 * The store's companies in the studio (639 [GL7](4), unit 3): each with its
 * people, a way to add one, and to change or delete one. Deleting a company
 * keeps its people, only no longer linked, and is undone by adding it back
 * with the same people.
 */
export function CompaniesEditor({
  initial,
  peopleBase,
  addressesRead = true,
  addressesPartial = false,
  unreadable: unreadableAtFirst = [],
}: {
  initial: Shown[];
  /** Records kept that cannot be read as a company: each still takes a place among MAX_COMPANIES, and can be deleted. */
  unreadable?: string[];
  peopleBase: string;
  /** False when Stripe could not be read, so nobody's address is known just now. */
  addressesRead?: boolean;
  /** True when Stripe holds more buyers than one reading takes, so the oldest were not read. */
  addressesPartial?: boolean;
}) {
  const peopleHref = (person: string) => `${peopleBase}${peopleBase.includes("?") ? "&" : "?"}who=${person}`;
  const [companies, setCompanies] = useState(initial);
  const [unreadable, setUnreadable] = useState(unreadableAtFirst);
  const [form, setForm] = useState({ name: "", website: "", note: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [gone, setGone] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<Field | null>(null);
  // Whether the alert says the error too: when the focus is already in the field at fault, moving it there says nothing.
  const [spoken, setSpoken] = useState(true);
  const [errorAsk, setErrorAsk] = useState(0);
  const [putBack, setPutBack] = useState("");
  const [focusAsk, setFocusAsk] = useState(0);
  const working = useRef(false);
  const focusNext = useRef<FocusTo | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const websiteField = useRef<HTMLInputElement>(null);
  const noteField = useRef<HTMLInputElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const listTitle = useRef<HTMLHeadingElement>(null);
  const changeButtons = useRef(new Map<string, HTMLButtonElement>());
  const headings = useRef(new Map<string, HTMLHeadingElement>());
  const full = !editing && companies.length + unreadable.length >= MAX_COMPANIES;

  function focusAfterDrawing(next: FocusTo) {
    focusNext.current = next;
    setFocusAsk((n) => n + 1);
  }

  // Once the change asked for is drawn: the field, button or heading named, or the list's title when it is gone.
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (!next) return;
    const fields = { name: nameField, website: websiteField, note: noteField };
    const target =
      next.to === "change" ? changeButtons.current.get(next.id) : next.to === "company" ? headings.current.get(next.id) : next.to === "undo" ? undoButton.current : next.to === "list" ? listTitle.current : fields[next.to].current;
    const shown = target ?? listTitle.current;
    shown?.focus();
    if (next.scroll) shown?.scrollIntoView({ block: "center" });
  }, [focusAsk]);

  function refuse(text: string, field: Field | null) {
    const fields = { name: nameField, website: websiteField, note: noteField };
    setError(text);
    setErrorField(field);
    setSpoken(!field || fields[field].current === document.activeElement);
    // A new node each time, so the same refusal twice is said twice.
    setErrorAsk((n) => n + 1);
    if (field) focusAfterDrawing({ to: field });
  }

  function clearError() {
    setError("");
    setErrorField(null);
  }

  /** A field typed in: its value, and its refusal gone once the person corrects it. */
  function type(field: Field, value: string) {
    setForm({ ...form, [field]: value });
    if (errorField === field) clearError();
  }

  async function send(body: Record<string, unknown>, done: string | null): Promise<{ companies: Company[]; added?: string; skipped?: string[] } | null> {
    if (working.current) return null;
    working.current = true;
    setBusy(true);
    clearError();
    try {
      const response = await fetch("/api/store/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; companies?: Company[]; added?: string; skipped?: string[]; message?: string; error?: string };
      if (answer.ok && answer.companies) {
        const known = new Map(companies.map((c) => [c.id, c.addresses]));
        // A company put back keeps the addresses it was shown with, under its new id.
        if (answer.added && body.action === "restore" && gone) known.set(answer.added, gone.addresses);
        setCompanies(answer.companies.map((c) => ({ ...c, addresses: known.get(c.id) ?? {} })));
        // Said once: a change also told in the status line beside it is not said again in a toast (AAA audit C6).
        if (done) toast(done);
        return { companies: answer.companies, added: answer.added, skipped: answer.skipped };
      }
      // Only the form's own fields are named: an undo is refused as a whole, under the form.
      const field = body.action === "add" || body.action === "edit" ? (FIELD_OF[answer.error ?? ""] ?? null) : null;
      refuse(answer.message ?? (answer.error === "data_full" ? DATA_FULL : "That did not save. Try again in a moment."), field);
    } catch {
      refuse("That did not save. Check your connection and try again.", null);
    } finally {
      working.current = false;
      setBusy(false);
    }
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (full) return refuse(COMPANY_REFUSALS.full, null);
    if (!form.name.trim()) return refuse("Type the company's name.", "name");
    const was = editing;
    const done = await send(was ? { action: "edit", id: was, ...form } : { action: "add", ...form }, was ? "Company saved." : "Company added.");
    if (done) {
      setForm({ name: "", website: "", note: "" });
      setEditing(null);
      // A change saved goes back to the button that opened it; an add stays in the field, ready for the next one.
      focusAfterDrawing(was ? { to: "change", id: was } : { to: "name" });
    }
  }

  function cancel() {
    const was = editing;
    setEditing(null);
    setForm({ name: "", website: "", note: "" });
    clearError();
    if (was) focusAfterDrawing({ to: "change", id: was });
  }

  /** A record that cannot be read deleted, so its place is free again (round 3, L3); nothing to undo, since nothing of it could be shown. */
  async function removeUnreadable(id: string) {
    if (busy) return;
    if (await send({ action: "remove", id }, "The record that could not be read is deleted.")) {
      setUnreadable((left) => left.filter((other) => other !== id));
      focusAfterDrawing({ to: "list" });
    }
  }

  async function remove(company: Shown) {
    if (busy) return;
    if (await send({ action: "remove", id: company.id }, null)) {
      setPutBack("");
      setGone(company);
      if (editing === company.id) cancel();
      focusAfterDrawing({ to: "undo" });
    }
  }

  // Put back in one change, with the people who are not at another company now (review A2/A3); says who did not come back.
  async function undo() {
    if (!gone || busy) return;
    const back = await send({ action: "restore", name: gone.name, website: gone.website, note: gone.note, people: gone.people }, null);
    if (!back) return;
    const left = back.skipped?.length ?? 0;
    setPutBack(
      left
        ? `${gone.name} is back with ${gone.people.length - left} of its ${gone.people.length} people. ${left === 1 ? "One person had" : `${left} people had`} moved to another company since, and ${left === 1 ? "stays" : "stay"} there.`
        : gone.people.length
          ? `${gone.name} is back with its people.`
          : `${gone.name} is back.`,
    );
    setGone(null);
    focusAfterDrawing(back.added ? { to: "company", id: back.added } : { to: "list" });
  }

  const described = (field: Field, hint: string) => (errorField === field ? `${hint} company-${field}-error` : hint);
  const fieldError = (field: Field) =>
    errorField === field ? (
      <span id={`company-${field}-error`} className="field-error mt-1 block [overflow-wrap:anywhere]">
        {error}
      </span>
    ) : null;

  return (
    <div className="space-y-8">
      <form onSubmit={save} aria-busy={busy} className="card p-6 sm:p-8" noValidate>
        <h2 id="company-form-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          {editing ? "Change the company" : "Add a company"}
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="block text-sm">
            <label htmlFor="company-name" className="field-label">
              Name
            </label>
            <input
              id="company-name"
              ref={nameField}
              className="field mt-1"
              value={form.name}
              maxLength={MAX_COMPANY_NAME}
              onChange={(event) => type("name", event.target.value)}
              aria-invalid={errorField === "name" || undefined}
              aria-describedby={described("name", "company-name-hint")}
            />
            <span id="company-name-hint" className="mt-1 block text-xs text-ink-soft">
              Example: North School
            </span>
            {fieldError("name")}
          </div>
          <div className="block text-sm">
            <label htmlFor="company-website" className="field-label">
              Website (optional)
            </label>
            <input
              id="company-website"
              ref={websiteField}
              type="url"
              className="field mt-1"
              value={form.website}
              maxLength={MAX_COMPANY_WEBSITE}
              onChange={(event) => type("website", event.target.value)}
              aria-invalid={errorField === "website" || undefined}
              aria-describedby={described("website", "company-site-hint")}
            />
            <span id="company-site-hint" className="mt-1 block text-xs text-ink-soft">
              Example: https://north.example.com
            </span>
            {fieldError("website")}
          </div>
          <div className="block text-sm sm:col-span-2">
            <label htmlFor="company-note" className="field-label">
              Note (optional)
            </label>
            <input
              id="company-note"
              ref={noteField}
              className="field mt-1"
              value={form.note}
              maxLength={MAX_COMPANY_NOTE}
              onChange={(event) => type("note", event.target.value)}
              aria-invalid={errorField === "note" || undefined}
              aria-describedby={described("note", "company-note-hint")}
            />
            <span id="company-note-hint" className="mt-1 block text-xs text-ink-soft">
              For you and your team only. Example: Buys seats each term.
            </span>
            {fieldError("note")}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" aria-disabled={busy || full || undefined} aria-describedby={full ? "companies-full" : undefined}>
            {editing ? "Save the company" : "Add the company"}
          </button>
          {editing ? (
            <button type="button" className="btn btn-ghost" onClick={cancel}>
              Cancel
            </button>
          ) : null}
        </div>
        {full ? (
          <p id="companies-full" className="mt-2 text-sm text-ink">
            {COMPANY_REFUSALS.full}
          </p>
        ) : null}
        <p className="mt-2 text-sm text-danger-text" role="alert">
          {/* Shown beside its field, or beside the button at the limit: here only said, once. */}
          <span key={errorAsk} className={errorField || (full && error === COMPANY_REFUSALS.full) ? "sr-only" : undefined}>
            {errorField && !spoken ? "" : error}
          </span>
        </p>
      </form>
      <div role="status">
        {gone ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="[overflow-wrap:anywhere]">{`Deleted ${gone.name}. Its people are still in your store.`}</span>
            <button ref={undoButton} type="button" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined} onClick={() => void undo()}>
              Undo
            </button>
          </p>
        ) : putBack ? (
          <p className="text-sm text-ink [overflow-wrap:anywhere]">{putBack}</p>
        ) : null}
      </div>
      <section aria-labelledby="companies-title">
        <h2 ref={listTitle} id="companies-title" tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Your companies (${companies.length})`}</h2>
        {companies.length ? (
          <ul className="mt-4 space-y-4">
            {companies.map((company) => (
              <li key={company.id} className="card p-5">
                <h3
                  ref={(element) => {
                    if (element) headings.current.set(company.id, element);
                    else headings.current.delete(company.id);
                  }}
                  tabIndex={-1}
                  className="font-semibold text-ink [overflow-wrap:anywhere]"
                >
                  {company.name}
                </h3>
                {company.website ? <p className="mt-1 text-sm text-ink-soft [overflow-wrap:anywhere]">{company.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}</p> : null}
                {company.note ? <p className="mt-1 text-sm text-ink-soft [overflow-wrap:anywhere]">{company.note}</p> : null}
                <p className="mt-3 text-sm text-ink">{company.people.length ? `${company.people.length} ${company.people.length === 1 ? "person" : "people"}:` : "Nobody linked yet. Link someone from their page under Buyers."}</p>
                {company.people.length ? (
                  <ul className="mt-1 space-y-1 text-sm">
                    {company.people.map((person) => (
                      <li key={person}>
                        {company.addresses[person] ? (
                          <a href={peopleHref(person)} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]">
                            {company.addresses[person]}
                            <span className="sr-only">: open their page</span>
                          </a>
                        ) : (
                          <span className="text-ink-soft">{addressesRead ? `A person we could not find among your Stripe buyers${addressesPartial ? " (the oldest buyers are not read)" : ""}` : "A person whose address could not be read just now"}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    ref={(element) => {
                      if (element) changeButtons.current.set(company.id, element);
                      else changeButtons.current.delete(company.id);
                    }}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    aria-disabled={busy || undefined}
                    aria-label={`Change ${company.name}`}
                    onClick={() => {
                      if (busy) return;
                      setEditing(company.id);
                      setForm({ name: company.name, website: company.website, note: company.note });
                      clearError();
                      // The form it opens is above the list: the focus goes to it, so a keyboard or screen reader user lands where they type (review A6).
                      focusAfterDrawing({ to: "name", scroll: true });
                    }}
                  >
                    Change
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" aria-disabled={busy || undefined} aria-label={`Delete ${company.name}`} onClick={() => void remove(company)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">No companies yet. Add the first one above, or from a person&apos;s page.</p>
        )}
      </section>
      {unreadable.length ? (
        <section aria-labelledby="unreadable-title" className="card p-6 sm:p-8">
          <h2 id="unreadable-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Records that can't be read (${unreadable.length})`}</h2>
          <p className="mt-2 text-sm text-ink-soft">
            {unreadable.length === 1 ? "A company record was saved here that can't be read now. It still takes one of your " : "Some company records were saved here that can't be read now. Each still takes one of your "}
            {`${MAX_COMPANIES} places. Delete ${unreadable.length === 1 ? "it" : "them"} to free ${unreadable.length === 1 ? "its place" : "their places"}.`}
          </p>
          <ul className="mt-4 space-y-3">
            {unreadable.map((id, i) => (
              <li key={id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-paper p-4 text-sm ring-1 ring-line">
                <span>{`Unreadable record ${i + 1}`}</span>
                <button type="button" className="btn btn-ghost btn-sm" aria-disabled={busy || undefined} aria-label={`Delete unreadable record ${i + 1}`} onClick={() => void removeUnreadable(id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
