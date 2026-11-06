"use client";

import { useState } from "react";
import { UrlField } from "@/components/url-field";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import { useHydrated } from "@/components/use-hydrated";
import { LinkPicture } from "@/components/link-picture";
import { LINK_PROBLEMS, type LinkProblem, linkHost } from "@/lib/product-link";
import {
  MAX_LINK_TITLE_LENGTH,
  MAX_STORE_LINKS,
  type StoreLink,
  linkWhen,
} from "@/lib/store-link";
import { PROVIDER_NAMES, readVideo } from "@/lib/sales-page";
import { AUDIO_NAMES, readAudio } from "@/lib/audio-embed";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

/** What a link plays on the page, by name: "the YouTube video", "the Spotify player"; null when it plays nothing. */
function playable(url: string): { name: string; what: string } | null {
  const video = readVideo(url);
  if (video) return { name: PROVIDER_NAMES[video.provider], what: `The ${PROVIDER_NAMES[video.provider]} video plays` };
  const audio = readAudio(url);
  return audio ? { name: AUDIO_NAMES[audio.provider], what: `The ${AUDIO_NAMES[audio.provider]} player plays` } : null;
}

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  title: "Give the button a name before saving.",
  unknown: "That is no longer on your page.",
  none: "This account has no store yet.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  store_full: "Your store is full. Remove something before adding more.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

type Draft = { title: string; url: string; spotlight: boolean; play: boolean; from: string; until: string; header: boolean };

const EMPTY: Draft = { title: "", url: "", spotlight: false, play: false, from: "", until: "", header: false };

/** A kept moment as the browser's date-and-time box wants it, in the creator's own time zone. */
function toLocal(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The box's value as a moment to keep; "" when empty. */
function fromLocal(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** What the studio says about a link's extras, beside it in the list. */
function linkTags(link: StoreLink, hydrated: boolean): string[] {
  const tags: string[] = link.header ? ["Heading"] : [];
  if (link.spotlight) tags.push("Spotlight");
  if (link.play) {
    const plays = playable(link.url);
    if (plays) tags.push(`Plays on your page (${plays.name})`);
  }
  // Times are said in the creator's own time zone, which only the browser knows.
  if (!hydrated) {
    if (link.from || link.until) tags.push("Scheduled");
    return tags;
  }
  const when = linkWhen(link);
  if (when === "soon" && link.from) tags.push(`Shows from ${WHEN.format(new Date(link.from))}`);
  if (when === "ended" && link.until) tags.push(`Ended ${WHEN.format(new Date(link.until))}, hidden`);
  if (when === "live" && link.until) tags.push(`Shows until ${WHEN.format(new Date(link.until))}`);
  return tags;
}

/** The draft as the route reads it (lib/store-link.ts, linkExtras). */
function payloadOf(draft: Draft) {
  if (draft.header) return { title: draft.title, url: "", header: true, from: fromLocal(draft.from), until: fromLocal(draft.until) };
  return {
    title: draft.title,
    url: draft.url,
    spotlight: draft.spotlight,
    play: draft.play && playable(draft.url) !== null,
    from: fromLocal(draft.from),
    until: fromLocal(draft.until),
  };
}

async function send(payload: Record<string, unknown>): Promise<string | null> {
  try {
    const response = await fetch("/api/store/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      limit?: number;
      reason?: string;
    };
    if (data.ok) return null;
    if (data.error === "link") {
      // The server says which way the address was wrong; the creator gets
      // that sentence rather than a failure they cannot act on.
      return LINK_PROBLEMS[data.reason as LinkProblem] ?? LINK_PROBLEMS.shape;
    }
    if (data.error === "too_many") {
      return `A page holds up to ${data.limit ?? MAX_STORE_LINKS} links, and yours is full. Remove one to add another.`;
    }
    return MESSAGES[data.error ?? ""] ?? MESSAGES.server_error;
  } catch {
    return MESSAGES.server_error;
  }
}

/** The form used both for adding a link and for changing one. */
function LinkForm({
  draft,
  setDraft,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  setDraft: (draft: Draft) => void;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const plays = playable(draft.url);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSubmit();
      }}
      className="space-y-4 rounded-2xl border-2 border-violet-brand/30 bg-white p-4"
    >
      <div>
        <label htmlFor="link-title" className="field-label">
          {draft.header ? "The heading" : "What the button says"}
        </label>
        <input
          id="link-title"
          name="title"
          type="text"
          required
          maxLength={MAX_LINK_TITLE_LENGTH}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          placeholder={draft.header ? "My podcast" : "Watch on YouTube"}
          className="field mt-2"
        />
      </div>

      {draft.header ? null : (
      <div>
        <label htmlFor="link-url" className="field-label">
          Where it goes
        </label>
        <UrlField
          id="link-url"
          value={draft.url}
          onChange={(url) => setDraft({ ...draft, url })}
          describedBy="link-url-help"
          className="field mt-2"
        />
        <p id="link-url-help" className="mt-1 text-sm text-ink-soft">
          Anything of yours that already lives somewhere else. Nothing is sold
          through a link and nothing is charged for it.
        </p>
      </div>
      )}

      <fieldset className="space-y-3">
        <legend className="field-label">How it shows</legend>
        {draft.header ? null : (
        <label className="flex items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            checked={draft.spotlight}
            onChange={(event) => setDraft({ ...draft, spotlight: event.target.checked })}
            className="mt-0.5 size-5 shrink-0 accent-violet-brand"
          />
          <span>
            <span className="font-semibold">Spotlight it.</span>{" "}
            <span className="text-ink-soft">Drawn larger, in your store&apos;s color, with a slow glow, so it is seen first. Best kept for one link.</span>
          </span>
        </label>
        )}
        {plays && !draft.header ? (
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.play}
              onChange={(event) => setDraft({ ...draft, play: event.target.checked })}
              className="mt-0.5 size-5 shrink-0 accent-violet-brand"
            />
            <span>
              <span className="font-semibold">{`Play it on your page.`}</span>{" "}
              <span className="text-ink-soft">{`${plays.what} right on your store, without sending anyone away. It loads only when someone presses play. Only yours, or what its owner published there.`}</span>
            </span>
          </label>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="link-from" className="field-label">Shows from (optional)</label>
            <input
              id="link-from"
              type="datetime-local"
              value={draft.from}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              className="field mt-2"
            />
          </div>
          <div>
            <label htmlFor="link-until" className="field-label">Until (optional)</label>
            <input
              id="link-until"
              type="datetime-local"
              value={draft.until}
              min={draft.from || undefined}
              onChange={(event) => setDraft({ ...draft, until: event.target.value })}
              className="field mt-2"
            />
          </div>
        </div>
        <p className="text-sm text-ink-soft">
          For a launch, a live or an offer with an end: the link appears and goes by itself, in your own time zone. Leave both empty to show it always.
        </p>
      </fieldset>

      {error ? (
        <p
          role="alert"
          className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          aria-busy={busy} disabled={busy}
          className="btn btn-primary"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="btn btn-secondary"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * The links on the page that are not for sale.
 *
 * Kept apart from the products on purpose, in the studio as well as on the
 * page: a creator deciding what to charge for and a creator deciding where to
 * send people are doing two different things, and mixing them into one list
 * makes both harder to read.
 */
export function LinkEditor({ links, folder }: { links: StoreLink[]; folder: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(payload: Record<string, unknown>, done: () => void, confirmation?: string) {
    setBusy(true);
    setError(null);
    const problem = await send(payload);
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    done();
    if (confirmation) toast(confirmation);
    router.refresh();
  }

  function startAdding(header = false) {
    setDraft({ ...EMPTY, header });
    setError(null);
    setEditingId(null);
    setAdding(true);
  }

  function startEditing(link: StoreLink) {
    setDraft({
      title: link.title,
      url: link.url,
      spotlight: link.spotlight === true,
      play: link.play === true,
      from: toLocal(link.from),
      until: toLocal(link.until),
      header: link.header === true,
    });
    setError(null);
    setAdding(false);
    setEditingId(link.id);
  }

  return (
    <div className="card mt-8 p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Your links
        </p>
        <p className="text-sm text-ink-soft">
          {links.length} of {MAX_STORE_LINKS}
        </p>
      </div>

      {links.length === 0 ? (
        <p className="mt-2 text-ink-soft">
          Where else you can be found: the channel, the podcast, the profile,
          the booking page. These sit under what you sell, and they cost
          nothing and charge nothing.
        </p>
      ) : null}

      <ul className="mt-5 space-y-3">
        {links.map((link, index) => (
          <li
            key={link.id}
            className="rounded-2xl border border-line bg-paper p-4"
          >
            {editingId === link.id ? (
              <LinkForm
                draft={draft}
                setDraft={setDraft}
                busy={busy}
                error={error}
                submitLabel="Save"
                onSubmit={() =>
                  run(
                    { action: "edit", id: link.id, ...payloadOf(draft) },
                    () => setEditingId(null),
                    "Link saved.",
                  )
                }
                onCancel={() => {
                  setEditingId(null);
                  setError(null);
                }}
              />
            ) : (
              <>
                <p className="font-bold text-ink">{link.title}</p>
                {link.header ? null : (
                  <p className="mt-1 break-all font-mono text-xs text-ink-soft">
                    {link.url}
                  </p>
                )}
                {linkTags(link, hydrated).length ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {linkTags(link, hydrated).map((tag) => (
                      <li key={tag} className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-ink ring-1 ring-line">
                        {tag}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* A video played on the page shows the video, not a picture; a heading has neither. */}
                {link.header || link.play || !folder ? null : <LinkPicture link={link} folder={folder} />}

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold">
                  {link.header ? null : (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
                    >
                      Open it to check
                    <NewTab /></a>
                  )}
                  <button
                    type="button"
                    onClick={() => startEditing(link)}
                    className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    onClick={() =>
                      run({ action: "move", id: link.id, direction: "up" }, () => {})
                    }
                    className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40"
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === links.length - 1}
                    onClick={() =>
                      run(
                        { action: "move", id: link.id, direction: "down" },
                        () => {},
                      )
                    }
                    className="text-ink-soft underline underline-offset-4 transition hover:text-violet-deep disabled:no-underline disabled:opacity-40"
                  >
                    Move down
                  </button>
                  {removingId === link.id ? null : (
                    <button
                      type="button"
                      onClick={() => {
                        setRemovingId(link.id);
                        setError(null);
                      }}
                      className="text-ink-soft underline underline-offset-4 transition hover:text-danger"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {removingId === link.id ? (
                  <div className="mt-3 rounded-2xl border-2 border-pink-brand/30 bg-white p-4">
                    <p className="text-sm text-ink-soft">
                      Take{" "}
                      <strong className="text-ink">{link.title}</strong> off
                      your page. It only stops being listed here — whatever it
                      points at on {linkHost(link.url)} is untouched.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-busy={busy} disabled={busy}
                        onClick={() =>
                          run(
                            { action: "remove", id: link.id },
                            () => setRemovingId(null),
                            "Link removed.",
                          )
                        }
                        className="btn btn-danger-solid btn-sm"
                      >
                        {busy ? "Removing…" : "Remove it"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRemovingId(null)}
                        className="btn btn-secondary btn-sm"
                      >
                        Keep it
                      </button>
                    </div>
                    {error ? (
                      <p
                        role="alert"
                        className="mt-3 rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink"
                      >
                        {error}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="mt-5">
          <LinkForm
            draft={draft}
            setDraft={setDraft}
            busy={busy}
            error={error}
            submitLabel="Add it"
            onSubmit={() =>
              run(
                { action: "add", ...payloadOf(draft) },
                () => setAdding(false),
                "Link added.",
              )
            }
            onCancel={() => {
              setAdding(false);
              setError(null);
            }}
          />
        </div>
      ) : links.length >= MAX_STORE_LINKS ? (
        <p className="mt-5 text-sm text-ink-soft">
          {`Your page holds ${MAX_STORE_LINKS} links and they are all used. Remove one to add another.`}
        </p>
      ) : (
        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" onClick={() => startAdding()} className="btn btn-primary">
            Add a link
          </button>
          <button type="button" onClick={() => startAdding(true)} className="btn btn-secondary">
            Add a heading
          </button>
        </div>
      )}
    </div>
  );
}
