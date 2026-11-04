"use client";

import { useId, useState } from "react";
import { uploadReason, uploadSoldFile } from "@/lib/sold-file-upload";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { MAX_FILE_BYTES, maxFileLabel, readableSize } from "@/lib/product-file";
import { EPISODE_ACCEPT, EPISODE_TYPES, type Episode, MAX_EPISODES, MAX_EPISODE_NOTES, MAX_EPISODE_TITLE, type Podcast } from "@/lib/podcast-rules";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  type: "An episode is an MP3 or an M4A file: the audio every podcast app plays.",
  too_big: `That file is over ${maxFileLabel()}.`,
  title: "Give the episode a title.",
  too_many: `A podcast holds up to ${MAX_EPISODES} episodes.`,
  not_empty: "Delete its episodes first.",
  busy: "The podcast is being changed right now. Try again in a moment.",
  unknown: "That episode is no longer there. Reload the page.",
};

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

/** A private podcast's episodes: put one out, change its words, take one away. */
export function PodcastEditor({ productId, folder, initial }: { productId: string; folder: string; initial: Podcast }) {
  const [podcast, setPodcast] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  async function run(payload: Record<string, unknown>, done: string): Promise<boolean> {
    setError(null);
    const answer = await post({ id: productId, ...payload });
    if (answer.ok && answer.podcast) {
      setPodcast(answer.podcast);
      toast(done);
      return true;
    }
    setError(MESSAGES[answer.error ?? ""] ?? MESSAGES.server_error ?? "Something went wrong. Try again.");
    return false;
  }

  async function publish() {
    if (!file) return;
    if (!(EPISODE_TYPES as readonly string[]).includes(file.type)) return setError(MESSAGES.type);
    if (file.size > MAX_FILE_BYTES) return setError(MESSAGES.too_big);
    if (!title.trim()) return setError(MESSAGES.title);
    setPercent(0);
    setError(null);
    try {
      const pathname = await uploadSoldFile(file, { folder, ownerId: productId }, setPercent);
      if (await run({ action: "add", pathname, title, notes }, "Episode out. It reaches every listener's app the next time it checks.")) {
        setTitle("");
        setNotes("");
        setFile(null);
      }
    } catch (thrown) {
      const reason = uploadReason(thrown);
      setError(reason === "wrong_type" ? MESSAGES.type : MESSAGES[reason] ?? MESSAGES.server_error ?? "Something went wrong.");
    } finally {
      setPercent(null);
    }
  }

  const newest = [...podcast.episodes].sort((a, b) => b.at - a.at);

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
            <input className="field mt-1" type="file" accept={EPISODE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={!file || percent !== null} onClick={() => void publish()}>
            {percent !== null ? `Uploading… ${Math.round(percent)}%` : "Put the episode out"}
          </button>
        </div>
      </section>

      <section className="card p-6 sm:p-8" aria-labelledby="episodes">
        <h2 id="episodes" className="text-lg font-semibold tracking-[-0.02em] text-ink">{`Episodes (${podcast.episodes.length})`}</h2>
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
