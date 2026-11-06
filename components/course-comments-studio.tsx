"use client";

import { useState } from "react";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { whenWords } from "@/lib/community-text";
import { MAX_LESSON_COMMENT } from "@/lib/lesson-comments-rules";

export type StudioComment = {
  id: string;
  lessonId: string;
  lessonTitle: string;
  /** The student's chosen name, or "" for the creator's own words. */
  name: string;
  fromCreator: boolean;
  text: string;
  at: number;
  hidden: boolean;
  /** Whether this is an answer, and to whom. */
  answerTo: string | null;
  /** The comment this answers, when it is an answer. */
  parentId: string | null;
  /** Newer than the last time the studio showed the comments. */
  fresh: boolean;
};

type Answer = { ok: boolean; error?: string };

async function post(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/course", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  gone: "That comment is no longer there. Reload the page.",
  empty: "Write something first.",
  replies: "That comment has as many answers as it can take.",
};

/**
 * The course's newest comments, with an answer box, Hide and Delete on each,
 * and the switch that turns comments on or off for the whole course.
 */
export function CourseCommentsStudio({
  productId,
  storeName,
  initialOn,
  initial,
  lessonHref,
  now,
}: {
  productId: string;
  storeName: string;
  initialOn: boolean;
  initial: StudioComment[];
  /** Where a lesson opens for the creator: its address without the lesson id. */
  lessonHref: string | null;
  /** Seconds, from the server, for "5 min ago". */
  now: number;
}) {
  const [on, setOn] = useState(initialOn);
  const [comments, setComments] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);

  async function act(key: string, payload: Record<string, unknown>): Promise<boolean> {
    setBusy(key);
    setError(null);
    const answer = await post({ id: productId, ...payload });
    setBusy(null);
    if (!answer.ok) setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.");
    return answer.ok;
  }

  return (
    <section id="comments" className="card mt-8 p-6 sm:p-8" aria-labelledby="comments-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="comments-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Comments under lessons</h2>
        <span className={`tag ${on ? "tag-live" : ""}`}>{on ? "On" : "Off"}</span>
      </div>
      <p className="mt-2 max-w-2xl text-ink-soft">
        Students ask questions and share what they made under each lesson, under a name they choose; their email address
        is never shown. Only students of this course and you can read them. Your answers appear under the lesson as {storeName}.
      </p>
      <label className="mt-4 flex min-h-[44px] items-center gap-3 font-semibold text-ink">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={on}
          disabled={busy !== null}
          onChange={async (e) => {
            const next = e.target.checked;
            if (await act("switch", { action: "cm-on", on: next })) setOn(next);
          }}
        />
        Students can comment under lessons
      </label>
      {!on ? (
        <p className="mt-1 text-sm text-ink-soft">Off: every comment is hidden from students and nothing is deleted. Switch it on and they come back.</p>
      ) : null}

      {error ? <p className="notice notice-error mt-4" role="alert">{error}</p> : null}

      {comments.length === 0 ? (
        <p className="mt-6 text-sm text-ink-soft">No comments yet. The newest ones will show here, with a way to answer each.</p>
      ) : (
        <ol className="mt-6 space-y-4">
          {comments.map((c) => (
            <li key={c.id} className={`rounded-2xl border p-4 ${c.hidden ? "border-dashed border-line opacity-70" : "border-line"} bg-paper`}>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-semibold text-ink">{c.fromCreator ? `${storeName} (you)` : c.name || "A student"}</span>
                {c.fresh ? <span className="tag tag-brand">New</span> : null}
                {c.hidden ? <span className="tag">Hidden</span> : null}
                <span className="text-ink-mute">{whenWords(c.at, now)}</span>
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                {c.answerTo !== null ? `Answering ${c.answerTo || "a student"}, under ` : "Under "}
                {lessonHref ? (
                  <a className="underline underline-offset-2" href={`${lessonHref}/${c.lessonId}#c-${c.id}`}>{c.lessonTitle}</a>
                ) : (
                  c.lessonTitle
                )}
              </p>
              <p className="mt-2 whitespace-pre-wrap break-words text-[0.9375rem] text-ink">{c.text}</p>

              {c.answerTo === null && !c.fromCreator && !c.hidden ? (
                answered.has(c.id) ? (
                  <p className="mt-3 text-sm font-semibold text-ink" role="status">Answered. Your reply is under the lesson.</p>
                ) : (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const text = (drafts[c.id] ?? "").trim();
                      if (!text) return setError(MESSAGES.empty);
                      if (await act(`reply-${c.id}`, { action: "cm-reply", comment: c.id, text })) {
                        setAnswered((prev) => new Set(prev).add(c.id));
                        setDrafts((prev) => ({ ...prev, [c.id]: "" }));
                      }
                    }}
                  >
                    <label className="block">
                      <span className="sr-only">{`Your answer to ${c.name || "the student"}`}</span>
                      <textarea
                        className="field"
                        rows={2}
                        maxLength={MAX_LESSON_COMMENT}
                        placeholder={`Answer ${c.name || "the student"}`}
                        value={drafts[c.id] ?? ""}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      />
                    </label>
                    <button type="submit" className="btn btn-secondary btn-sm" disabled={busy !== null}>
                      {busy === `reply-${c.id}` ? "Posting…" : "Post the answer"}
                    </button>
                  </form>
                )
              ) : null}

              <div className="mt-3 flex flex-wrap gap-4 text-sm font-semibold">
                {!c.fromCreator ? (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center text-ink-soft underline underline-offset-4 hover:text-violet-deep"
                    disabled={busy !== null}
                    onClick={async () => {
                      if (await act(`hide-${c.id}`, { action: "cm-hide", comment: c.id, hidden: !c.hidden })) {
                        setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, hidden: !c.hidden } : x)));
                      }
                    }}
                  >
                    {c.hidden ? "Show it again" : "Hide it"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center text-ink-soft underline underline-offset-4 hover:text-danger"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (confirming !== c.id) return setConfirming(c.id);
                    setConfirming(null);
                    if (await act(`delete-${c.id}`, { action: "cm-delete", comment: c.id })) {
                      setComments((prev) => prev.filter((x) => x.id !== c.id && x.parentId !== c.id));
                    }
                  }}
                >
                  {confirming === c.id
                    ? "Press again to delete for good"
                    : c.answerTo === null
                      ? "Delete, with its answers"
                      : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
