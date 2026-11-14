"use client";

import { Icon } from "@/components/icons";
import { PAGE_STYLES, type PageStyle } from "@/lib/sales-page";

/**
 * The page's style (lib/sales-page.ts, PageStyle), as three choices with a
 * small drawing of each, so the creator sees the difference before reading
 * a word. The same picker sits under the blocks and above the preview.
 */
export const STYLE_NAMES: Record<PageStyle, { label: string; hint: string }> = {
  plain: { label: "Plain", hint: "Sections on the page itself, with room between them." },
  bands: { label: "Bands", hint: "Every other section on a soft wash of your store's color." },
  cards: { label: "Cards", hint: "Each section on a card of its own." },
};

function Thumb({ style }: { style: PageStyle }) {
  const row = (band: boolean, key: number) => (
    <span
      key={key}
      className={`block h-2.5 rounded-[3px] ${
        style === "cards" ? "border border-line-strong bg-white" : style === "bands" && band ? "bg-violet-brand/25" : "bg-transparent"
      }`}
    >
      <span className="mx-1.5 mt-[3px] block h-1 w-2/3 rounded-full bg-ink/30" />
    </span>
  );
  return (
    <span aria-hidden="true" className="grid w-14 shrink-0 gap-1 rounded-md bg-paper p-1.5 ring-1 ring-line">
      <span className="block h-1.5 w-3/4 rounded-full bg-ink/60" />
      {[true, false, true].map((band, i) => row(band, i))}
    </span>
  );
}

export function PageStylePicker({
  value,
  onChange,
  compact = false,
}: {
  value: PageStyle;
  onChange: (style: PageStyle) => void;
  /** Labels only, for the bar above the preview. */
  compact?: boolean;
}) {
  return (
    <div role="group" aria-label="Page style" className={compact ? "flex flex-wrap gap-2" : "mt-2 grid gap-2 sm:grid-cols-3"}>
      {PAGE_STYLES.map((style) => {
        const on = value === style;
        return (
          <button
            key={style}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(style)}
            className={
              compact
                ? `inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold ring-1 ${on ? "bg-lilac text-violet-ink ring-violet-brand/40" : "text-ink-soft ring-line"}`
                : `flex min-h-11 items-start gap-3 rounded-xl p-3 text-left ring-1 transition ${on ? "bg-lilac ring-2 ring-violet-brand" : "bg-white ring-line hover:ring-line-strong"}`
            }
          >
            {compact ? (
              <>
                {STYLE_NAMES[style].label}
                {on ? <Icon name="check" size={16} /> : null}
              </>
            ) : (
              <>
                <Thumb style={style} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{STYLE_NAMES[style].label}</span>
                  <span className="mt-0.5 block text-xs text-ink-soft">{STYLE_NAMES[style].hint}</span>
                </span>
                {/* The one on says so with a check, not by color alone: forced colors take the color and the ring away. */}
                {on ? <Icon name="check" size={16} className="mt-0.5 shrink-0 text-violet-ink" /> : null}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
