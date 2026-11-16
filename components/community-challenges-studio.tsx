"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import {
  CHALLENGE_KEEP_DAYS,
  MAX_CHALLENGE_ABOUT,
  MAX_CHALLENGE_AHEAD_DAYS,
  MAX_CHALLENGE_DAYS,
  MAX_CHALLENGE_TASK,
  MAX_CHALLENGE_TITLE,
  MAX_KEPT_CHALLENGES,
  MAX_OPEN_CHALLENGES,
} from "@/lib/community-text";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** One challenge as the studio shows it: its words, its days (UTC) and its counts. */
export type StudioChallenge = {
  id: string;
  title: string;
  task: string;
  /** "Dec 1, 2026", in UTC. */
  from: string;
  to: string;
  state: "scheduled" | "active" | "ended";
  /** How many joined, checked in in all and today; null when they could not be read just now. */
  joined: number | null;
  checkIns: number | null;
  today: number | null;
};

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  title: "Give the challenge a title.",
  task: "Say what members do each day.",
  dates: "Pick a first day and a last day, the last on or after the first.",
  too_long: `A challenge can last up to ${MAX_CHALLENGE_DAYS} days.`,
  past: "Those days are already over. Pick days still to come.",
  too_far: `A challenge can start up to ${MAX_CHALLENGE_AHEAD_DAYS} days ahead.`,
  full: `You can have ${MAX_OPEN_CHALLENGES} challenges not yet over, and ${MAX_KEPT_CHALLENGES} kept in all. Delete one, or wait for one to end.`,
  busy: "Another challenge is being saved right now. Try again in a moment.",
  slow: "That is a lot of changes in an hour. Wait a little, then try again.",
  unknown: "That challenge is not there anymore. Reload the page.",
  not_set_up: "Set the community up first.",
  role: "Your role on this store cannot change challenges.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  invalid: "That could not be read. Nothing was changed.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Answer = { ok?: boolean; error?: string };

async function send(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/community/challenges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

const STATE_WORDS = { scheduled: "Coming up", active: "On now", ended: "Over" } as const;

/**
 * The studio's challenges section: what each challenge is and how many took
 * part, a form to start one, and a delete that asks first. Days run midnight
 * to midnight UTC, and the form says so beside the dates.
 */
/**
 * `challenges` is null when the list could not be read: said so, never shown
 * as "No challenges yet." (rule 24; Claude 6's review of #3452, L3).
 */
export function CommunityChallengesStudio({ challenges: read, canManage }: { challenges: StudioChallenge[] | null; canManage: boolean }) {
  const challenges = read ?? [];
  const router = useRouter();
  const [draft, setDraft] = useState({ title: "", about: "", task: "", from: "", to: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ where: string; text: string; field?: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const taskRef = useRef<HTMLInputElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Each challenge's Delete button, so the focus can go back to it.
  const deleteRefs = useRef(new Map<string, HTMLButtonElement>());
  const asked = useRef<string | null>(null);
  // Where the focus goes after a delete that worked: the deleted challenge's
  // Delete button goes with it, so the list's heading takes the focus (2.4.3;
  // Claude 6's focal on #3452, C).
  const listHeadRef = useRef<HTMLHeadingElement>(null);
  // Asked whether to delete: the safe answer takes the focus the Delete button
  // had. When the question closes without deleting ("Keep it", or a delete that
  // failed), the focus goes back to that Delete button, never to the page
  // (2.4.3; Claude 6's review of #3452, L5).
  useEffect(() => {
    if (asking) keepRef.current?.focus();
    else if (asked.current) deleteRefs.current.get(asked.current)?.focus();
    asked.current = asking;
  }, [asking]);
  const open = challenges.filter((c) => c.state !== "ended").length;
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy("new");
    setError(null);
    const answer = await send({ action: "create", ...draft });
    setBusy(null);
    if (!answer.ok) {
      const code = answer.error ?? "";
      const field = code === "title" ? "title" : code === "task" ? "task" : ["dates", "too_long", "past", "too_far"].includes(code) ? "dates" : undefined;
      setError({ where: "new", text: MESSAGES[code] ?? MESSAGES.server_error, field });
      // The field the problem is in gets the focus, so a keyboard or screen reader user lands on it.
      (field === "title" ? titleRef : field === "task" ? taskRef : field === "dates" ? fromRef : null)?.current?.focus();
      return;
    }
    toast("Challenge started. Members can join it now.");
    setDraft({ title: "", about: "", task: "", from: "", to: "" });
    router.refresh();
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    const answer = await send({ action: "delete", challenge: id });
    setBusy(null);
    if (!answer.ok) {
      setAsking(null);
      setError({ where: id, text: MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error });
      return;
    }
    asked.current = null;
    setAsking(null);
    listHeadRef.current?.focus();
    toast("Challenge deleted.");
    router.refresh();
  }

  const problem = (where: string) =>
    error?.where === where ? (
      <p id={`ch-problem-${where}`} className="notice notice-error mt-4" role="alert">{error.text}</p>
    ) : null;
  const wrong = (field: string) => error?.where === "new" && error.field === field;

  return (
    <section id="challenges" className="card mt-8 scroll-mt-24 p-6 sm:p-8" aria-labelledby="cm-challenges-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cm-challenges-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Challenges</h2>
        <span className={`tag ${open ? "tag-brand" : ""}`}>{open ? `${open} not yet over` : "None on"}</span>
      </div>
      <p className="mt-2 max-w-[70ch] text-ink-soft">
        {`Give members one thing to do every day for a set number of days, like "Write 200 words". They join on the community's Challenges page and check in once a day; each sees their own days and streak, and you see how many took part. Days run from midnight to midnight UTC. Up to ${MAX_OPEN_CHALLENGES} can be on or coming up at once. A challenge stays on the page for ${CHALLENGE_KEEP_DAYS} days after it ends, then it is removed.`}
      </p>

      {canManage ? (
        <form className="mt-6 grid max-w-2xl gap-4" onSubmit={create} noValidate aria-describedby={error?.where === "new" ? "ch-problem-new" : undefined}>
          <h3 className="text-base font-semibold text-ink">Start a challenge</h3>
          <div>
            <label htmlFor="ch-title" className="field-label">Title</label>
            <input
              id="ch-title"
              ref={titleRef}
              className="field mt-1"
              required
              maxLength={MAX_CHALLENGE_TITLE}
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
              aria-invalid={wrong("title") || undefined}
              aria-describedby={wrong("title") ? "ch-problem-new" : undefined}
              autoComplete="off"
            />
          </div>
          <div>
            <label htmlFor="ch-task" className="field-label">What members do each day</label>
            <input
              id="ch-task"
              ref={taskRef}
              className="field mt-1"
              required
              maxLength={MAX_CHALLENGE_TASK}
              value={draft.task}
              onChange={(e) => set({ task: e.target.value })}
              aria-invalid={wrong("task") || undefined}
              aria-describedby={wrong("task") ? "ch-problem-new ch-task-help" : "ch-task-help"}
              autoComplete="off"
            />
            <p id="ch-task-help" className="mt-1 text-sm text-ink-soft">One short sentence. For example: Write 200 words.</p>
          </div>
          <div>
            <label htmlFor="ch-about" className="field-label">More about it (optional)</label>
            <textarea id="ch-about" className="field mt-1 min-h-[5rem]" maxLength={MAX_CHALLENGE_ABOUT} value={draft.about} onChange={(e) => set({ about: e.target.value })} />
          </div>
          <fieldset aria-describedby={wrong("dates") ? "ch-problem-new ch-dates-help" : "ch-dates-help"}>
            <legend className="field-label">Days</legend>
            <p id="ch-dates-help" className="mt-1 text-sm text-ink-soft">{`Each day runs from midnight to midnight UTC. Up to ${MAX_CHALLENGE_DAYS} days.`}</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-semibold text-ink-soft">First day (UTC)</span>
                <input ref={fromRef} type="date" required value={draft.from} onChange={(e) => set({ from: e.target.value })} className="field mt-1" aria-invalid={wrong("dates") || undefined} />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-ink-soft">Last day (UTC)</span>
                <input type="date" required value={draft.to} onChange={(e) => set({ to: e.target.value })} className="field mt-1" aria-invalid={wrong("dates") || undefined} />
              </label>
            </div>
          </fieldset>
          {problem("new")}
          <div>
            <button type="submit" className="btn btn-primary" disabled={busy !== null}>
              {busy === "new" ? "Starting…" : "Start the challenge"}
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-4 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">Your role can see the challenges and their counts. Starting and deleting them is for the owner, Admins and Editors.</p>
      )}

      <h3 ref={listHeadRef} tabIndex={-1} className="mt-8 text-sm font-bold uppercase tracking-[0.06em] text-ink-soft">Your challenges</h3>
      {read === null ? (
        <p className="mt-3 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink" role="status">The challenges could not be read just now. Reload the page.</p>
      ) : challenges.length === 0 ? (
        <p className="mt-3 rounded-[var(--r-md)] bg-sand p-4 text-sm text-ink-soft">No challenges yet.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {challenges.map((c) => (
            <li key={c.id} className="rounded-[var(--r-md)] border border-line p-4">
              <p className="text-sm font-semibold text-ink-soft">{STATE_WORDS[c.state]}</p>
              <h4 className="mt-1 break-words font-semibold text-ink">{c.title}</h4>
              <p className="mt-1 text-sm text-ink-soft">{`${c.from} to ${c.to}, UTC. Each day: ${c.task}`}</p>
              <p className="mt-2 text-sm text-ink">
                {c.joined === null
                  ? "The counts could not be read just now. Reload the page to try again."
                  : `${c.joined} joined, ${c.checkIns} ${c.checkIns === 1 ? "check-in" : "check-ins"} in all${c.state === "active" ? `, ${c.today} today` : ""}.`}
              </p>
              {canManage ? (
                asking === c.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-3" role="group" aria-labelledby={`ch-ask-${c.id}`}>
                    <p id={`ch-ask-${c.id}`} className="text-sm font-semibold text-ink">{"Delete it, with every member's check-ins? This cannot be undone."}</p>
                    <button type="button" className="btn btn-danger" disabled={busy !== null} onClick={() => remove(c.id)}>
                      {busy === c.id ? "Deleting…" : "Yes, delete it"}
                    </button>
                    <button type="button" ref={keepRef} className="btn" disabled={busy !== null} onClick={() => setAsking(null)}>Keep it</button>
                  </div>
                ) : (
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) deleteRefs.current.set(c.id, el);
                      else deleteRefs.current.delete(c.id);
                    }}
                    className="btn mt-3"
                    disabled={busy !== null}
                    onClick={() => setAsking(c.id)}
                    aria-label={`Delete the challenge ${c.title}`}
                  >
                    Delete
                  </button>
                )
              ) : null}
              {problem(c.id)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
