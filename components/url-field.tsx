"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { type LinkCheck, linkOnLeave } from "@/lib/url-check";

/**
 * A web address field that says what is wrong when the person leaves it or
 * sends its form (487 [IT4], pattern 1; lib/url-check.ts), never while they
 * are still typing, and offers the address with https:// in one press when
 * that is all it lacks. Once said, the message stays as it is while they
 * type, and goes as soon as the address is right; a new problem is said only
 * at the next leave. The save still checks it on the server; this only says
 * so sooner.
 *
 * A text field opening the address keyboard, not type="url": the browser's
 * own bubble would stop the form in other words before this one is seen.
 * No length cut either: an address too long is said, never silently cut.
 *
 * The label is the caller's, tied by `id`, so it stays visible.
 */
export function UrlField({
  id,
  value,
  onChange,
  className,
  placeholder = "https://",
  describedBy,
  autoFocus,
  check: read = linkOnLeave,
  autoComplete = "url",
  wrapClassName,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  className: string;
  placeholder?: string;
  /** Help under the field, tied to it as well. */
  describedBy?: string;
  autoFocus?: boolean;
  /** The reading of the field's own server; a product link's by default. */
  check?: LinkCheck;
  /** "off" for an address that is a secret (a private calendar, a webhook): the browser is not asked to keep it. */
  autoComplete?: string;
  /** Sizes the field and its message together, where the field sits in a row beside a button. */
  wrapClassName?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  // What was said at the last leave, and for which address.
  const [said, setSaid] = useState<{ value: string; problem: string; fix: string | null } | null>(null);
  // The reading in a ref, so the form's send listener always uses the current one.
  const reading = useRef(read);
  useEffect(() => {
    reading.current = read;
  }, [read]);
  const check = (now: string) => {
    const found = reading.current(now);
    setSaid(found.problem ? { value: now, problem: found.problem, fix: found.fix } : null);
  };
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const onSubmit = () => check(input.current?.value ?? "");
    form.addEventListener("submit", onSubmit, true);
    return () => form.removeEventListener("submit", onSubmit, true);
  }, []);
  const line = `${id}-check`;
  // The fix is offered only for the address it was worked out from.
  const fix = said && said.value === value ? said.fix : null;
  const parts = (
    <>
      <input
        ref={input}
        id={id}
        className={className}
        type="text"
        inputMode="url"
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="none"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          if (said && !reading.current(next).problem) setSaid(null);
        }}
        onBlur={() => check(value)}
        aria-invalid={said ? true : undefined}
        aria-describedby={[describedBy ?? "", said ? line : ""].filter(Boolean).join(" ") || undefined}
      />
      <div id={line} role="status" className="text-sm">
        {said ? (
          <p className="mt-1 flex items-start gap-1.5 font-semibold text-danger">
            {/* An icon beside the words, so the message is not told by its color alone (1.4.1). */}
            <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
            <span>
            {said.problem}
            {fix ? (
              <>
                {" "}
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center font-bold text-ink underline underline-offset-4"
                  onClick={() => {
                    onChange(fix);
                    setSaid(null);
                    // The button goes with the message: the focus goes back to the field, never to the page.
                    input.current?.focus();
                  }}
                >
                  {`Use ${fix}`}
                </button>
              </>
            ) : null}
            </span>
          </p>
        ) : null}
      </div>
    </>
  );
  return wrapClassName ? <div className={wrapClassName}>{parts}</div> : parts;
}
