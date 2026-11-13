"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";

/*
 * The confirmation toast: a small violet box, bottom right, that says an
 * action the person just took has worked. It is for successes that would
 * otherwise be invisible, off-screen or ambiguous. Errors are best inline next
 * to the control that caused them; where a component reports a failure in the
 * corner instead, it uses toastProblem(): an alert mark and the word
 * "Problem:" instead of the check, read out by a role="alert" region, and no
 * time limit, so it stays until the person closes it or a newer message
 * replaces it (WCAG 2.2.3, 3.3.1, 1.3.1; tests/toast-problems.test.ts).
 *
 * `toast()` works from any client component without a provider: it fires a
 * window event that the one Toaster, mounted in the root layout, listens for.
 *
 * It never covers the control that has focus (WCAG 2.4.11 and 2.4.12): before
 * it is painted, and again whenever focus moves, the person types, the page
 * scrolls, the window is resized or the page's content changes, it takes the
 * first corner that leaves the focused control and its focus ring fully
 * visible. If no corner is clear (a full-window editor has focus, say), the box
 * is hidden and its 5 seconds wait until it shows again; the live region still
 * announces the message.
 */

const EVENT = "nimbus:toast";
const FLASH_KEY = "nimbus:flash-toast";
const SHOWN_FOR = 5000;

/** A confirmation ("done") or a report that something went wrong ("problem"). */
export type ToastKind = "done" | "problem";
type Message = { message: string; kind: ToastKind };

/** How long a toast shows before it leaves by itself: never, for a problem (2.2.3). */
export function toastShownFor(kind: ToastKind): number | null {
  return kind === "problem" ? null : SHOWN_FOR;
}

// Effects run children first, so a page that confirms something on arrival
// can call toast() a moment before the Toaster in the layout is listening.
// That one message waits here instead of being lost.
let listening = false;
let waiting: Message | null = null;

function send(detail: Message): void {
  if (typeof window === "undefined") return;
  if (!listening) waiting = detail;
  window.dispatchEvent(new CustomEvent<Message>(EVENT, { detail }));
}

/** Shows a confirmation now. One short sentence, ending with a full stop. */
export function toast(message: string): void {
  send({ message, kind: "done" });
}

/** Says something went wrong, with what to do; it stays until the person closes it. */
export function toastProblem(message: string): void {
  send({ message, kind: "problem" });
}

/** Shows a confirmation after the next page load, for an action that ends in a navigation. */
export function flashToast(message: string): void {
  try {
    window.sessionStorage.setItem(FLASH_KEY, message);
  } catch {
    /* Storage refused: the page still works, just without the confirmation. */
  }
}

function takeFlash(): string | null {
  try {
    const message = window.sessionStorage.getItem(FLASH_KEY);
    if (message) window.sessionStorage.removeItem(FLASH_KEY);
    return message;
  } catch {
    return null;
  }
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Current = Message & { id: number };

/** The corners the toast may sit in, in the order they are tried. */
export const TOAST_PLACES = ["bottom-end", "top-end", "bottom-start", "top-start"] as const;
export type ToastPlace = (typeof TOAST_PLACES)[number] | "hidden";
type Box = { left: number; top: number; right: number; bottom: number };

/** Room around the focused control for its focus ring (outline plus offset), in px. */
export const FOCUS_ROOM = 8;

/** True when the toast's box would cover any part of the focused control or its ring. */
export function coversFocus(toast: Box, focus: Box, room = FOCUS_ROOM): boolean {
  return (
    toast.left < focus.right + room &&
    toast.right > focus.left - room &&
    toast.top < focus.bottom + room &&
    toast.bottom > focus.top - room
  );
}

/**
 * Where the toast goes so it covers nothing that has focus: the preferred place
 * when it is clear (so the box does not jump about), else the first clear corner,
 * else "hidden". `rectAt` gives the toast's box at a place.
 */
export function chooseToastPlace(focus: Box | null, rectAt: (place: ToastPlace) => Box, preferred: ToastPlace): ToastPlace {
  const start: ToastPlace = preferred === "hidden" ? TOAST_PLACES[0] : preferred;
  if (!focus || focus.right <= focus.left || focus.bottom <= focus.top) return start;
  const order = [start, ...TOAST_PLACES.filter((place) => place !== start)];
  return order.find((place) => !coversFocus(rectAt(place), focus)) ?? "hidden";
}

/**
 * Moves the toast region (its `data-place`, read by app/globals.css) off the
 * focused element, measuring the region's real box at each place. Focus inside
 * the toast leaves it where it is.
 */
export function keepToastClear(region: HTMLElement, active: Element | null, preferred?: ToastPlace): ToastPlace {
  const now = (region.dataset.place as ToastPlace | undefined) ?? TOAST_PLACES[0];
  if (active && region.contains(active)) return now;
  const page = active?.ownerDocument;
  const focus = active && active !== page?.body && active !== page?.documentElement ? active.getBoundingClientRect() : null;
  const place = chooseToastPlace(
    focus,
    (candidate) => {
      region.dataset.place = candidate;
      return region.getBoundingClientRect();
    },
    preferred ?? now,
  );
  region.dataset.place = place;
  return place;
}

/**
 * While a toast shows, it moves out of the way whenever the focused control
 * could end up under it: focus moving (also from script), typing that grows a
 * field, scrolling (any scroller), resizing, and the page's content changing
 * with no event at all (a refresh that grows the content above a focused
 * button). The toast's own changes are not watched. `onHidden` hears when the
 * box becomes hidden or shows again, so its countdown can wait. Returns the
 * cleanup.
 */
export function followToastFocus(
  region: HTMLElement,
  onHidden: (hidden: boolean) => void,
  win: Window & typeof globalThis = window,
): () => void {
  const doc = win.document;
  let hidden = region.dataset.place === "hidden";
  let frame = 0;
  const now = () => {
    win.cancelAnimationFrame(frame);
    frame = 0;
    const place = keepToastClear(region, doc.activeElement);
    if ((place === "hidden") !== hidden) {
      hidden = place === "hidden";
      onHidden(hidden);
    }
  };
  const soon = () => {
    if (!frame) frame = win.requestAnimationFrame(now);
  };
  doc.addEventListener("focusin", now);
  doc.addEventListener("input", now, true);
  win.addEventListener("scroll", soon, { capture: true, passive: true });
  win.addEventListener("resize", soon);
  const changed =
    typeof win.MutationObserver === "function"
      ? new win.MutationObserver((records) => {
          if (records.some((record) => !region.contains(record.target))) soon();
        })
      : null;
  changed?.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true });
  const resized = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(soon) : null;
  resized?.observe(doc.body);
  return () => {
    win.cancelAnimationFrame(frame);
    doc.removeEventListener("focusin", now);
    doc.removeEventListener("input", now, true);
    win.removeEventListener("scroll", soon, { capture: true });
    win.removeEventListener("resize", soon);
    changed?.disconnect();
    resized?.disconnect();
  };
}

/** The box's classes: a problem has its own colors (app/globals.css .nb-toast-problem). */
export function toastBoxClass(kind: ToastKind): string {
  return kind === "problem" ? "nb-toast nb-toast-problem" : "nb-toast";
}

/** What the toast box holds: its mark, its words and its Dismiss button. */
export function ToastMessage({ message, kind, onDismiss }: { message: string; kind: ToastKind; onDismiss: () => void }) {
  const mark = kind === "problem" ? "alert" : "check";
  return (
    <>
      <span className="nb-toast-icon" data-icon={mark} aria-hidden="true">
        <Icon name={mark} size={14} strokeWidth={2.5} />
      </span>
      {/* Read out by the live regions above; hidden here so it is not read twice. */}
      <p className="nb-toast-text" aria-hidden="true">
        {kind === "problem" ? <strong>Problem: </strong> : null}
        {message}
      </p>
      <button type="button" className="nb-toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" size={16} strokeWidth={2} />
      </button>
    </>
  );
}

/** Mounted once, in the root layout. */
export function Toaster() {
  const [current, setCurrent] = useState<Current | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const next = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  // null: no time limit (a problem stays until it is closed or replaced).
  const remaining = useRef<number | null>(SHOWN_FOR);
  const deadline = useRef(0);
  const hovered = useRef(false);
  const focused = useRef(false);
  const leaving = useRef(false);
  // The box is hidden (no corner leaves the focused control clear): its time waits.
  const hidden = useRef(false);
  // Where focus was before it moved into the toast, so closing it from the
  // keyboard puts the person back where they were rather than on <body>.
  const returnTo = useRef<HTMLElement | null>(null);

  const stopTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const dismiss = useCallback(() => {
    stopTimer();
    const element = box.current;
    if (!element || leaving.current) return;
    leaving.current = true;
    const hadFocus = element.contains(document.activeElement);
    const finish = () => {
      const id = Number(element.dataset.id);
      setCurrent((shown) => (shown && shown.id === id ? null : shown));
      if (hadFocus && returnTo.current?.isConnected) returnTo.current.focus();
      returnTo.current = null;
    };
    const animation = element.animate(
      reducedMotion()
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { opacity: 1, transform: "translateY(0)" },
            { opacity: 0, transform: "translateY(4px)" },
          ],
      { duration: 160, easing: "ease-in", fill: "forwards" },
    );
    animation.onfinish = finish;
    animation.oncancel = finish;
  }, [stopTimer]);

  const startTimer = useCallback(() => {
    stopTimer();
    if (hovered.current || focused.current || leaving.current || hidden.current || remaining.current === null) return;
    deadline.current = Date.now() + remaining.current;
    timer.current = window.setTimeout(dismiss, remaining.current);
  }, [dismiss, stopTimer]);

  const pauseTimer = useCallback(() => {
    if (timer.current === undefined) return;
    stopTimer();
    if (remaining.current !== null) remaining.current = Math.max(0, deadline.current - Date.now());
  }, [stopTimer]);

  useEffect(() => {
    const show = (event: Event) => {
      const detail = (event as CustomEvent<Message>).detail;
      if (!detail || typeof detail.message !== "string" || !detail.message) return;
      waiting = null;
      next.current += 1;
      setCurrent({ id: next.current, message: detail.message, kind: detail.kind === "problem" ? "problem" : "done" });
    };
    window.addEventListener(EVENT, show);
    listening = true;
    const flash = waiting ? null : takeFlash();
    const early = waiting ?? (flash ? { message: flash, kind: "done" as const } : null);
    waiting = null;
    if (early) send(early);
    return () => {
      listening = false;
      window.removeEventListener(EVENT, show);
    };
  }, []);

  // A new toast replaces the one showing: fresh timer, fresh entrance.
  useLayoutEffect(() => {
    if (!current) return;
    leaving.current = false;
    hovered.current = false;
    focused.current = false;
    remaining.current = toastShownFor(current.kind);
    // Placed before it is painted, so it never covers the focused control even for a frame.
    hidden.current = region.current ? keepToastClear(region.current, document.activeElement, "bottom-end") === "hidden" : false;
    box.current?.animate(
      reducedMotion()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
      { duration: 200, easing: "ease-out" },
    );
    startTimer();
    return stopTimer;
  }, [current, startTimer, stopTimer]);

  // While a toast shows, it keeps clear of the focused control (followToastFocus);
  // a hidden box's time waits, and goes on once it shows again.
  useEffect(() => {
    if (!current || !region.current) return;
    return followToastFocus(region.current, (isHidden) => {
      hidden.current = isHidden;
      return isHidden ? pauseTimer() : startTimer();
    });
  }, [current, pauseTimer, startTimer]);

  return (
    <div ref={region} className="nb-toast-region">
      {/* Always in the page, empty when idle, so each message is announced: confirmations politely, problems at once. */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {current?.kind === "done" ? <span key={current.id}>{current.message}</span> : null}
      </div>
      <div role="alert" aria-atomic="true" className="sr-only">
        {current?.kind === "problem" ? <span key={current.id}>{`Problem: ${current.message}`}</span> : null}
      </div>
      {current ? (
        <div
          key={current.id}
          ref={box}
          data-id={current.id}
          className={toastBoxClass(current.kind)}
          onPointerEnter={() => {
            hovered.current = true;
            pauseTimer();
          }}
          onPointerLeave={() => {
            hovered.current = false;
            startTimer();
          }}
          onFocus={(event) => {
            if (!focused.current) {
              const from = event.relatedTarget;
              returnTo.current = from instanceof HTMLElement && !event.currentTarget.contains(from) ? from : null;
            }
            focused.current = true;
            pauseTimer();
          }}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            focused.current = false;
            startTimer();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              dismiss();
            }
          }}
        >
          <ToastMessage message={current.message} kind={current.kind} onDismiss={dismiss} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Turns a success-only notice that arrives in the address (like
 * /signin?status=out) into a toast, then takes the parameter off the address
 * so a reload or a shared link does not say it again.
 */
export function ToastOnLoad({ message, param }: { message: string; param: string }) {
  useEffect(() => {
    toast(message);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(param);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* The address stays as it was; the confirmation was still shown. */
    }
  }, [message, param]);
  return null;
}
