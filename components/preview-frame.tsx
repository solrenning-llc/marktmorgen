"use client";

/**
 * The page editor's preview as on a computer or as on a phone, switched with
 * one press (375 [TB1]; the widths and the shrinking are in lib/preview-screen.ts).
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import {
  PREVIEW_FRAME_WIDTH,
  PREVIEW_SCREENS,
  PREVIEW_SCREEN_KEY,
  PREVIEW_SCREEN_LABEL,
  type PreviewScreen,
  fitScale,
  readPreviewScreen,
  shrunkHeight,
  shrunkNote,
} from "@/lib/preview-screen";

/** The screen chosen, remembered in this browser only; "computer" until read, or when the browser keeps nothing. */
export function usePreviewScreen(): [PreviewScreen, (next: PreviewScreen) => void] {
  const [screen, setScreen] = useState<PreviewScreen>("computer");
  useEffect(() => {
    const first = window.setTimeout(() => {
      try {
        setScreen(readPreviewScreen(window.localStorage.getItem(PREVIEW_SCREEN_KEY)));
      } catch {
        // Storage blocked: the default stays.
      }
    }, 0);
    return () => window.clearTimeout(first);
  }, []);
  const choose = (next: PreviewScreen) => {
    setScreen(next);
    try {
      window.localStorage.setItem(PREVIEW_SCREEN_KEY, next);
    } catch {
      // Not remembered; the choice still holds on this page.
    }
  };
  return [screen, choose];
}

/** Two buttons, Computer and Phone; the one on says so in words and with a check, not by color alone. Focus stays where it is. */
export function ScreenSwitch({ value, onChange }: { value: PreviewScreen; onChange: (next: PreviewScreen) => void }) {
  const label = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span id={label} className="text-ink-soft">
        Preview on
      </span>
      <div className="inline-flex rounded-full bg-paper p-1 ring-1 ring-line" role="group" aria-labelledby={label}>
        {PREVIEW_SCREENS.map((screen) => {
          const on = value === screen;
          return (
            <button
              key={screen}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(screen)}
              className={`inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold ${on ? "bg-white text-ink shadow-sm ring-1 ring-line" : "text-ink-soft hover:text-ink"}`}
            >
              <Icon name={screen === "phone" ? "phone" : "window"} size={16} />
              {PREVIEW_SCREEN_LABEL[screen]}
              {on ? <Icon name="check" size={16} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** What can take the keyboard's focus; inside the preview each is taken out of the Tab order. */
const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [contenteditable], [tabindex]:not([tabindex="-1"])';

/**
 * The page laid out at the screen's real width, so the page's own width
 * decides its columns and which blocks show, then shrunk to fit the column
 * it sits in, never wider than it (no sideways scrolling). Named for screen
 * readers, which can still read it; nothing in it is in the Tab order, so the
 * keyboard never walks into it, and no press in it leaves the editor.
 */
export function PreviewFrame({ screen, children }: { screen: PreviewScreen; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [tall, setTall] = useState(0);
  useEffect(() => {
    const outer = box.current;
    const inner = stage.current;
    if (!outer || !inner) return;
    const read = () => {
      setRoom(outer.clientWidth);
      setTall(inner.offsetHeight);
    };
    const watch = new ResizeObserver(read);
    watch.observe(outer);
    watch.observe(inner);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const inner = stage.current;
    if (!inner) return;
    const still = () => {
      inner.querySelectorAll<HTMLElement>(FOCUSABLE).forEach((el) => el.setAttribute("tabindex", "-1"));
    };
    still();
    const watch = new MutationObserver(still);
    watch.observe(inner, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  const frame = PREVIEW_FRAME_WIDTH[screen];
  const scale = fitScale(room, frame);
  const note = shrunkNote(scale);
  return (
    <>
      <div
        ref={box}
        role="region"
        aria-label={`Preview: ${screen}`}
        className="overflow-hidden rounded-2xl ring-1 ring-line"
        style={scale < 1 && tall > 0 ? { height: shrunkHeight(tall, scale) } : undefined}
      >
        <div ref={stage} className="mx-auto" style={{ width: frame, ...(scale < 1 ? { transform: `scale(${scale})`, transformOrigin: "top left" } : {}) }}>
          {children}
        </div>
      </div>
      {note ? <p className="mt-2 text-xs text-ink-soft">{note}</p> : null}
    </>
  );
}
