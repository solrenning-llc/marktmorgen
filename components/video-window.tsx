"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PROVIDER_NAMES, type Video, embedUrl } from "@/lib/sales-page";
import { blockWords } from "@/lib/buyer-words/blocks";

/**
 * A video behind a button, opened in a window over the page (added
 * 4 November 2026, queue item 375 [TB1], unit 5; lib/sales-page.ts,
 * RowElement "video-window"). Built the way the picture viewer is
 * (components/picture-viewer.tsx): the native <dialog>, opened with
 * showModal, so the rest of the page is inert and the keyboard stays inside
 * while it is open, and Escape closes it.
 *
 * Nothing loads from the player before the button is pressed: the frame is
 * drawn only while the window is open, and taken away when it closes, which
 * stops the video. Focus goes to the window's Close button when it opens and
 * back to the button that opened it when it closes. The window is named by
 * its title, so a screen reader says what opened. A visitor who asked for
 * less motion gets the player waiting on its own play button instead of
 * starting by itself.
 */
export function VideoWindow({ video, title, label, lang = "en" }: { video: Video; title: string; label: string; lang?: string }) {
  const words = blockWords(lang);
  const provider = PROVIDER_NAMES[video.provider];
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [still, setStill] = useState(false);
  const titleId = useId();
  const name = title || label;

  useEffect(() => {
    const box = dialog.current;
    if (!open || !box || box.open) return;
    box.showModal();
    close.current?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={opener}
        type="button"
        className="btn st-btn sp-row-btn"
        aria-haspopup="dialog"
        onClick={() => {
          setStill(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
          setOpen(true);
        }}
      >
        {label} <span className="sp-video-window-mark">{words.videoWindowMark}</span>
      </button>
      <dialog
        ref={dialog}
        className="pv-dialog vw-dialog"
        aria-labelledby={titleId}
        onClose={() => {
          // The frame goes with the window, so the video stops and nothing more loads.
          setOpen(false);
          opener.current?.focus();
        }}
        onClick={(event) => {
          // A click on the dark around the video closes it, as the picture viewer does.
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        {open ? (
          <div className="pv-frame">
            <div className="pv-top">
              <h2 id={titleId} className="vw-title">
                {name}
              </h2>
              <button ref={close} type="button" className="pv-button vw-close" onClick={() => dialog.current?.close()}>
                <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                {words.viewerClose}
              </button>
            </div>
            <div className="sp-video vw-video">
              <iframe
                src={embedUrl(video, { autoplay: !still })}
                title={words.videoFrame(name, provider)}
                allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
