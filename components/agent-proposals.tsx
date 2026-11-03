"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";

export type ProposalRow = { id: string; label: string; asked: string; at: string; before: string; after: string };
export type DoneRow = { id: string; label: string; confirmed: string; undo: boolean; undone: string | null };

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; message?: string; done?: string[]; refused?: { id: string; why: string }[] }> {
  try {
    const response = await fetch("/api/store/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; done?: string[]; refused?: { id: string; why: string }[] };
    return { ok: data.ok === true, message: data.message, done: data.done, refused: data.refused };
  } catch {
    return { ok: false, message: "That could not be done just now. Try again in a moment." };
  }
}

const WHY: Record<string, string> = {
  changed_since: "it was changed since it was proposed, so it was not carried out",
  unknown: "it is not waiting any more",
  failed: "it could not be carried out just now",
  terms: "its words are not allowed on a product that is on the store (a promise of fast or easy money, or a ready outline's prompt left in), so it was not carried out; decline it",
  unknown_kind: "this kind of change is not available",
  one_at_a_time: "it has to be confirmed on its own",
  batch_too_large: "too many at once",
};

/** What the AI proposes, each with what is there now beside what it would become (631 [AA1] (c)). */
export function AgentProposals({ waiting, history }: { waiting: ProposalRow[]; history: DoneRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function run(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key);
    setMessage(null);
    const answer = await post(body);
    setBusy("");
    if (!answer.ok) {
      setMessage(answer.message ?? "That could not be done just now. Try again in a moment.");
      return;
    }
    const refused = answer.refused ?? [];
    if (refused.length) setMessage(`${answer.done?.length ?? 0} carried out. Not carried out: ${refused.map((r) => WHY[r.why] ?? r.why).join("; ")}.`);
    else toast(ok);
    router.refresh();
  }

  return (
    <div>
      {message ? <p className="notice notice-info mt-4" role="status">{message}</p> : null}
      <section aria-labelledby="waiting-title" className="card mt-6 p-6 sm:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="waiting-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Waiting for you (${waiting.length})`}</h2>
          {waiting.length > 1 ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== ""} aria-busy={busy === "all"} onClick={() => void run("all", { action: "confirm", ids: waiting.map((w) => w.id) }, "Carried out.")}>
              {`Confirm all ${waiting.length}`}
            </button>
          ) : null}
        </div>
        {waiting.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">Nothing is waiting. When your AI assistant prepares a change, it waits here until you confirm it.</p>
        ) : (
          <ul className="mt-4 space-y-5">
            {waiting.map((p) => (
              <li key={p.id} className="rounded-2xl border border-line bg-paper p-4">
                <h3 className="font-semibold text-ink">{p.label}</h3>
                <p className="mt-0.5 text-xs text-ink-soft">{`Prepared by ${p.asked}, ${p.at}. Nothing has changed yet.`}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="field-label">Now</p>
                    <div className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-sand/60 p-3 text-sm text-ink" tabIndex={0} aria-label="What is there now">{p.before || "(empty)"}</div>
                  </div>
                  <div>
                    <p className="field-label">Would become</p>
                    <div className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-lilac/40 p-3 text-sm text-ink" tabIndex={0} aria-label="What it would become">{p.after || "(empty)"}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy !== ""} aria-busy={busy === p.id} onClick={() => void run(p.id, { action: "confirm", ids: [p.id] }, "Carried out. You can undo it below.")}>
                    Confirm
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== ""} onClick={() => void run(`d-${p.id}`, { action: "decline", id: p.id }, "Declined. Nothing was changed.")}>
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="done-title" className="card mt-6 p-6 sm:p-8">
        <h2 id="done-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">What the AI did</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">Nothing yet. Every change you confirm is listed here, with who confirmed it and when.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {history.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span className="text-ink">
                  {d.label}
                  <span className="text-ink-soft">{` · ${d.confirmed}${d.undone ? ` · put back ${d.undone}` : ""}`}</span>
                </span>
                {d.undo && !d.undone ? (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== ""} aria-busy={busy === `u-${d.id}`} onClick={() => void run(`u-${d.id}`, { action: "undo", id: d.id }, "Put back as it was.")}>
                    Undo
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
