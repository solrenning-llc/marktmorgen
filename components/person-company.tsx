"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/toast";
import { type Company, MAX_COMPANY_NAME } from "@/lib/crm-companies-rules";

type Field = "choice" | "name";
/** Where the focus goes once the screen has drawn a change, so it is never left on a button that went away (AAA audit C1). */
type FocusTo = Field | "undo";

/**
 * The company a person works at, on their page in the studio (639
 * [GL7](4), unit 2): one to choose from the store's companies, a new one
 * made in place, or none. Kept by app/api/store/companies; linking them to
 * another company moves them, and taking them off can be undone.
 */
export function PersonCompany({ person, initial }: { person: string; initial: Company[] }) {
  const [companies, setCompanies] = useState(initial);
  const current = companies.find((c) => c.people.includes(person)) ?? null;
  const [choice, setChoice] = useState(current?.id ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<Field | null>(null);
  const [left, setLeft] = useState<Company | null>(null);
  // Whether the alert says the error too: when the focus is already in the field at fault, moving it there says nothing.
  const [spoken, setSpoken] = useState(true);
  const [errorAsk, setErrorAsk] = useState(0);
  const [focusAsk, setFocusAsk] = useState(0);
  const working = useRef(false);
  const focusNext = useRef<FocusTo | null>(null);
  const choiceField = useRef<HTMLSelectElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);

  function focusAfterDrawing(next: FocusTo) {
    focusNext.current = next;
    setFocusAsk((n) => n + 1);
  }

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (!next) return;
    (next === "undo" ? undoButton.current : next === "choice" ? choiceField.current : nameField.current)?.focus();
  }, [focusAsk]);

  function refuse(text: string, field: Field | null) {
    setError(text);
    setErrorField(field);
    setSpoken(!field || (field === "choice" ? choiceField : nameField).current === document.activeElement);
    // A new node each time, so the same refusal twice is said twice.
    setErrorAsk((n) => n + 1);
    if (field) focusAfterDrawing(field);
  }

  function clearError() {
    setError("");
    setErrorField(null);
  }

  async function send(body: Record<string, unknown>, done: string | null): Promise<{ companies: Company[]; added?: string } | null> {
    if (working.current) return null;
    working.current = true;
    setBusy(true);
    clearError();
    try {
      const response = await fetch("/api/store/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; companies?: Company[]; added?: string; message?: string; error?: string };
      if (answer.ok && answer.companies) {
        setCompanies(answer.companies);
        // Said once: a change also told in the status line beside it is not said again in a toast (AAA audit C6).
        if (done) toast(done);
        return { companies: answer.companies, added: answer.added };
      }
      // A name refused is told beside the field it was typed in (AAA audit C2); the rest under the whole.
      const field = body.action === "add" && (answer.error === "name" || answer.error === "taken") ? "name" : null;
      refuse(answer.message ?? (answer.error === "data_full" ? "Your store has no room left for more records. Delete some you no longer need first." : "That did not save. Try again in a moment."), field);
    } catch {
      refuse("That did not save. Check your connection and try again.", null);
    } finally {
      working.current = false;
      setBusy(false);
    }
    return null;
  }

  async function link(id: string, done: string) {
    if (await send({ action: "link", id, person }, done)) {
      setChoice(id);
      setLeft(null);
      return true;
    }
    return false;
  }

  async function unlink() {
    const was = current;
    if (await send({ action: "unlink", person }, null)) {
      setChoice("");
      setLeft(was);
      focusAfterDrawing("undo");
    }
  }

  function saveChoice() {
    if (busy) return;
    // Never a button that does nothing: with no change chosen, it says what to do (AAA audit C3).
    if (choice === (current?.id ?? "")) return refuse(current ? `This person already works at ${current.name}. Choose another company, or None, first.` : "Choose a company first.", "choice");
    void (choice ? link(choice, "Company saved.") : unlink());
  }

  async function undo() {
    if (!left || busy) return;
    const back = left;
    if (await link(back.id, `Linked to ${back.name} again.`)) focusAfterDrawing("choice");
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const typed = name;
    if (!typed.trim()) return refuse("Type the company's name.", "name");
    // The id the server made for this company: never guessed from the list, which another tab may have changed.
    const made = await send({ action: "add", name: typed }, null);
    if (made?.added && made.companies.some((c) => c.id === made.added)) {
      setName("");
      await link(made.added, `Added ${typed.trim()} and linked this person to it.`);
      focusAfterDrawing("name");
    }
  }

  return (
    <div>
      <p className="mt-1 text-sm text-ink">
        {current ? (
          <>
            {"Works at "}
            <span className="font-semibold [overflow-wrap:anywhere]">{current.name}</span>
            {current.website ? (
              <>
                {" · "}
                <a href={current.website} className="underline underline-offset-4 [overflow-wrap:anywhere]" rel="noopener noreferrer" target="_blank">
                  {current.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                  <span> (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </>
        ) : (
          "Not linked to a company."
        )}
      </p>
      {current?.note ? <p className="mt-1 text-sm text-ink-soft [overflow-wrap:anywhere]">{current.note}</p> : null}
      {companies.length ? (
        <>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block min-w-0 text-sm">
              <span className="field-label">Company</span>
              <select
                ref={choiceField}
                className="field mt-1"
                value={choice}
                aria-disabled={busy || undefined}
                aria-invalid={errorField === "choice" || undefined}
                aria-describedby={errorField === "choice" ? "company-choice-error" : undefined}
                onChange={(event) => {
                  if (busy) return;
                  setChoice(event.target.value);
                  if (errorField === "choice") clearError();
                }}
              >
                <option value="">None</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined} onClick={saveChoice}>
              Save
            </button>
          </div>
          {errorField === "choice" ? (
            <p id="company-choice-error" className="field-error mt-2 [overflow-wrap:anywhere]">
              {error}
            </p>
          ) : null}
        </>
      ) : null}
      <div role="status" className="mt-3">
        {left ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="[overflow-wrap:anywhere]">{`Taken off ${left.name}.`}</span>
            <button ref={undoButton} type="button" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined} onClick={() => void undo()}>
              Undo
            </button>
          </p>
        ) : null}
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={create} noValidate>
        <div className="block min-w-0 text-sm">
          <label htmlFor="company-add" className="field-label">
            Or add a company
          </label>
          <input
            id="company-add"
            ref={nameField}
            className="field mt-1"
            value={name}
            maxLength={MAX_COMPANY_NAME}
            onChange={(event) => {
              setName(event.target.value);
              if (errorField === "name") clearError();
            }}
            aria-invalid={errorField === "name" || undefined}
            aria-describedby={errorField === "name" ? "company-add-hint company-add-error" : "company-add-hint"}
          />
          <span id="company-add-hint" className="mt-1 block text-xs text-ink-soft">
            Example: North School. This person is linked to it when you add it.
          </span>
          {errorField === "name" ? (
            <span id="company-add-error" className="field-error mt-1 block [overflow-wrap:anywhere]">
              {error}
            </span>
          ) : null}
        </div>
        <button type="submit" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined}>
          Add and link
        </button>
      </form>
      <p className="mt-2 text-sm text-danger-text" role="alert">
        {/* Shown beside its field: here only said, once. */}
        <span key={errorAsk} className={errorField ? "sr-only" : undefined}>
          {errorField && !spoken ? "" : error}
        </span>
      </p>
    </div>
  );
}
