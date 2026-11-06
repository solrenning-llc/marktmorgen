"use client";

import { useEffect, useId, useRef, useState } from "react";
import { EmailSuggestion } from "@/components/email-suggestion";
import { holdForSuggestion, suggestEmail } from "@/lib/email-typo";

/**
 * The controlled email field with the "Did you mean …?" line under it
 * (308 [TC1], unit 3): for the studio's and the site's forms that keep the
 * address in their own state (the team invite, the recovery address, two-step
 * login, an affiliate partner, the store's chat and assistant).
 * components/email-field.tsx is its sibling for plain forms the browser
 * posts.
 *
 * The parent keeps the value, as before: `value` and `onChange` are the
 * input's own. The line shows once the person leaves the field or tries to
 * send, and the field is described by it only while it is there. The first
 * send with a likely slip is held, once, so the line is seen; sending again
 * sends what was typed, unchanged. It is held on the window, as it captures,
 * before the form's own handler sees the send, exactly as EmailField does.
 * Nothing is ever changed without the "Use …" press, and no request is made.
 */
export function EmailInput({
  id,
  value,
  onChange,
  className,
  wrapClassName,
  language = "en",
  store = false,
  required,
  placeholder,
  autoComplete = "email",
  maxLength = 254,
  describedBy,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  className: string;
  wrapClassName?: string;
  /** The language the line is said in: the store's on its pages, English in the studio. */
  language?: string;
  /** On a store's own pages: its look (st-*), not the site's. */
  store?: boolean;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
  describedBy?: string;
}) {
  const made = useId();
  const field = id ?? `email-${made.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const line = `${field}-suggestion`;
  const [left, setLeft] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const shown = useRef("");
  useEffect(() => {
    const onSubmit = (event: SubmitEvent) => {
      const own = input.current;
      if (!own?.form || event.target !== own.form) return;
      // A field that is not drawn holds nothing back.
      if (own.getClientRects().length === 0) return;
      const typed = own.value;
      if (!holdForSuggestion(typed, shown.current)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      shown.current = typed;
      setLeft(true);
    };
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
        type="email"
        required={required}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
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
      <EmailSuggestion id={line} inputId={field} value={value} show={left} onUse={onChange} language={language} store={store} />
    </div>
  );
}
