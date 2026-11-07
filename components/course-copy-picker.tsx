"use client";

import { useId, useState } from "react";
import type { Course } from "@/lib/course";
import { COPY_ABOUT, COPY_CONFIRM, COPY_HIDES, copyCostWords } from "@/lib/course-copy-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";

/** What a refused copy says, in the studio's words; the server's own sentence when it sent one (studio requests used). */
const COPY_MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  same: "Choose another course: a course cannot be copied into itself.",
  unknown: "That course is not there anymore. Reload the page.",
  not_course: "That product is no longer a course. Reload the page.",
  not_new: "This course has changed since the page was drawn, so nothing was copied into it. Reload the page.",
  confirm: "Check the box to say this course may leave your store, then copy again. Nothing was copied.",
  not_hidden: "This course could not be taken off your store, so nothing was copied. Try again in a moment.",
  busy: "Another change to this course is still saving. Try again in a moment.",
  studio_used: "Your studio requests for this month are used, so nothing was copied.",
  unavailable: "This can't be counted right now, so nothing was copied. Try again in a minute.",
  store_full: "Your store's data room is full, so nothing was copied. Delete something you no longer need, such as old posts, drafts, pages or contacts.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Something went wrong on our side. Reload the page to see whether the course was copied.",
};

type Answer = { ok?: boolean; error?: string; message?: string; needed?: number; course?: Course; words?: string };

/**
 * "Copy one of your courses", offered on a new course next to the ready
 * structures (294 [SQ5], unit 1): the store's other courses by name, what
 * comes across and what does not, and what it counts, all said before the
 * button, and that the course leaves the store, with a yes for one on it.
 * Only the other course's product id and that yes are sent; the server copies it
 * (lib/course-copy.ts). The editor shows this only while copyFits says
 * the course is exactly as it was made.
 */
export function CourseCopyPicker({
  productId,
  courses,
  community,
  onStore,
  busy,
  onCopied,
}: {
  productId: string;
  /** Whether the store has a community, whose search the copy counts too. */
  community: boolean;
  /** Whether the course is on the store now: the copy takes it off, so the creator says yes first. */
  onStore: boolean;
  /** The store's other courses, by product id and name. */
  courses: { id: string; title: string }[];
  /** Whether the editor is saving something else. */
  busy: boolean;
  onCopied: (kept: Course, words: string) => void;
}) {
  const id = useId();
  const [from, setFrom] = useState(courses[0]?.id ?? "");
  const [working, setWorking] = useState(false);
  const [said, setSaid] = useState("");
  const [agreed, setAgreed] = useState(false);
  const chosen = courses.find((course) => course.id === from) ?? null;
  const stopped = busy || working;

  async function copy() {
    if (stopped || !chosen) return;
    setWorking(true);
    setSaid("");
    let answer: Answer;
    try {
      const response = await fetch("/api/store/course", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "copy", id: productId, from: chosen.id, confirm: onStore ? agreed : false }),
      });
      answer = (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
    } catch {
      answer = { ok: false, error: "server_error" };
    }
    setWorking(false);
    if (answer.ok && answer.course) {
      onCopied(answer.course, answer.words ?? "");
      return;
    }
    const known = COPY_MESSAGES[answer.error ?? ""] ?? COPY_MESSAGES.server_error;
    if (answer.error === "index_used" && answer.needed) {
      setSaid(`Adding this course's lessons to your community's search needs ${answer.needed.toLocaleString("en-US")} more studio requests. ${answer.message ?? ""} Nothing was copied.`.replace(/\s+/g, " "));
    } else setSaid(answer.error === "studio_used" && answer.message ? `${answer.message} Nothing was copied.` : known);
  }

  if (!courses.length) return null;
  return (
    <section className="card p-6 sm:p-8" aria-labelledby={`${id}-title`} data-course-copy>
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Copy one of your courses
      </h2>
      <p className="mt-2 max-w-2xl text-ink-soft">{COPY_ABOUT}</p>
      <p className="mt-2 max-w-2xl text-ink-soft">{copyCostWords(community)}</p>
      <p className="mt-2 max-w-2xl font-semibold text-ink">{COPY_HIDES}</p>
      <div className="mt-4 max-w-xl">
        <label htmlFor={`${id}-from`} className="field-label">
          Course to copy
        </label>
        <select
          id={`${id}-from`}
          className="field mt-1 min-h-11 w-full"
          value={from}
          aria-disabled={stopped || undefined}
          onChange={(event) => { if (!stopped) setFrom(event.target.value); }}
        >
          {courses.map((course) => (
            <option key={course.id} value={course.id}>
              {course.title}
            </option>
          ))}
        </select>
      </div>
      {/* On the store now: taking it off is the creator's yes, checked again on the server. */}
      {onStore ? (
        <label className="mt-4 flex min-h-11 max-w-xl items-start gap-3">
          <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={agreed} onChange={(event) => { if (!stopped) setAgreed(event.target.checked); }} />
          <span className="text-ink">{COPY_CONFIRM}</span>
        </label>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={stopped || undefined} aria-busy={working} onClick={copy}>
          {chosen ? `Copy “${chosen.title}” into this course` : "Copy into this course"}
        </button>
      </div>
      {/* Said in a live region, so a screen reader hears why nothing was copied. */}
      <p role="status" className="mt-3 text-sm font-semibold text-ink">
        {working ? "Copying…" : said}
      </p>
    </section>
  );
}
