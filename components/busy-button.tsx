"use client";

import { type ButtonHTMLAttributes, useRef } from "react";

/**
 * A button that waits on the server (WCAG 2.4.3, 4.1.3; AX274).
 *
 * A disabled button cannot keep the keyboard focus: the browser drops it to the
 * top of the page, so a button disabled while it saves sent keyboard and screen
 * reader users there on every save. This one is marked aria-disabled and
 * aria-busy instead, so the focus stays on it, and it does nothing on a click or
 * Enter while it waits or while it is off: no second save, and a submit button
 * also stops its form being sent again by Enter in one of its fields (the
 * browser presses the form's first submit button for that). What it says while
 * it waits ("Saving…", in its own words) is said once in a status region.
 * Styled as off by `.btn[aria-disabled="true"]` in app/globals.css.
 *
 * `busy`: this button's own work is under way. `off`: it cannot be used now,
 * for any other reason (another action under way, something still missing).
 * `announce={false}` when the page already says the same in a status region of
 * its own, so it is not said twice.
 * When its onClick returns a promise, a second press before that promise
 * settles does nothing either, even before `busy` is drawn.
 */
export function BusyButton({
  busy = false,
  off = false,
  announce = true,
  type = "button",
  onClick,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "aria-disabled" | "aria-busy"> & { busy?: boolean; off?: boolean; announce?: boolean }) {
  const pending = useRef(false);
  return (
    <>
      <button
        {...rest}
        type={type}
        aria-disabled={busy || off || undefined}
        aria-busy={busy || undefined}
        onClick={(event) => {
          if (busy || off || pending.current) {
            event.preventDefault();
            return;
          }
          const result: unknown = onClick?.(event);
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            pending.current = true;
            Promise.resolve(result as PromiseLike<unknown>).then(
              () => {
                pending.current = false;
              },
              () => {
                pending.current = false;
              },
            );
          }
        }}
      >
        {children}
      </button>
      {announce ? (
        <span role="status" className="sr-only">
          {busy ? children : null}
        </span>
      ) : null}
    </>
  );
}
