"use client";

import { MAX_TRANSCRIPT, type VideoWords, saysInWords } from "@/lib/sales-page";

/**
 * In the studio, under each video (the video block, a row's video, a video
 * in a window): what the video says in words (inbox C4-26 (3); WCAG 1.2.2,
 * 1.2.8). The creator ticks that the video has captions of its own, or writes
 * what it says, which the page shows under it as a transcript; neither is
 * required, and the page's checklist asks for one (lib/page-coach.ts). Nobody
 * can tell from here whether a video on another site has captions, so the
 * creator says so.
 */
export function VideoWordsFields({ id, value, onChange }: { id: string; value: VideoWords; onChange: (next: VideoWords) => void }) {
  const transcript = value.transcript ?? "";
  const said = saysInWords(value);
  return (
    <fieldset className="space-y-3 rounded-xl p-3 ring-1 ring-line" aria-describedby={`${id}-state`}>
      <legend className="px-1 text-sm font-semibold text-ink">What the video says, in words</legend>
      <label htmlFor={`${id}-cc`} className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink">
        <input
          id={`${id}-cc`}
          type="checkbox"
          className="h-5 w-5 shrink-0"
          checked={value.captioned === true}
          onChange={(e) => onChange({ ...value, captioned: e.target.checked })}
        />
        The video has captions of its own (subtitles you turned on where it is hosted). Changing the video address clears this, so you check the new one.
      </label>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${id}-tr`} className="text-sm font-medium text-ink">
            Transcript (optional)
          </label>
          <span className="text-xs text-ink-soft">
            {transcript.length.toLocaleString("en-US")} of {MAX_TRANSCRIPT.toLocaleString("en-US")} characters
          </span>
        </div>
        <textarea
          id={`${id}-tr`}
          className="field mt-1"
          rows={4}
          maxLength={MAX_TRANSCRIPT}
          value={transcript}
          aria-describedby={`${id}-trh`}
          onChange={(e) => onChange({ ...value, transcript: e.target.value })}
        />
        <p id={`${id}-trh`} className="mt-1 text-xs text-ink-soft">
          Shown under the video, closed until a visitor opens it. Up to about five minutes of speech; for a longer video, tick captions instead.
        </p>
      </div>
      <p id={`${id}-state`} role="status" className={`text-xs ${said ? "text-ink-soft" : "font-semibold text-ink"}`}>
        {said ? "Done: people who cannot hear or see the video can still follow it." : "Not yet: some visitors cannot hear or see a video. Tick captions or write what it says."}
      </p>
    </fieldset>
  );
}
