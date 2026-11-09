"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "@/components/toast";
import { AiAssist, AiOn } from "@/components/ai-assist";
import { MAX_FEEDBACK, type Submission } from "@/lib/assignment-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

export type StudioWork = {
  lessonId: string;
  lessonTitle: string;
  who: string;
  /** The student's address, when they opened the course; empty when it could not be read. */
  email: string;
  submission: Submission;
};

function day(seconds: number): string {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const STATE: Record<Submission["state"], { label: string; tag: string }> = {
  waiting: { label: "Waiting for you", tag: "tag-next" },
  approved: { label: "Approved", tag: "tag-live" },
  again: { label: "Asked for another try", tag: "" },
};

const ERRORS: Record<string, string> = {
  feedback: "Write what to change before asking for another try, so the student knows what to do.",
  reviewed: "This work was already answered, or handed in again since. Reload the page to see it as it is now.",
  gone: "This work is no longer there: the assignment or the lesson was removed. Reload the page.",
  signed_out: "Your session ended. Log in again.",
};

/** One piece of work: what was handed in, and the answer to it. */
function WorkItem({ productId, row }: { productId: string; row: StudioWork }) {
  const [work, setWork] = useState(row.submission);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"approved" | "again" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = STATE[work.state];

  async function answer(verdict: "approved" | "again") {
    if (verdict === "again" && !feedback.trim()) return setError(ERRORS.feedback);
    setBusy(verdict);
    setError(null);
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review", id: productId, lessonId: row.lessonId, who: row.who, verdict, feedback }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; submission?: Submission; told?: boolean };
      if (!data.ok || !data.submission) {
        setError(ERRORS[data.error ?? ""] ?? STUDIO_MESSAGES[data.error ?? ""] ?? "Something went wrong on our side. Nothing was sent; try again in a moment.");
        return;
      }
      setWork(data.submission);
      toast(
        verdict === "approved"
          ? data.told ? "Approved. The student was emailed." : "Approved."
          : data.told ? "Sent. The student was emailed." : "Saved. The student sees it on the lesson.",
      );
    } catch {
      setError("Something went wrong on our side. Nothing was sent; try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  const prefix = `work-${row.lessonId}-${row.who.slice(0, 8)}`;
  return (
    <li className="rounded-[var(--r-sm)] border border-line bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 break-words font-semibold text-ink">{row.lessonTitle}</p>
        <span className={`tag ${state.tag}`}>{state.label}</span>
      </div>
      <p className="mt-1 break-all text-sm text-ink-soft">
        {[row.email || "A student", `handed in ${day(work.at)}`, work.tries > 1 ? `try ${work.tries}` : null].filter(Boolean).join(" · ")}
      </p>
      {work.text ? (
        <div className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--r-sm)] bg-sand p-3 text-sm text-ink" tabIndex={0}>
          {work.text}
        </div>
      ) : null}
      {work.file ? (
        <a
          href={`/api/store/course/task?id=${productId}&l=${row.lessonId}&w=${row.who}`}
          className="mt-3 inline-block break-all text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
        >
          {`Download ${work.file.name}`}
        </a>
      ) : null}

      {work.state === "waiting" ? (
        <div className="mt-4 border-t border-line pt-4">
          <label className="block">
            <span className="field-label">What you write back</span>
            <textarea
              id={`${prefix}-feedback`}
              className="field mt-2"
              rows={4}
              maxLength={MAX_FEEDBACK}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What works, and what would make it better. The student reads this by email and under the lesson."
            />
          </label>
          <div className="mt-3">
            <AiAssist<string>
              title="Draft a reply with AI"
              hint="From the assignment and what the student wrote, in your store's language. It lands in the box above for you to read and change; nothing is sent until you choose below. AI does not open files."
              placeholder="Optional: what you think of it, in a few words. For example: good structure, but the offer is not clear yet."
              allowEmpty={Boolean(work.text)}
              emptyMessage="The student handed in only a file, which AI does not open. Write what you think of it in a few words, and the reply is drafted from that."
              payload={() => ({ kind: "feedback", id: productId, lessonId: row.lessonId, who: row.who })}
              onResult={(drafted) => setFeedback(drafted)}
              done="The reply is in the box above. Read it, change what you like, then approve or ask for another try."
            />
          </div>
          {error ? (
            <p className="notice notice-error mt-3" role="alert">{error}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} aria-busy={busy === "approved"} onClick={() => answer("approved")}>
              {busy === "approved" ? "Sending…" : "Approve"}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} aria-busy={busy === "again"} onClick={() => answer("again")}>
              {busy === "again" ? "Sending…" : "Ask for another try"}
            </button>
          </div>
        </div>
      ) : work.feedback ? (
        <div className="mt-3 border-t border-line pt-3">
          <p className="field-label">{`You wrote back${work.reviewedAt ? `, ${day(work.reviewedAt)}` : ""}`}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{work.feedback}</p>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The work students handed in for the course's assignments, in the studio:
 * what waits to be read first, oldest first, or everything, newest first.
 */
export function CourseWorkStudio({
  productId,
  rows,
  unread = 0,
  total,
  showing,
  hrefs,
  ai,
}: {
  productId: string;
  rows: StudioWork[];
  /** Work handed in whose record could not be read: said, never left out. */
  unread?: number;
  total: number;
  showing: "waiting" | "all";
  hrefs: { waiting: string; all: string };
  ai: { on: boolean; left: number };
}) {
  return (
    <AiOn value={ai}>
      <section id="work" className="card mt-8 scroll-mt-6 p-6 sm:p-8" aria-labelledby="work-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="work-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Handed-in work</h2>
          <nav className="flex gap-4 text-sm font-bold" aria-label="Which work">
            <Link href={hrefs.waiting} aria-current={showing === "waiting" ? "page" : undefined} className={showing === "waiting" ? "text-ink underline underline-offset-4" : "text-ink-soft hover:text-violet-deep"}>
              Waiting
            </Link>
            <Link href={hrefs.all} aria-current={showing === "all" ? "page" : undefined} className={showing === "all" ? "text-ink underline underline-offset-4" : "text-ink-soft hover:text-violet-deep"}>
              Everything
            </Link>
          </nav>
        </div>
        <p className="mt-2 max-w-2xl text-ink-soft">
          {showing === "waiting"
            ? `What students handed in for your assignments and is waiting for you, oldest first${total > rows.length ? `: the first ${rows.length} of ${total}` : ""}. Approving finishes the lesson for the student; asking for another try sends them what to change.`
            : `Everything students handed in, newest first${total > rows.length ? `: the latest ${rows.length} of ${total}` : ""}.`}
        </p>
        {unread > 0 ? (
          <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft" role="status">
            {`${unread === 1 ? "1 piece of work" : `${unread} pieces of work`} could not be read just now, so it is not shown here. It is still kept; open this page again in a few minutes.`}
          </p>
        ) : null}
        {rows.length === 0 && unread === 0 ? (
          <p className="mt-5 rounded-[var(--r-md)] bg-sand p-5 text-sm text-ink-soft">
            {showing === "waiting" ? "Nothing is waiting. When a student hands in work you read, it is here, and you get an email." : "Nothing handed in yet."}
          </p>
        ) : (
          <ol className="mt-5 space-y-4">
            {rows.map((row) => (
              <WorkItem key={`${row.lessonId}|${row.who}|${row.submission.at}`} productId={productId} row={row} />
            ))}
          </ol>
        )}
      </section>
    </AiOn>
  );
}
