"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { type Company, MAX_COMPANY_NAME } from "@/lib/crm-companies-rules";

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
  const [left, setLeft] = useState<Company | null>(null);

  async function send(body: Record<string, unknown>, done: string): Promise<{ companies: Company[]; added?: string } | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; companies?: Company[]; added?: string; message?: string; error?: string };
      if (answer.ok && answer.companies) {
        setCompanies(answer.companies);
        toast(done);
        return { companies: answer.companies, added: answer.added };
      }
      setError(answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment."));
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function link(id: string) {
    if (await send({ action: "link", id, person }, "Company saved.")) {
      setChoice(id);
      setLeft(null);
    }
  }

  async function unlink() {
    const was = current;
    if (await send({ action: "unlink", person }, "Taken off the company.")) {
      setChoice("");
      setLeft(was);
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    // The id the server made for this company: never guessed from the list, which another tab may have changed.
    const made = await send({ action: "add", name }, "Company added.");
    if (made?.added && made.companies.some((c) => c.id === made.added)) {
      setName("");
      await link(made.added);
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
                  <span className="sr-only"> (opens in a new tab)</span>
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
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block min-w-0 text-sm">
            <span className="field-label">Company</span>
            <select className="field mt-1" value={choice} onChange={(event) => setChoice(event.target.value)} disabled={busy}>
              <option value="">None</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || choice === (current?.id ?? "")}
            onClick={() => void (choice ? link(choice) : unlink())}
          >
            Save
          </button>
        </div>
      ) : null}
      <div role="status" className="mt-3">
        {left ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="[overflow-wrap:anywhere]">{`Taken off ${left.name}.`}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void link(left.id)}>
              Undo
            </button>
          </p>
        ) : null}
      </div>
      <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={create}>
        <label className="block min-w-0 text-sm">
          <span className="field-label">Or add a company</span>
          <input className="field mt-1" value={name} maxLength={MAX_COMPANY_NAME} onChange={(event) => setName(event.target.value)} placeholder="North School" aria-describedby="company-add-hint" />
          <span id="company-add-hint" className="mt-1 block text-xs text-ink-soft">
            Its name; this person is linked to it at once.
          </span>
        </label>
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !name.trim()}>
          Add and link
        </button>
      </form>
      <p className="mt-2 text-sm text-danger-text" role="alert">
        {error}
      </p>
    </div>
  );
}
