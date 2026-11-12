"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import { shrink } from "@/components/product-image-editor";
import { IMAGE_ACCEPT, MAX_ALT_LENGTH, MAX_SOURCE_BYTES } from "@/lib/product-image";
import { MAX_POST_TEXT, MAX_POST_TITLE } from "@/lib/community-text";
import { MAX_POLL_DAYS, MAX_POLL_OPTIONS, MAX_POLL_OPTION_TEXT, MIN_POLL_OPTIONS } from "@/lib/community-polls";
import type { ComposerWords } from "@/lib/buyer-words/community";

/** `locked`: opens for posting at a level this member has not reached (lib/community-points.ts). */
type SpaceChoice = { id: string; name: string; creatorOnly: boolean; locked?: boolean };

const noSubscription = () => () => {};

function freshId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * Writing a post: which space, an optional title, the text, and one picture.
 *
 * It is an ordinary form that posts without any script. With one, it also
 * takes a picture: shrunk in the browser and sent straight to the file store
 * exactly as a product picture is (components/product-image-editor.tsx),
 * then named in the form, where the server checks it again by its first
 * bytes before the post may point at it.
 */
export function CommunityComposer({
  handle,
  folder,
  spaces,
  current,
  owner,
  from,
  canEmail,
  reach,
  reachUnknown,
  named,
  words,
}: {
  /** Everything it says, in the store's language (lib/buyer-words/community.ts, composerWords). */
  words: ComposerWords;
  handle: string;
  folder: string;
  spaces: SpaceChoice[];
  current: string | null;
  owner: boolean;
  from: "feed" | "space";
  canEmail: boolean;
  /** How many members asked for announcement emails; null when that could not be read, and the box is off. */
  reach: number | null;
  /** Said in place of the count when it could not be read (lib/buyer-words/community-unread.ts). */
  reachUnknown: string;
  named: boolean;
}) {
  const MESSAGES = words.errors;
  const open = spaces.filter((s) => owner || (!s.creatorOnly && !s.locked));
  const initial = open.find((s) => s.id === current)?.id ?? open[0]?.id ?? "";
  const [space, setSpace] = useState(initial);
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ path: string; w: number; h: number; preview: string } | null>(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  // Set once the form is sent, so a second press does not post (and email) twice.
  const [sent, setSent] = useState(false);
  useEffect(() => {
    // Coming back to this page with the browser's Back button: it can be sent again.
    const back = (event: PageTransitionEvent) => {
      if (event.persisted) setSent(false);
    };
    window.addEventListener("pageshow", back);
    return () => window.removeEventListener("pageshow", back);
  }, []);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState(false);
  // A poll is decided when the post is written and never after: adding one to
  // a post people have already replied to changes what they replied to.
  const [poll, setPoll] = useState(false);
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [days, setDays] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // The picture button is only offered once the script that sends it runs:
  // false in the page as sent, true once it is running in the browser.
  const scripted = useSyncExternalStore(noSubscription, () => true, () => false);
  useEffect(() => () => {
    if (image) URL.revokeObjectURL(image.preview);
  }, [image]);

  if (open.length === 0) return null;

  async function choose(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_SOURCE_BYTES) {
      setError(MESSAGES.source);
      return;
    }
    setBusy(true);
    setPercent(0);
    try {
      let shrunk: Awaited<ReturnType<typeof shrink>>;
      try {
        shrunk = await shrink(file);
      } catch (thrown) {
        setError(thrown instanceof Error && thrown.message === "too_big" ? MESSAGES.too_big : MESSAGES.unreadable);
        return;
      }
      const path = `community/${folder}/${freshId()}.${shrunk.blob.type === "image/jpeg" ? "jpg" : "webp"}`;
      await uploadPresigned(path, shrunk.blob, {
        access: "private",
        handleUploadUrl: "/api/store/community/upload",
        clientPayload: JSON.stringify({ handle }),
        contentType: shrunk.blob.type,
        onUploadProgress: (progress) => setPercent(progress.percentage),
      });
      setImage({ path, w: shrunk.width, h: shrunk.height, preview: URL.createObjectURL(shrunk.blob) });
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : "";
      setError(MESSAGES[Object.keys(MESSAGES).find((k) => message.includes(k)) ?? "server_error"]);
    } finally {
      setBusy(false);
      setPercent(0);
      if (input.current) input.current.value = "";
    }
  }

  const left = MAX_POST_TEXT - text.length;

  return (
    <form
      action="/api/store/community"
      method="post"
      className="st-card p-5 sm:p-6"
      aria-labelledby="composer-title"
      onSubmit={(event) => {
        if (sent || busy) {
          event.preventDefault();
          return;
        }
        setSent(true);
      }}
    >
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="action" value="post" />
      <input type="hidden" name="from" value={from} />
      {image ? (
        <>
          <input type="hidden" name="img" value={image.path} />
          <input type="hidden" name="img_w" value={image.w} />
          <input type="hidden" name="img_h" value={image.h} />
        </>
      ) : null}
      <h2 id="composer-title" className="text-base font-bold">{owner ? words.writeToCommunity : words.startPost}</h2>
      {!owner && !named ? (
        <p className="st-muted mt-1 text-sm">
          {words.nameUnderBefore}
          <a href={`/@${handle}/community/you`} className="font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>{words.you}</a>
          {words.nameUnderAfter}
        </p>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div>
          <label htmlFor="post-title" className="sr-only">{words.titleLabel}</label>
          <input id="post-title" name="title" maxLength={MAX_POST_TITLE} placeholder={words.titlePlaceholder} className="st-field" autoComplete="off" />
        </div>
        <div>
          <label htmlFor="post-space" className="sr-only">{words.space}</label>
          <select id="post-space" name="space" value={space} onChange={(e) => setSpace(e.target.value)} className="st-field">
            {open.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="post-text" className="sr-only">{words.whatToSay}</label>
      <textarea
        id="post-text"
        name="text"
        rows={4}
        maxLength={MAX_POST_TEXT}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={owner ? words.ownerPlaceholder : words.memberPlaceholder}
        className="st-field mt-3 min-h-[7rem] resize-y"
        aria-describedby="post-count"
      />
      {poll ? (
        <div className="cm-poll-build mt-3">
          <p className="text-sm font-bold">{words.answers}</p>
          <p className="st-muted mt-0.5 text-xs">{words.answersNote}</p>
          <ul className="mt-2 space-y-2">
            {options.map((one, i) => (
              <li key={i} className="flex items-center gap-2">
                <label htmlFor={`poll-option-${i}`} className="sr-only">{words.answerN.replace("{n}", String(i + 1))}</label>
                <input
                  id={`poll-option-${i}`}
                  name="poll_option"
                  value={one}
                  maxLength={MAX_POLL_OPTION_TEXT}
                  onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                  placeholder={words.answerN.replace("{n}", String(i + 1))}
                  className="st-field min-w-0 flex-1 !min-h-11 !py-2 text-sm"
                  autoComplete="off"
                />
                {options.length > MIN_POLL_OPTIONS ? (
                  <button
                    type="button"
                    className="cm-quiet-link cm-mini text-xs font-semibold"
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}
                  >
                    {words.remove}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {options.length < MAX_POLL_OPTIONS ? (
            <button type="button" className="cm-pill mt-2" onClick={() => setOptions([...options, ""])}>
              {words.addAnswer}
            </button>
          ) : (
            <p className="st-muted mt-2 text-xs">{words.mostAnswers}</p>
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="poll_multi" value="1" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="h-4 w-4" />
              <span>{words.pickMoreThanOne}</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="poll_quiet" value="1" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} className="h-4 w-4" />
              <span>{words.hideCount}</span>
            </label>
          </div>
          <label htmlFor="poll-days" className="mt-3 block text-sm">
            <span className="font-semibold">{words.closesAfter}</span>
            <span className="mt-1 flex items-center gap-2">
              <input
                id="poll-days"
                name="poll_days"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_POLL_DAYS}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                placeholder={words.never}
                className="st-field !min-h-11 !py-2 w-28 text-sm"
              />
              <span className="st-muted text-xs">{words.daysEmptyOpen}</span>
            </span>
          </label>
        </div>
      ) : null}
      <p id="post-count" className="st-muted mt-1 text-right text-xs" aria-live="polite">
        {left < 500
          ? (words.charactersLeft.singular.includes(left) ? words.charactersLeft.one : words.charactersLeft.many).replace("{n}", String(left))
          : words.addressesBecomeLinks}
      </p>

      {image ? (
        <div className="mt-3 flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.preview} alt="" width={image.w} height={image.h} className="h-20 w-20 shrink-0 rounded-xl object-cover" style={{ boxShadow: "0 0 0 1px var(--st-line)" }} />
          <div className="min-w-0 flex-1">
            <label htmlFor="post-alt" className="st-label text-sm">{words.pictureShows}</label>
            <input id="post-alt" name="img_alt" maxLength={MAX_ALT_LENGTH} value={alt} onChange={(e) => setAlt(e.target.value)} placeholder={words.pictureFor} className="st-field mt-1" />
            <button type="button" className="cm-quiet-link mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4" onClick={() => setImage(null)}>
              {words.removePicture}
            </button>
          </div>
        </div>
      ) : null}
      {busy ? (
        <div className="mt-3" role="status">
          <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--st-accent-soft)" }} role="progressbar" aria-label={words.sendingPicture} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full" style={{ width: `${Math.max(percent, 4)}%`, background: "var(--st-accent)" }} />
          </div>
          <p className="st-muted mt-1 text-sm">{words.shrinkingPicture}</p>
        </div>
      ) : null}
      {error ? <p className="cm-alert mt-3" role="alert">{error}</p> : null}

      {owner ? (
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">{words.announcement}</legend>
          <label className="flex min-h-11 items-start gap-2 text-sm">
            <input type="checkbox" name="kind" value="announcement" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0" />
            <span>{words.markAnnouncement}</span>
          </label>
          {announce ? (
            <label className={`flex min-h-11 items-start gap-2 text-sm ${canEmail && reach !== null && reach > 0 ? "" : "st-muted"}`}>
              <input type="checkbox" name="email" value="1" disabled={!canEmail || reach === null || reach === 0} className="mt-0.5 h-5 w-5 shrink-0" />
              <span>
                {!canEmail ? words.emailNeedsPro : reach === null ? reachUnknown : reach === 0 ? words.nobodyAskedEmails : words.alsoEmail}
              </span>
            </label>
          ) : null}
        </fieldset>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        {scripted ? (
          <>
            <input ref={input} type="file" accept={IMAGE_ACCEPT} className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => choose(e.target.files?.[0])} />
            <button type="button" className="cm-pill" disabled={busy || image !== null} onClick={() => input.current?.click()}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <circle cx="9" cy="10" r="1.8" />
                <path d="m4 18 5-5 4 4 3-3 4 4" strokeLinejoin="round" />
              </svg>
              {image ? words.onePicture : words.addPicture}
            </button>
          </>
        ) : (
          <span />
        )}
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" name="poll" value="1" checked={poll} onChange={(e) => setPoll(e.target.checked)} className="h-4 w-4" />
          <span>{words.askPoll}</span>
        </label>
        <button type="submit" className="btn st-btn" disabled={busy || sent} aria-busy={sent}>
          {announce ? words.postAnnouncement : words.post}
        </button>
      </div>
    </form>
  );
}

/** Asks before a delete goes through, where a script runs. Draws nothing. */
export function ConfirmDeletes() {
  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const question = form.dataset.confirm;
      if (question && !window.confirm(question)) event.preventDefault();
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);
  return null;
}
