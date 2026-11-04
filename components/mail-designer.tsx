"use client";

import { createContext, useContext, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { MailPictureButton } from "@/components/mail-picture-button";
import {
  MAIL_TEMPLATES,
  MAX_MAIL_BUTTON,
  MAX_MAIL_HEADING,
  type MailBlock,
  bodyHtml,
  buttonHrefOk,
  hasPlaceholder,
  parseMailBlocks,
  serializeMailBlocks,
} from "@/lib/mail-body";
import { readPicture } from "@/lib/mail-picture-rules";

/** The store's colour for a button in its emails (lib/store-look.ts), for the preview to draw what is sent. */
export const MailAccent = createContext("#4c1d95");

const ADDABLE: { kind: MailBlock["kind"]; label: string }[] = [
  { kind: "heading", label: "Heading" },
  { kind: "text", label: "Text" },
  { kind: "list", label: "List" },
  { kind: "button", label: "Button" },
  { kind: "divider", label: "Line" },
];

const fresh = (kind: MailBlock["kind"]): MailBlock => {
  switch (kind) {
    case "heading":
      return { kind, text: "" };
    case "text":
      return { kind, text: "" };
    case "list":
      return { kind, items: [""] };
    case "button":
      return { kind, label: "", href: "https://" };
    case "picture":
      return { kind, line: "" };
    case "divider":
      return { kind };
  }
};

/**
 * An email's body, written in its box or laid out block by block
 * (lib/mail-body.ts): both write the same text, so switching between them
 * loses nothing. The designer starts from a template too, and shows the
 * email as it will be sent beside it.
 */
export function MailBodyEditor({
  body,
  onChange,
  label = "Email",
  rows = 12,
  boxRef,
}: {
  body: string;
  onChange: (next: string) => void;
  label?: string;
  rows?: number;
  /** The text box, for "Add a picture" to put the picture where the cursor is. */
  boxRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  const accent = useContext(MailAccent);
  const [mode, setMode] = useState<"write" | "design">("write");
  const [blocks, setBlocks] = useState<MailBlock[]>(() => parseMailBlocks(body));
  const [written, setWritten] = useState(body);
  const box = useRef<HTMLTextAreaElement | null>(null);
  // The preview starts at a phone's width, where most emails are read (487 [IT4], pattern 7).
  const [phone, setPhone] = useState(true);

  // A change made elsewhere (a picture added, a draft opened, the writing help) is read into the blocks again.
  if (mode === "design" && body !== written) {
    setWritten(body);
    setBlocks(parseMailBlocks(body));
  }

  function update(next: MailBlock[]) {
    setBlocks(next);
    const text = serializeMailBlocks(next);
    setWritten(text);
    onChange(text);
  }
  const set = (i: number, change: Partial<MailBlock>) => update(blocks.map((b, j) => (j === i ? ({ ...b, ...change } as MailBlock) : b)));
  function move(i: number, by: -1 | 1) {
    const to = i + by;
    if (to < 0 || to >= blocks.length) return;
    const next = blocks.slice();
    [next[i], next[to]] = [next[to], next[i]];
    update(next);
  }
  function design() {
    setWritten(body);
    setBlocks(parseMailBlocks(body));
    setMode("design");
  }
  function addTemplate(id: string) {
    const template = MAIL_TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    update([...blocks, ...template.blocks.map((b) => structuredClone(b))]);
  }

  // "As it is sent", in both Write and Design, as the creator types: drawn by the same function that draws the email.
  const toggle = (on: boolean) => `inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${on ? "bg-white text-ink shadow-sm" : "text-ink-soft"}`;
  const preview = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-soft">As it is sent</p>
        <div role="group" aria-label="Preview width" className="inline-flex rounded-full bg-sand p-1">
          <button type="button" className={toggle(phone)} aria-pressed={phone} onClick={() => setPhone(true)}>
            Phone
          </button>
          <button type="button" className={toggle(!phone)} aria-pressed={!phone} onClick={() => setPhone(false)}>
            Wide
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-soft">The same words as in the editor, laid out as the email is sent. Nothing in it can be pressed here.</p>
      <div className="mt-1 rounded-2xl bg-[#f7f5f0] p-4">
        <div
          // Inert: its headings stay out of the page's outline, its links and buttons out of the Tab order and out of reach
          // of a click that would leave the page and the draft. What it shows is the editor's own text, read there.
          inert
          className="mx-auto rounded-2xl bg-white p-5 text-[16px] leading-[1.6] text-[#1c1917] [overflow-wrap:anywhere]"
          style={phone ? { maxWidth: 390 } : undefined}
          // Drawn by the same function that draws the email: everything in it is escaped (lib/mail-body.ts).
          dangerouslySetInnerHTML={{ __html: bodyHtml(body, undefined, accent) || "<p style=\"color:#57534e\">Nothing yet.</p>" }}
        />
      </div>
    </div>
  );

  return (
    <div className="block">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="field-label">{label}</span>
        <div role="group" aria-label="How to edit the email" className="inline-flex rounded-full bg-sand p-1">
          <button type="button" className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${mode === "write" ? "bg-white text-ink shadow-sm" : "text-ink-soft"}`} aria-pressed={mode === "write"} onClick={() => setMode("write")}>
            Write
          </button>
          <button type="button" className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold ${mode === "design" ? "bg-white text-ink shadow-sm" : "text-ink-soft"}`} aria-pressed={mode === "design"} onClick={design}>
            Design
          </button>
        </div>
      </div>

      {mode === "write" ? (
        <div className="mt-2 grid min-w-0 gap-4 xl:grid-cols-2">
          <textarea
            ref={(el) => {
              box.current = el;
              boxRef?.(el);
            }}
            className="field min-h-56"
            rows={rows}
            maxLength={20000}
            value={body}
            aria-label={label}
            onChange={(e) => onChange(e.target.value)}
          />
          {/* Beside the text on a wide screen; on a narrow one, folded, so a sequence of several emails is not one long scroll. */}
          <div className="hidden xl:block">{preview}</div>
          <details className="xl:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink underline underline-offset-4">See it as it is sent</summary>
            <div className="mt-2">{preview}</div>
          </details>
        </div>
      ) : (
        <div className="mt-3 grid min-w-0 gap-4 xl:grid-cols-2">
          <div className="min-w-0 space-y-3">
            <label className="block">
              <span className="text-sm text-ink-soft">Start from a template</span>
              <select className="field mt-1" value="" onChange={(e) => addTemplate(e.target.value)}>
                <option value="">Add a template&apos;s blocks…</option>
                {MAIL_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>{`${t.label}: ${t.hint}`}</option>
                ))}
              </select>
            </label>
            {blocks.length === 0 ? <p className="rounded-2xl bg-paper p-4 text-sm text-ink-soft ring-1 ring-line">No blocks yet. Add one below, or start from a template.</p> : null}
            <ol className="space-y-3">
              {blocks.map((block, i) => (
                <li key={i} className="rounded-2xl bg-paper p-3 ring-1 ring-line">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{block.kind === "divider" ? "Line" : block.kind === "picture" ? "Picture" : ADDABLE.find((a) => a.kind === block.kind)?.label}</span>
                    <span className="flex gap-1">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move block ${i + 1} up`}>
                        Up
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => move(i, 1)} disabled={i === blocks.length - 1} aria-label={`Move block ${i + 1} down`}>
                        Down
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => update(blocks.filter((_, j) => j !== i))} aria-label={`Remove block ${i + 1}`}>
                        <Icon name="minus" size={16} />
                      </button>
                    </span>
                  </div>
                  {block.kind === "heading" ? (
                    <input className="field mt-2" aria-label={`Heading, block ${i + 1}`} maxLength={MAX_MAIL_HEADING} value={block.text} onChange={(e) => set(i, { text: e.target.value })} />
                  ) : block.kind === "text" ? (
                    <textarea className="field mt-2" aria-label={`Text, block ${i + 1}`} rows={3} value={block.text} onChange={(e) => set(i, { text: e.target.value })} />
                  ) : block.kind === "list" ? (
                    <textarea
                      className="field mt-2"
                      aria-label={`List, one point a line, block ${i + 1}`}
                      rows={3}
                      value={block.items.join("\n")}
                      onChange={(e) => set(i, { items: e.target.value.split("\n") })}
                    />
                  ) : block.kind === "button" ? (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <input className="field" aria-label={`Button words, block ${i + 1}`} maxLength={MAX_MAIL_BUTTON} placeholder="Get the guide" value={block.label} onChange={(e) => set(i, { label: e.target.value })} />
                      <input className="field" aria-label={`Button address, block ${i + 1}`} placeholder="https://" value={block.href} onChange={(e) => set(i, { href: e.target.value })} />
                      {block.href && block.href !== "https://" && !buttonHrefOk(block.href) ? (
                        <p className="text-xs text-ink-soft sm:col-span-2">A button leads to an address that starts with https://.</p>
                      ) : null}
                    </div>
                  ) : block.kind === "picture" ? (
                    <p className="mt-2 text-sm text-ink-soft">{readPicture(block.line)?.alt || "A picture"}</p>
                  ) : (
                    <hr className="mt-3 border-line" />
                  )}
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              {ADDABLE.map((a) => (
                <button key={a.kind} type="button" className="btn btn-secondary btn-sm" onClick={() => update([...blocks, fresh(a.kind)])}>
                  <Icon name="plus" size={16} />
                  {a.label}
                </button>
              ))}
            </div>
            {hasPlaceholder(body) ? (
              <p className="notice notice-warn text-sm" role="status">
                Parts of a template are still in ⟦brackets⟧. Replace each with your own words or remove it: the email cannot go out with them.
              </p>
            ) : null}
          </div>
          {preview}
        </div>
      )}
      <div className="mt-2">
        <MailPictureButton body={body} onChange={onChange} box={() => (mode === "write" ? box.current : null)} />
      </div>
    </div>
  );
}
