"use client";

import { useEffect, useId, useRef, useState } from "react";
import { uploadReason, uploadSoldFile } from "@/lib/sold-file-upload";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { MAX_FILE_BYTES, maxFileLabel, readableSize } from "@/lib/product-file";
import {
  EPISODE_ACCEPT,
  EPISODE_TYPES,
  type Episode,
  MAX_EPISODES,
  MAX_EPISODE_NOTES,
  MAX_EPISODE_TITLE,
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_LABEL,
  type Podcast,
  TRANSCRIPT_ACCEPT,
  isTranscriptType,
  untranscribed,
} from "@/lib/podcast-rules";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  type: "An episode is an MP3 or an M4A file: the audio every podcast app plays.",
  too_big: `That file is over ${maxFileLabel()}.`,
  title: "Give the episode a title.",
  too_many: `A podcast holds up to ${MAX_EPISODES} episodes.`,
  not_empty: "Delete its episodes first.",
  busy: "The podcast is being changed right now. Try again in a moment.",
  unknown: "That episode is no longer there. Reload the page.",
  // The same audio is another episode's already (app/api/store/podcast).
  in_use: "That audio file is already another episode. Choose the file from your device again.",
};

/** What a refused transcript is told: the same server words mean a text file here, not audio (274 [AX1] Part B.3). */
const TRANSCRIPT_MESSAGES: Record<string, string> = {
  ...MESSAGES,
  type: "A transcript is a plain text file (.txt).",
  wrong_type: "A transcript is a plain text file (.txt).",
  too_big: `A transcript can be up to ${MAX_TRANSCRIPT_LABEL}.`,
  in_use: "That file is already an episode's audio or transcript. Choose the file from your device again.",
};

/** How long "Press again to remove the transcript" waits for the second press before it goes back. */
const CONFIRM_FOR_MS = 5000;

/** The words of a file that is not a transcript, checked in the browser before anything is uploaded; null when it is one. */
function transcriptProblem(file: File): string | null {
  if (!isTranscriptType(file.type) && !/\.txt$/i.test(file.name)) return TRANSCRIPT_MESSAGES.type;
  if (file.size > MAX_TRANSCRIPT_BYTES) return TRANSCRIPT_MESSAGES.too_big;
  return null;
}

type Answer = { ok: boolean; error?: string; podcast?: Podcast };

async function post(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/podcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as Answer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * A private podcast's episodes: put one out, change its words, give it a
 * transcript, take one away. Episodes with no transcript are counted, with
 * why one matters (274 [AX1] Part A item 6 and Part B.3).
 */
export function PodcastEditor({ productId, folder, initial }: { productId: string; folder: string; initial: Podcast }) {
  const [podcast, setPodcast] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [words, setWords] = useState<File | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const formId = useId();
  // Bumped once an episode is out, so the file fields empty with it instead of showing a file that is no longer chosen.
  const [round, setRound] = useState(0);

  async function run(payload: Record<string, unknown>, done: string, messages = MESSAGES): Promise<Podcast | null> {
    setError(null);
    const answer = await post({ id: productId, ...payload });
    if (answer.ok && answer.podcast) {
      setPodcast(answer.podcast);
      toast(done);
      return answer.podcast;
    }
    setError(messages[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.");
    return null;
  }

  /** Uploads a transcript and gives it to one episode; the words of what went wrong, or null. */
  async function sendTranscript(episodeId: string, chosen: File): Promise<string | null> {
    const problem = transcriptProblem(chosen);
    if (problem) return problem;
    try {
      const pathname = await uploadSoldFile(chosen, { folder, ownerId: productId }, () => {});
      const answer = await post({ id: productId, action: "transcript", episode: episodeId, pathname });
      if (answer.ok && answer.podcast) {
        setPodcast(answer.podcast);
        return null;
      }
      return TRANSCRIPT_MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.";
    } catch (thrown) {
      return TRANSCRIPT_MESSAGES[uploadReason(thrown)] ?? MESSAGES.server_error ?? "Something went wrong.";
    }
  }

  async function publish() {
    if (!file) return;
    if (!(EPISODE_TYPES as readonly string[]).includes(file.type)) return setError(MESSAGES.type);
    if (file.size > MAX_FILE_BYTES) return setError(MESSAGES.too_big);
    if (!title.trim()) return setError(MESSAGES.title);
    // Checked before the episode goes out, so a wrong transcript never leaves an episode out without the one chosen.
    const problem = words ? transcriptProblem(words) : null;
    if (problem) return setError(problem);
    setPercent(0);
    setError(null);
    try {
      const pathname = await uploadSoldFile(file, { folder, ownerId: productId }, setPercent);
      const out = await run({ action: "add", pathname, title, notes }, "Episode out. It reaches every listener's app the next time it checks.");
      if (out) {
        setTitle("");
        setNotes("");
        setFile(null);
        // Found by the audio just uploaded, which no other episode can name (app/api/store/podcast refuses one that
        // does), never by what is new in the list: another tab may have put an episode out a moment before.
        const added = out.episodes.find((episode) => episode.pathname === pathname);
        if (words && !added) {
          setError("The episode is out, but its transcript was not added: the new episode is not in the list yet. Reload the page, then add it from the episode in the list below.");
        } else if (words && added) {
          const failed = await sendTranscript(added.id, words);
          if (failed) setError(`The episode is out, but its transcript was not added. ${failed} You can add it from the episode in the list below.`);
          else toast("Transcript added.");
        }
        setWords(null);
        setRound((n) => n + 1);
      }
    } catch (thrown) {
      const reason = uploadReason(thrown);
      setError(reason === "wrong_type" ? MESSAGES.type : MESSAGES[reason] ?? MESSAGES.server_error ?? "Something went wrong.");
    } finally {
      setPercent(null);
    }
  }

  const newest = [...podcast.episodes].sort((a, b) => b.at - a.at);
  const missing = untranscribed(podcast.episodes);

  return (
    <div className="mt-8 space-y-6">
      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}

      <section className="card p-6 sm:p-8" aria-labelledby="new-episode">
        <h2 id="new-episode" className="text-lg font-semibold tracking-[-0.02em] text-ink">A new episode</h2>
        <p className="mt-2 text-sm text-ink-soft">An MP3 or M4A file, up to {maxFileLabel()}. It goes out as soon as it is uploaded, dated today.</p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="field-label">Title</span>
            <input className="field mt-1" maxLength={MAX_EPISODE_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Episode 1: Your first starter" />
          </label>
          <label className="block">
            <span className="field-label">Notes (optional)</span>
            <textarea className="field mt-1" rows={3} maxLength={MAX_EPISODE_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What it covers, and anything the listener needs." />
          </label>
          <label className="block">
            <span className="field-label">The audio</span>
            <input key={`audio-${round}`} className="field mt-1" type="file" accept={EPISODE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div>
            <label htmlFor={`${formId}-words`} className="field-label">Transcript (optional)</label>
            <input key={`words-${round}`} id={`${formId}-words`} className="field mt-1" type="file" accept={TRANSCRIPT_ACCEPT} aria-describedby={`${formId}-words-hint`} onChange={(e) => setWords(e.target.files?.[0] ?? null)} />
            <p id={`${formId}-words-hint`} className="mt-1 text-sm text-ink-soft">{`Everything said in the episode, as a plain text file (.txt), up to ${MAX_TRANSCRIPT_LABEL}. You can also add it later.`}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={!file || percent !== null} onClick={() => void publish()}>
            {percent !== null ? `Uploading… ${Math.round(percent)}%` : "Put the episode out"}
          </button>
        </div>
      </section>

      <section className="card p-6 sm:p-8" aria-labelledby="episodes">
        <h2 id="episodes" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Episodes (${podcast.episodes.length})`}</h2>
        {missing > 0 ? (
          <div className="notice notice-info mt-3">
            <p className="font-semibold text-ink">{missing === 1 ? "1 episode has no transcript" : `${missing} episodes have no transcript`}</p>
            <p className="mt-1 text-sm">
              {`A transcript is everything said in the episode, as text. It lets listeners who are deaf or hard of hearing, or who cannot play sound, follow along. Add it to an episode below as a plain text file (.txt). Podcast apps that show transcripts show it with the episode.`}
            </p>
          </div>
        ) : null}
        {newest.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">None yet. The podcast goes on sale once it has one.</p>
        ) : (
          <ol className="mt-4 divide-y divide-line">
            {newest.map((episode: Episode) => (
              <li key={episode.id} className="py-4">
                {editing === episode.id ? (
                  <EpisodeForm
                    episode={episode}
                    onCancel={() => setEditing(null)}
                    onSave={async (t, n) => {
                      if (await run({ action: "edit", episode: episode.id, title: t, notes: n }, "Saved.")) setEditing(null);
                    }}
                  />
                ) : (
                  <>
                    <p className="font-semibold text-ink">{episode.title}</p>
                    <p className="text-xs text-ink-soft">{`${when(episode.at)} · ${readableSize(episode.bytes)}`}</p>
                    {episode.notes ? <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{episode.notes}</p> : null}
                    <EpisodeTranscript
                      episode={episode}
                      onSend={(chosen) => sendTranscript(episode.id, chosen)}
                      onRemove={() => run({ action: "transcript", episode: episode.id, remove: true }, "Transcript removed.", TRANSCRIPT_MESSAGES).then((done) => done !== null)}
                    />
                    <div className="mt-2 flex flex-wrap gap-4 text-sm font-semibold">
                      <button type="button" className="text-ink-soft underline underline-offset-4 hover:text-violet-deep" onClick={() => setEditing(episode.id)}>
                        Change its words
                      </button>
                      <button
                        type="button"
                        className="text-ink-soft underline underline-offset-4 hover:text-danger"
                        onClick={async () => {
                          if (confirming !== episode.id) return setConfirming(episode.id);
                          setConfirming(null);
                          await run({ action: "remove", episode: episode.id }, "Episode deleted, with its audio.");
                        }}
                      >
                        {confirming === episode.id ? "Press again to delete it and its audio" : "Delete"}
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/**
 * One episode's transcript: whether it has one, and a file field to add or
 * replace it, with a button that sends it only when pressed (WCAG 3.2.2), and
 * a removal that asks twice, as deleting an episode does. Each control's name
 * ends with the episode's title, after the words on screen (WCAG 2.4.6, 2.5.3),
 * so a list of controls read out of the page still says which episode each is.
 */
function EpisodeTranscript({ episode, onSend, onRemove }: { episode: Episode; onSend: (file: File) => Promise<string | null>; onRemove: () => Promise<boolean> }) {
  const [chosen, setChosen] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const [round, setRound] = useState(0);
  // Set while a removal is asked for, so focus moves to the field that adds one once it is drawn (WCAG 2.4.3).
  const toField = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const has = episode.transcript !== null;
  const named = (to: string) => <span className="sr-only">{` ${to} “${episode.title}”`}</span>;

  // The second press is asked for only a few seconds; then the button goes back (as it does when focus leaves it).
  useEffect(() => {
    if (!sure) return;
    const back = window.setTimeout(() => setSure(false), CONFIRM_FOR_MS);
    return () => window.clearTimeout(back);
  }, [sure]);

  useEffect(() => {
    if (has || !toField.current) return;
    toField.current = false;
    field.current?.focus();
  }, [has]);

  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm text-ink-soft">{episode.transcript ? `Transcript added (${readableSize(episode.transcript.bytes)})` : "No transcript yet."}</p>
      <div>
        <label htmlFor={`${id}-file`} className="field-label">
          {has ? "Replace the transcript (.txt)" : "Add a transcript (.txt)"}
          {named(has ? "of" : "to")}
        </label>
        <input ref={field} key={round} id={`${id}-file`} className="field mt-1" type="file" accept={TRANSCRIPT_ACCEPT} onChange={(e) => { setProblem(null); setChosen(e.target.files?.[0] ?? null); }} />
      </div>
      {problem ? <p className="notice notice-error text-sm" role="alert">{problem}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!chosen || busy}
          onClick={async () => {
            if (!chosen) return;
            setBusy(true);
            const failed = await onSend(chosen);
            setBusy(false);
            setProblem(failed);
            if (!failed) {
              setChosen(null);
              setRound((n) => n + 1);
              toast(has ? "Transcript replaced." : "Transcript added.");
            }
          }}
        >
          {busy ? "Uploading…" : has ? "Upload the new transcript" : "Upload the transcript"}
          {named("for")}
        </button>
        {has ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onBlur={() => setSure(false)}
            onClick={async () => {
              if (!sure) return setSure(true);
              setSure(false);
              setBusy(true);
              toField.current = true;
              if (!(await onRemove())) toField.current = false;
              setBusy(false);
            }}
          >
            {sure ? "Press again to remove the transcript" : "Remove the transcript"}
            {named("of")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EpisodeForm({ episode, onSave, onCancel }: { episode: Episode; onSave: (title: string, notes: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState(episode.title);
  const [notes, setNotes] = useState(episode.notes);
  // Visible labels (487 [IT4], item 4): a name only a screen reader hears is no label for anyone else.
  const id = useId();
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`${id}-title`} className="field-label">Episode title</label>
        <input id={`${id}-title`} className="field mt-1" maxLength={MAX_EPISODE_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-notes`} className="field-label">Episode notes</label>
        <textarea id={`${id}-notes`} className="field mt-1" rows={3} maxLength={MAX_EPISODE_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="flex gap-3">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void onSave(title, notes)}>Save</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
