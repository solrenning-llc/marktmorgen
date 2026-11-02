"use client";

import { useEffect, useId, useRef, useState } from "react";
import { EmailSuggestion } from "@/components/email-suggestion";
import { holdForSuggestion, suggestEmail } from "@/lib/email-typo";

/**
 * An email field with the "Did you mean …?" line under it (308 [TC1],
 * components/email-suggestion.tsx), for the plain forms of the store pages.
 *
 * The input is left to the browser, as the one it replaces was: what is
 * typed before the page's scripts load is never wiped, and the form posts
 * whatever the field holds. The component only reads it (on input, and once
 * when it starts) to offer the suggestion, and writes it only when the
 * person presses "Use …".
 *
 * Pressing send takes the focus off the field and sends at once, so a slip
 * would never be seen there: the first send with a likely slip is held, once,
 * to show the line (holdForSuggestion); sending again sends what was typed,
 * unchanged. It is held first, before any other script on the form sees the
 * send, and never while the field is hidden (the checkout reminder's field
 * stays on the page with its box unticked). Nothing else ever stops the form.
 *
 * `wrapClassName` sizes the field and its line together where the field sat
 * in a row beside a button (for example "min-w-0 flex-1").
 */
export function EmailField({
  id,
  name,
  className,
  wrapClassName,
  language = "en",
  required,
  placeholder,
  autoComplete = "email",
  describedBy,
  defaultValue = "",
  store = true,
  maxLength = 254,
}: {
  id?: string;
  name: string;
  className: string;
  wrapClassName?: string;
  language?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  describedBy?: string;
  defaultValue?: string;
  /** The store's own look (st-*) rather than the site's. */
  store?: boolean;
  /** The longest address the form's server keeps, when it is less than 254. */
  maxLength?: number;
}) {
  const made = useId();
  const field = id ?? `email-${made.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const line = `${field}-suggestion`;
  const [value, setValue] = useState(defaultValue);
  const [left, setLeft] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const shown = useRef("");
  useEffect(() => {
    const own = input.current;
    if (!own) return;
    // Whatever was typed before the scripts loaded.
    setValue(own.value);
    const onSubmit = (event: SubmitEvent) => {
      if (!own.form || event.target !== own.form) return;
      const typed = own.value;
      // A field that is not drawn (its box unticked) holds nothing back.
      if (own.getClientRects().length === 0) return;
      if (!holdForSuggestion(typed, shown.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      shown.current = typed;
      setValue(typed);
      setLeft(true);
    };
    // On the window, as it captures: before the document's own listeners (the ad pixels hold a
    // checkout's send for a moment, components/store-pixels.tsx), so nothing else acts on a send held here.
    window.addEventListener("submit", onSubmit, true);
    return () => window.removeEventListener("submit", onSubmit, true);
  }, []);
  // A line the person has already seen (shown by leaving the field) is never held for again.
  useEffect(() => {
    if (left && suggestEmail(value) !== null) shown.current = value;
  }, [left, value]);
  return (
    <div className={wrapClassName}>
      <input
        ref={input}
        id={field}
        name={name}
        type="email"
        required={required}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        defaultValue={defaultValue}
        onInput={(event) => setValue(event.currentTarget.value)}
        onBlur={(event) => {
          // Pressing the form's own send button: the send shows the line (held once below), so the button
          // is not pushed down between the press and the release, which would lose the click.
          const to = event.relatedTarget;
          if (to instanceof HTMLButtonElement && to.type === "submit" && to.form === event.currentTarget.form) return;
          setLeft(true);
        }}
        onInvalid={() => setLeft(true)}
        aria-describedby={[describedBy ?? "", left && suggestEmail(value) !== null ? line : ""].filter(Boolean).join(" ") || undefined}
        className={className}
      />
      <EmailSuggestion
        id={line}
        inputId={field}
        value={value}
        show={left}
        onUse={(address) => {
          if (input.current) input.current.value = address;
          setValue(address);
        }}
        language={language}
        store={store}
      />
    </div>
  );
}
