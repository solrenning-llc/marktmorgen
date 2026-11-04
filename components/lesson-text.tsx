import { Fragment } from "react";
import { NewTab } from "@/components/new-tab";
import { lessonBlocks } from "@/lib/lesson-blocks";

/**
 * A lesson's text, the way the creator typed it: paragraphs separated by a
 * blank line, lines starting with "- " as a list, blocks of code between
 * lines of three backticks (lib/lesson-blocks.ts), and web addresses that can
 * be clicked outside code. Nothing else is interpreted, so nothing a creator
 * types can turn into markup on a student's screen.
 */
const URL_PATTERN = /(https:\/\/[^\s<>"')\]]+)/g;

function Linked({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow ugc" className="break-words underline underline-offset-2">
            {part}
          <NewTab /></a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

/** `codeLabel` names each block of code for a screen reader, in the page's language (the lesson page passes its own word; the studio's preview is in English). */
export function LessonText({ text, codeLabel = "Code" }: { text: string; codeLabel?: string }) {
  return (
    <div className="space-y-4 leading-relaxed">
      {lessonBlocks(text).map((block, i) =>
        block.kind === "list" ? (
          <ul key={i} className="list-disc space-y-1 pl-6">
            {block.items.map((item, k) => (
              <li key={k}>
                <Linked text={item} />
              </li>
            ))}
          </ul>
        ) : block.kind === "code" ? (
          // Code as saved, as text: scrolled sideways rather than wrapped, reachable by keyboard to scroll, in the store's own colors (lib/store-look.ts) with a focus ring like its buttons'. A named group, not a landmark, so the stop it makes has a name and a lesson with many blocks adds no regions; never translated by the browser.
          <pre
            key={i}
            tabIndex={0}
            role="group"
            aria-label={block.language ? `${codeLabel}: ${block.language}` : codeLabel}
            translate="no"
            data-language={block.language || undefined}
            className="overflow-x-auto rounded-[var(--r-sm)] border border-[var(--st-line)] bg-[var(--st-item)] p-4 font-mono text-sm leading-6 text-[var(--st-text)] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[3px] focus-visible:outline-[var(--st-accent-text)]"
          >
            <code>{block.code}</code>
          </pre>
        ) : (
          <p key={i} className="whitespace-pre-line break-words">
            <Linked text={block.lines.join("\n")} />
          </p>
        ),
      )}
    </div>
  );
}
