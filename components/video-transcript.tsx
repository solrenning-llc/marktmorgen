import { blockWords } from "@/lib/buyer-words/blocks";

/**
 * What a video says, in words, under it (inbox C4-26 (3); WCAG 1.2.2 and
 * 1.2.8): the creator's transcript, closed until opened, so the page stays
 * short for those who watch. A native <details>: opened by keyboard, touch or
 * voice alike, read by every screen reader, no script. Paragraphs as typed,
 * as plain words: nothing in it is a link. Nothing when there is none.
 */
export function VideoTranscript({ text, lang }: { text?: string; lang: string }) {
  const paragraphs = (text ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return null;
  return (
    <details className="sp-transcript mt-3">
      {/* A list item, as a summary is by default: its own triangle says whether it is open or closed. */}
      <summary className="min-h-11 cursor-pointer py-2.5 font-semibold underline underline-offset-4">{blockWords(lang).videoTranscript}</summary>
      <div className="mt-2 space-y-3 leading-relaxed">
        {paragraphs.map((paragraph, i) => (
          <p key={i} className="whitespace-pre-line">
            {paragraph}
          </p>
        ))}
      </div>
    </details>
  );
}
