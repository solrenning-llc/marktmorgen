"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { PUBLIC_CATEGORIES } from "@/lib/podcast-public-feed";
import type { Episode } from "@/lib/podcast-rules";

/**
 * A podcast's public feed in the studio (33 [F2], part 3): turn it on or off, and choose, one episode at a time,
 * which go in it. Nothing is public by itself: turning it on puts no episode in it, and the creator first checks a box saying
 * they understand the feed is public. The server (app/api/store/podcast/public-settings) checks each of these again.
 */
const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  understood: "Check the box to say you understand that this feed is public.",
  category: "Choose a category.",
  explicit: "Say whether the show has explicit content.",
  private: "This product is a draft. Publish it first. A draft never has a public feed.",
  not_podcast: "This product is not a podcast.",
  not_https: "The audio address must start with https://.",
  too_long: "That address is too long.",
  ours: "That address is on Marktmorgen, where the audio is private to your buyers. Use the address where the episode is already published for everyone, such as your podcast host's.",
  buyer_data: "That address holds something that could name a buyer, so it cannot go in a public feed.",
  off: "Turn on the public feed first.",
  unknown: "That episode is no longer there. Reload the page.",
  too_big: "The public feed holds too much. Take an episode out first.",
  busy: "The podcast is being changed right now. Try again in a moment.",
  unavailable: "This could not be read or saved just now. Nothing was changed. Try again in a minute.",
};

type Feed = { on: boolean; category: string | null; explicit: boolean | null; episodes: Record<string, string>; address: string };
type Answer = { ok: boolean; error?: string; message?: string; feed?: Feed };

async function post(payload: Record<string, unknown>): Promise<Answer> {
  try {
    const response = await fetch("/api/store/podcast/public-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return (await response.json().catch(() => ({ ok: false, error: "unavailable" }))) as Answer;
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

function said(answer: Answer): string {
  return answer.message || MESSAGES[answer.error ?? ""] || MESSAGES.unavailable;
}

/**
 * What the creator still has to give before "on" (or a save while it is on) is sent; null when nothing. The
 * server checks the same again.
 */
export function turnOnMissing(state: { on: boolean; understood: boolean; category: string; explicit: boolean | null }): "understood" | "category" | "explicit" | null {
  if (!state.understood) return "understood";
  if (!state.category) return "category";
  if (state.explicit === null) return "explicit";
  return null;
}

export function PodcastPublicFeed({ productId, episodes }: { productId: string; episodes: Episode[] }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("");
  const [explicit, setExplicit] = useState<boolean | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const id = useId();

  function take(answer: Answer) {
    if (!answer.ok || !answer.feed) return setLoadError(said(answer));
    setFeed(answer.feed);
    setCategory(answer.feed.category ?? "");
    setExplicit(answer.feed.explicit);
  }

  async function load() {
    setLoadError(null);
    take(await post({ action: "read", id: productId }));
  }

  // Read when the editor opens; an answer that comes after the editor closed is dropped.
  useEffect(() => {
    let live = true;
    void post({ action: "read", id: productId }).then((answer) => {
      if (live) take(answer);
    });
    return () => {
      live = false;
    };
  }, [productId]);

  async function run(payload: Record<string, unknown>, done: string): Promise<boolean> {
    setError(null);
    setBusy(true);
    const answer = await post({ id: productId, ...payload });
    setBusy(false);
    if (!answer.ok || !answer.feed) {
      setError(said(answer));
      return false;
    }
    setFeed(answer.feed);
    toast(done);
    return true;
  }

  async function turnOn() {
    const missing = turnOnMissing({ on: feed?.on === true, understood, category, explicit });
    if (missing) return setError(MESSAGES[missing]);
    await run({ action: "on", category, explicit, understood: true }, feed?.on ? "Saved." : "The public feed is on. No episode is in it yet.");
  }

  const newest = [...episodes].sort((a, b) => b.at - a.at);

  return (
    <section className="card p-6 sm:p-8" aria-labelledby={`${id}-heading`} aria-busy={feed === null && !loadError}>
      <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-[-0.02em] text-ink">Public feed</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        A public feed lets anyone follow the episodes you choose in Apple Podcasts, Spotify and other apps, without buying.
        Your buyers&apos; own feeds do not change. No episode goes in until you add it.
      </p>

      {loadError ? (
        <div className="mt-4 space-y-3">
          <p className="notice notice-error" role="alert">{loadError}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>Try again</button>
        </div>
      ) : feed === null ? (
        <p className="mt-4 text-sm text-ink-soft">Loading the public feed…</p>
      ) : (
        <div className="mt-4 space-y-5">
          {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
          <p className="text-sm font-semibold text-ink">{feed.on ? "The public feed is on." : "The public feed is off."}</p>

          {feed.on ? (
            <div>
              <label htmlFor={`${id}-address`} className="field-label">Your public feed address</label>
              <p id={`${id}-address-help`} className="mt-1 text-sm text-ink-soft">Give this address to Apple Podcasts, Spotify or any podcast app.</p>
              <div className="mt-1 flex flex-wrap gap-3">
                <input id={`${id}-address`} className="field min-w-0 flex-1" readOnly value={feed.address} aria-describedby={`${id}-address-help`} />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(feed.address);
                      toast("Address copied.");
                    } catch {
                      setError("The address could not be copied. Select it and copy it yourself.");
                    }
                  }}
                >
                  Copy the address
                </button>
              </div>
            </div>
          ) : null}

          <div className="space-y-4">
            <div>
              <label htmlFor={`${id}-category`} className="field-label">Category</label>
              <select id={`${id}-category`} className="field mt-1" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Choose a category</option>
                {PUBLIC_CATEGORIES.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
            <fieldset>
              <legend className="field-label">Does the show have explicit content?</legend>
              <div className="mt-2 flex flex-wrap gap-6">
                {([false, true] as const).map((value) => (
                  <label key={String(value)} className="flex min-h-11 items-center gap-2 text-sm text-ink">
                    <input type="radio" name={`${id}-explicit`} className="h-5 w-5" checked={explicit === value} onChange={() => setExplicit(value)} />
                    {value ? "Yes, it is explicit" : "No, it is not explicit"}
                  </label>
                ))}
              </div>
            </fieldset>
            {feed.on ? null : (
              <div className="notice notice-warn" id={`${id}-warning`}>
                <p className="font-semibold">This feed is public.</p>
                <p className="mt-1">Anyone can find it, follow it and play every episode you add to it, for free. Podcast apps and directories may list it.</p>
                <label className="mt-3 flex min-h-11 items-center gap-2">
                  <input type="checkbox" className="h-5 w-5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} aria-describedby={`${id}-warning`} />
                  I understand that this feed is public.
                </label>
              </div>
            )}
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void turnOn()}>
              {feed.on ? "Save the category and explicit setting" : "Turn on the public feed"}
            </button>
          </div>

          {feed.on ? (
            <>
              <div>
                <h3 className="font-semibold text-ink">Episodes in the public feed</h3>
                {newest.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-soft">None yet. Add an episode above first.</p>
                ) : (
                  <ol className="mt-2 divide-y divide-line">
                    {newest.map((episode) => {
                      const audio = feed.episodes[episode.id];
                      return (
                        <li key={episode.id} className="py-4">
                          <p className="font-semibold text-ink">{episode.title}</p>
                          <p className="text-sm text-ink-soft">{audio ? "In the public feed. Anyone can play it." : "For buyers only."}</p>
                          {audio ? <p className="mt-1 break-all text-xs text-ink-soft">{`Audio: ${audio}`}</p> : null}
                          {adding === episode.id ? (
                            <AddEpisode
                              busy={busy}
                              onCancel={() => setAdding(null)}
                              onAdd={async (address) => {
                                if (await run({ action: "episode", episode: episode.id, public: true, audio: address }, "Added to the public feed.")) setAdding(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-ink-soft underline underline-offset-4 hover:text-violet-deep"
                              disabled={busy}
                              onClick={() =>
                                audio ? void run({ action: "episode", episode: episode.id, public: false }, "Taken out of the public feed. It is for buyers only again.") : setAdding(episode.id)
                              }
                            >
                              {audio ? "Take it out of the public feed" : "Add it to the public feed"}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (!confirmingOff) return setConfirmingOff(true);
                  setConfirmingOff(false);
                  if (await run({ action: "off" }, "The public feed is off.")) setUnderstood(false);
                }}
              >
                {confirmingOff ? "Press again to turn it off and forget which episodes were in it" : "Turn off the public feed"}
              </button>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function AddEpisode({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (address: string) => Promise<void>; onCancel: () => void }) {
  const [address, setAddress] = useState("");
  const id = useId();
  return (
    <div className="mt-3 space-y-3">
      <div>
        <label htmlFor={`${id}-audio`} className="field-label">Public audio address</label>
        <p id={`${id}-help`} className="mt-1 text-sm text-ink-soft">
          Where this episode&apos;s audio is already published for everyone, such as your podcast host. It starts with https://.
          The file you uploaded here stays private to your buyers.
        </p>
        <input id={`${id}-audio`} className="field mt-1" type="url" inputMode="url" autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} aria-describedby={`${id}-help ${id}-warn`} placeholder="https://" />
      </div>
      <p id={`${id}-warn`} className="text-sm font-semibold text-ink">Anyone will be able to play this episode for free.</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || address.trim() === ""} onClick={() => void onAdd(address.trim())}>Add it</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
