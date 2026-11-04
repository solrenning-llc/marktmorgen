"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { type Company, MAX_COMPANIES, MAX_COMPANY_NAME, MAX_COMPANY_NOTE } from "@/lib/crm-companies-rules";

type Shown = Company & { addresses: Record<string, string> };

/**
 * The store's companies in the studio (639 [GL7](4), unit 3): each with its
 * people, a way to add one, and to change or delete one. Deleting a company
 * keeps its people, only no longer linked, and is undone by adding it back
 * with the same people.
 */
export function CompaniesEditor({ initial, peopleBase }: { initial: Shown[]; peopleBase: string }) {
  const peopleHref = (person: string) => `${peopleBase}${peopleBase.includes("?") ? "&" : "?"}who=${person}`;
  const [companies, setCompanies] = useState(initial);
  const [form, setForm] = useState({ name: "", website: "", note: "" });
  const [editing, setEditing] = useState<string | null>(null);
  const [gone, setGone] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(body: Record<string, unknown>, done: string): Promise<Company[] | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; companies?: Company[]; message?: string; error?: string };
      if (answer.ok && answer.companies) {
        const known = new Map(companies.map((c) => [c.id, c.addresses]));
        setCompanies(answer.companies.map((c) => ({ ...c, addresses: known.get(c.id) ?? {} })));
        toast(done);
        return answer.companies;
      }
      setError(answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment."));
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const done = await send(editing ? { action: "edit", id: editing, ...form } : { action: "add", ...form }, editing ? "Company saved." : "Company added.");
    if (done) {
      setForm({ name: "", website: "", note: "" });
      setEditing(null);
    }
  }

  async function remove(company: Shown) {
    if (await send({ action: "remove", id: company.id }, "Company deleted.")) setGone(company);
  }

  async function undo() {
    if (!gone) return;
    const back = await send({ action: "add", name: gone.name, website: gone.website, note: gone.note }, "Company put back.");
    const added = back?.find((c) => c.name === gone.name);
    if (added) for (const person of gone.people) await send({ action: "link", id: added.id, person }, "Company put back.");
    setGone(null);
  }

  return (
    <div className="space-y-8">
      <form onSubmit={save} aria-busy={busy} className="card p-6 sm:p-8" noValidate>
        <h2 id="company-form-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          {editing ? "Change the company" : "Add a company"}
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="field-label">Name</span>
            <input className="field mt-1" value={form.name} maxLength={MAX_COMPANY_NAME} onChange={(event) => setForm({ ...form, name: event.target.value })} aria-describedby="company-name-hint" />
            <span id="company-name-hint" className="mt-1 block text-xs text-ink-soft">
              Example: North School
            </span>
          </label>
          <label className="block text-sm">
            <span className="field-label">Website (optional)</span>
            <input type="url" className="field mt-1" value={form.website} onChange={(event) => setForm({ ...form, website: event.target.value })} aria-describedby="company-site-hint" />
            <span id="company-site-hint" className="mt-1 block text-xs text-ink-soft">
              Example: https://north.example.com
            </span>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="field-label">Note (optional)</span>
            <input className="field mt-1" value={form.note} maxLength={MAX_COMPANY_NOTE} onChange={(event) => setForm({ ...form, note: event.target.value })} aria-describedby="company-note-hint" />
            <span id="company-note-hint" className="mt-1 block text-xs text-ink-soft">
              For you and your team only. Example: Buys seats each term.
            </span>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim() || (!editing && companies.length >= MAX_COMPANIES)}>
            {editing ? "Save the company" : "Add the company"}
          </button>
          {editing ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setEditing(null);
                setForm({ name: "", website: "", note: "" });
              }}
            >
              Cancel
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-sm text-danger-text" role="alert">
          {error}
        </p>
      </form>
      <div role="status">
        {gone ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="[overflow-wrap:anywhere]">{`Deleted ${gone.name}. Its people are still in your store.`}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void undo()}>
              Undo
            </button>
          </p>
        ) : null}
      </div>
      <section aria-labelledby="companies-title">
        <h2 id="companies-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Your companies (${companies.length})`}</h2>
        {companies.length ? (
          <ul className="mt-4 space-y-4">
            {companies.map((company) => (
              <li key={company.id} className="card p-5">
                <h3 className="font-semibold text-ink [overflow-wrap:anywhere]">{company.name}</h3>
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
                          </a>
                        ) : (
                          <span className="text-ink-soft">Someone not among the buyers read from your Stripe account</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy}
                    aria-label={`Change ${company.name}`}
                    onClick={() => {
                      setEditing(company.id);
                      setForm({ name: company.name, website: company.website, note: company.note });
                    }}
                  >
                    Change
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Delete ${company.name}`} onClick={() => void remove(company)}>
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
    </div>
  );
}
