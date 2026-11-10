"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_SUBMISSION_NOTE, MAX_WAITING_PER_BUYER, SUBMISSION_KINDS, type SubmissionSetup, submissionAccept } from "@/lib/submission-rules";
import { checkChosenFile, freshReplyIds, postSubmissionDoor, readSeenReplies, seenRepliesKey, seenRepliesValue, sendSubmission, type SubmissionPlace } from "@/lib/submission-upload";
import { type SubmissionsWords, submissionsWords } from "@/lib/buyer-words/submissions";
import { LANGUAGES, type LanguageCode, parseLanguage } from "@/lib/store-language";

/** One of the buyer's own files on the lesson, as the door lists it (lib/submission-store.ts, MineRow). */
type Row =
  | { id: string; state: "uploading"; file: { name: string; bytes: number; type: string }; at: number; pathname: string }
  | {
      id: string;
      state: "submitted" | "reviewed" | "withdrawn" | "unknown";
      file: { name: string; bytes: number; type: string };
      note: string;
      at: number;
      keepUntil: number;
      reply: { text: string; at: number } | null;
    }
  | { id: string; state: "unread" };

/** The list, with the time it was read: a file's keeping time is set against that, not against each render. */
type List = "loading" | "failed" | "resting" | { rows: Row[]; now: number };

const MiB = 1024 * 1024;

/** The door's answer to "mine", with the time it came: anything but a list is said as not loaded, never as none. */
function listOf(answer: Record<string, unknown>): List {
  if (answer.ok === true && Array.isArray(answer.submissions)) return { rows: answer.submissions as Row[], now: Date.now() };
  return answer.error === "resting" ? "resting" : "failed";
}

/** A file's size the way the store says sizes: whole megabytes, or gigabytes with one decimal when not whole. */
function sizeText(bytes: number, locale: string, w: SubmissionsWords): string {
  if (bytes >= 1024 * MiB) {
    const gb = Math.round((bytes / (1024 * MiB)) * 10) / 10;
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gb)} ${w.sizeUnits.gb}`;
  }
  const mb = bytes / MiB;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: mb < 10 ? 1 : 0 }).format(mb < 0.1 ? 0.1 : mb)} ${w.sizeUnits.mb}`;
}

/**
 * A lesson's request for the buyer's own work, sent for the creator to
 * review (750 [CD1] unit 5): what the creator asks, the kinds of file and
 * the largest one taken, how long a file is kept, a file picker checked
 * before anything is sent, the upload with its progress and a Stop that
 * gives it up, and the buyer's own files on the lesson with where each
 * stands, the creator's reply, and a withdrawal checked before it is sent.
 *
 * Shown by the lesson page only while lib/submission-switch.ts is on, for a
 * student with the lesson open on a paid course. No time limit anywhere.
 * Said in the store's `language` (lib/buyer-words/submissions.ts).
 */
export function LessonSubmission({
  setup,
  where,
  storeName,
  language = "en",
}: {
  setup: SubmissionSetup | "unknown";
  where: SubmissionPlace;
  storeName: string;
  language?: LanguageCode;
}) {
  const w = submissionsWords(language);
  const locale = LANGUAGES[parseLanguage(language)].locale;
  const day = (seconds: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(seconds * 1000));
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [list, setList] = useState<List>("loading");
  const [asking, setAsking] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** Replies this device had not shown before this visit (unit 6): marked "New reply" until the page is left. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const picker = useRef<HTMLInputElement>(null);
  const stop = useRef<AbortController | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const question = useRef<HTMLParagraphElement>(null);

  const kinds = setup === "unknown" ? "" : new Intl.ListFormat(locale, { type: "disjunction" }).format(SUBMISSION_KINDS.filter((kind) => setup.kinds.includes(kind)).map((kind) => w.kinds[kind]));
  const largest = setup === "unknown" ? "" : sizeText(setup.maxBytes, locale, w);

  /**
   * The list as it came, with the replies this device has not shown yet
   * marked, then remembered as shown. What the browser keeps is only reply
   * ids; when it cannot be read or written, no badge is guessed and the
   * replies show as always.
   */
  function shown(next: List) {
    setList(next);
    if (typeof next === "string") return;
    const key = seenRepliesKey(where);
    let seen: Set<string> | null = null;
    try {
      seen = readSeenReplies(window.localStorage.getItem(key));
    } catch {
      seen = null;
    }
    const added = freshReplyIds(next.rows, seen);
    const present = new Set(next.rows.map((row) => row.id));
    setFresh((before) => new Set([...before, ...added].filter((id) => present.has(id))));
    try {
      window.localStorage.setItem(key, seenRepliesValue(next.rows));
    } catch {
      // Not kept on this device: the badge may show again next time, and nothing else changes.
    }
  }

  async function load() {
    setList("loading");
    shown(listOf(await postSubmissionDoor({ action: "mine", ...where })));
  }

  useEffect(() => {
    // Read once when the box is first shown; again only when the buyer asks or after a change.
    if (setup === "unknown") return;
    let mounted = true;
    void postSubmissionDoor({ action: "mine", ...where }).then((answer) => {
      if (mounted) shown(listOf(answer));
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (asking) question.current?.focus();
  }, [asking]);

  /** The door's own word, said in plain words. */
  function reasonText(reason: string): string {
    if (reason === "type") return w.wrongType(kinds);
    if (reason === "size") return w.tooBig(largest);
    if (reason === "empty") return w.empty;
    if (reason === "busy") return w.busy(MAX_WAITING_PER_BUYER);
    if (reason === "slow") return w.slow;
    if (reason === "room" || reason === "pending" || reason === "full" || reason === "plan" || reason === "upload_budget_unavailable") return w.noRoom(storeName);
    if (reason === "resting") return w.resting(storeName);
    if (reason === "signed-out" || reason === "signed_out") return w.signedOut;
    if (reason === "not-buyer" || reason === "owner" || reason === "off") return w.notBuyer;
    if (reason === "unknown" || reason === "unavailable") return w.unknown;
    return w.failed;
  }

  function choose(chosen: File | undefined) {
    setError(null);
    setSaid(null);
    if (!chosen || setup === "unknown") return setFile(null);
    const checked = checkChosenFile(setup, { name: chosen.name, size: chosen.size, type: chosen.type });
    if (!checked.ok) {
      setFile(null);
      if (picker.current) picker.current.value = "";
      return setError(reasonText(checked.reason));
    }
    setFile(chosen);
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (setup === "unknown" || !file) return;
    setError(null);
    setSaid(null);
    setPercent(0);
    const controller = new AbortController();
    stop.current = controller;
    const result = await sendSubmission(file, setup, where, note, {
      signal: controller.signal,
      // Said in steps of ten, so a screen reader is not talked over.
      onProgress: (value) => setPercent(Math.floor(value / 10) * 10),
    });
    stop.current = null;
    setPercent(null);
    if (result.ok) {
      setFile(null);
      setNote("");
      if (picker.current) picker.current.value = "";
      setSaid(w.sent(storeName));
      status.current?.focus();
      void load();
    } else if (result.reason === "stopped" || result.reason === "stopped_unconfirmed") {
      // "Nothing was kept" only when the door confirmed it; otherwise said as not confirmed (review of #3574).
      setSaid(result.reason === "stopped" ? w.stopped : w.stoppedUnconfirmed);
      status.current?.focus();
      void load();
    } else {
      // Said as an alert where the form is; focus stays where the buyer is.
      setError(reasonText(result.reason));
    }
  }

  async function withdraw(row: Extract<Row, { note: string }>) {
    setWorking(row.id);
    setListError(null);
    const answer = await postSubmissionDoor({ action: "withdraw", id: row.id, ...where });
    setWorking(null);
    if (answer.ok) {
      setAsking(null);
      // Its file is said deleted only when the door confirmed it; otherwise it is due to be deleted (the sweep).
      setSaid(answer.deleted === true ? w.withdrawn(row.file.name) : w.withdrawnPending(row.file.name));
      status.current?.focus();
      void load();
      // Not withdrawn: the question stays open, with the reason said as an alert, and focus stays on its button.
    } else setListError(answer.error === "state" || answer.error === "expired" ? w.withdrawLate : answer.error === "resting" ? w.resting(storeName) : w.withdrawFailed);
  }

  async function cancelUpload(row: Extract<Row, { state: "uploading" }>) {
    setWorking(row.id);
    setListError(null);
    const answer = await postSubmissionDoor({ action: "abort", pathname: row.pathname, ...where });
    setWorking(null);
    if (answer.ok) {
      setSaid(w.uploadCanceled);
      status.current?.focus();
      void load();
    } else setListError(answer.error === "resting" ? w.resting(storeName) : w.cancelFailed);
  }

  const sending = percent !== null;

  return (
    <section id="submission" className="mt-8 scroll-mt-6 rounded-2xl px-5 py-5" style={{ border: "1px solid var(--st-line)" }} aria-labelledby="submission-title">
      <h2 id="submission-title" className="font-display text-xl font-semibold">{w.heading}</h2>
      {setup === "unknown" ? (
        <p className="st-note mt-3 text-sm" role="status">{w.unloadedSetup}</p>
      ) : (
        <>
          <p className="mt-3 whitespace-pre-wrap break-words" style={{ color: "var(--st-text)" }}>{setup.instruction}</p>
          <ul className="st-muted mt-3 space-y-1 text-sm">
            <li>{`${w.accepts} ${kinds}`}</li>
            <li>{w.largest(largest)}</li>
            <li>{w.keptFor(storeName, setup.keepDays)}</li>
            <li>{w.privateLine(storeName)}</li>
          </ul>

          <form className="mt-4" onSubmit={send}>
            <label htmlFor="submission-file" className="st-label block">{w.fileLabel}</label>
            <input
              ref={picker}
              id="submission-file"
              type="file"
              accept={submissionAccept(setup)}
              className="mt-2 block min-h-11 w-full text-sm"
              disabled={sending}
              aria-describedby="submission-file-hint"
              aria-invalid={error !== null && file === null ? true : undefined}
              onChange={(event) => choose(event.target.files?.[0])}
            />
            <span id="submission-file-hint" className="st-muted mt-1 block text-xs">{`${w.accepts} ${kinds}. ${w.largest(largest)}`}</span>
            {file ? <p className="mt-2 break-all text-sm" style={{ color: "var(--st-text)" }}>{w.chosen(file.name, sizeText(file.size, locale, w))}</p> : null}

            <label htmlFor="submission-note" className="st-label mt-4 block">{w.noteLabel}</label>
            <textarea
              id="submission-note"
              className="st-field mt-2"
              rows={3}
              maxLength={MAX_SUBMISSION_NOTE}
              value={note}
              disabled={sending}
              aria-describedby="submission-note-hint"
              onChange={(event) => setNote(event.target.value)}
            />
            <span id="submission-note-hint" className="st-muted mt-1 block text-xs">{w.noteHint(MAX_SUBMISSION_NOTE)}</span>

            {sending ? (
              <div className="mt-4">
                <progress className="block w-full" max={100} value={percent ?? 0} aria-labelledby="submission-progress" />
                <p id="submission-progress" className="st-muted mt-1 text-sm" role="status" aria-live="polite">{w.progress(percent ?? 0)}</p>
              </div>
            ) : null}

            {error ? <p className="st-note mt-4 text-sm" role="alert">{error}</p> : null}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {sending ? (
                <button type="button" className="btn st-btn" onClick={() => stop.current?.abort()}>{w.stop}</button>
              ) : (
                <button type="submit" className="btn st-btn" disabled={!file} aria-disabled={!file}>{w.send}</button>
              )}
            </div>
          </form>

          {/* Always there, so what it says is announced; seen only when it says something. */}
          <p ref={status} tabIndex={-1} className={said ? "st-note mt-4 text-sm" : "sr-only"} role="status">{said ?? ""}</p>

          <h3 id="submission-list-title" className="mt-6 font-semibold">{w.listHeading}</h3>
          {fresh.size > 0 ? <p className="mt-1 text-sm font-semibold">{w.newReplies(fresh.size)}</p> : null}
          {listError ? <p className="st-note mt-2 text-sm" role="alert">{listError}</p> : null}
          {list === "loading" ? (
            <p className="st-muted mt-2 text-sm" role="status">{w.loading}</p>
          ) : list === "failed" || list === "resting" ? (
            <div className="mt-2" role="alert">
              <p className="text-sm">{list === "resting" ? w.resting(storeName) : w.loadFailed}</p>
              <button type="button" className="btn st-btn mt-2" onClick={() => void load()}>{w.retry}</button>
            </div>
          ) : list.rows.length === 0 ? (
            <p className="st-muted mt-2 text-sm">{w.none}</p>
          ) : (
            <ul className="mt-2 space-y-3" aria-labelledby="submission-list-title">
              {list.rows.map((row) =>
                row.state === "unread" ? (
                  <li key={row.id} className="rounded-xl px-4 py-3 text-sm" style={{ border: "1px solid var(--st-line)" }}>{w.unread}</li>
                ) : (
                  <li key={row.id} className="rounded-xl px-4 py-3 text-sm" style={{ border: "1px solid var(--st-line)" }}>
                    <p className="break-all font-semibold" style={{ color: "var(--st-text)" }}>{row.file.name}</p>
                    <p className="st-muted mt-1">{`${sizeText(row.file.bytes, locale, w)} · ${w.sentOn(day(row.at))}`}</p>
                    <p className="mt-1 font-semibold">
                      {w.states[row.state]}
                      {fresh.has(row.id) ? (
                        <span className="st-label ml-2 inline-block rounded-full px-2 py-0.5" style={{ border: "1px solid var(--st-text)", color: "var(--st-text)" }}>{w.newReply}</span>
                      ) : null}
                    </p>
                    {row.state === "uploading" ? (
                      <button type="button" className="btn st-btn mt-2" disabled={working === row.id} aria-busy={working === row.id} onClick={() => void cancelUpload(row)}>
                        {working === row.id ? w.working : w.cancelUpload(row.file.name)}
                      </button>
                    ) : (
                      <>
                        <p className="st-muted mt-1">{row.keepUntil * 1000 > list.now ? w.keptUntil(day(row.keepUntil)) : w.keepingEnded(day(row.keepUntil))}</p>
                        {row.note ? (
                          <div className="mt-2">
                            <p className="st-label">{w.yourNote}</p>
                            <p className="mt-1 whitespace-pre-wrap break-words">{row.note}</p>
                          </div>
                        ) : null}
                        {row.reply ? (
                          <div className="mt-2 rounded-xl px-4 py-3" style={{ background: "var(--st-item)", border: "1px solid var(--st-line)" }}>
                            <p className="st-label">{w.replyFrom(storeName)}</p>
                            <p className="mt-1 whitespace-pre-wrap break-words" style={{ color: "var(--st-text)" }}>{row.reply.text}</p>
                          </div>
                        ) : null}
                        {row.state === "submitted" && row.keepUntil * 1000 > list.now ? (
                          asking === row.id ? (
                            <div className="mt-3">
                              <p ref={question} tabIndex={-1} className="font-semibold">{w.withdrawAsk(row.file.name)}</p>
                              <div className="mt-2 flex flex-wrap gap-3">
                                <button type="button" className="btn st-btn" disabled={working === row.id} aria-busy={working === row.id} onClick={() => void withdraw(row)}>
                                  {working === row.id ? w.working : w.withdrawYes}
                                </button>
                                <button type="button" className="btn st-btn" disabled={working === row.id} onClick={() => setAsking(null)}>{w.withdrawNo}</button>
                              </div>
                            </div>
                          ) : (
                            <button type="button" className="btn st-btn mt-2" onClick={() => setAsking(row.id)}>{w.withdraw(row.file.name)}</button>
                          )
                        ) : null}
                      </>
                    )}
                  </li>
                ),
              )}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
