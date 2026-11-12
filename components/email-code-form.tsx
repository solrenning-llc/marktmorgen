"use client";

import { useId, useState } from "react";

/**
 * The six-digit code from the login email (652 [WG12]), for when the email
 * was opened on another device. Typed or pasted, digits only; nothing is
 * timed on this page, and a wrong code keeps what was typed (AX274 2.2.5).
 * No puzzle and nothing to recognize (AX274 3.3.9): the code is copied from
 * the email, and the field takes the phone's suggestion of it.
 */
export const CODE_MESSAGES: Record<string, string> = {
  code_shape: "The code is 6 digits, like 123456.",
  code_expired: "That code has expired or was already used. Ask for a new link and code.",
  code_blocked: "Too many wrong codes. Use the link in the email.",
  code_address_blocked: "Too many codes were tried for this address. Use the link in the email.",
  code_rate_limited: "Too many codes were tried from here in the last hour. Use the link in the email, or wait an hour.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

/** What a wrong code says, with the tries left; with none left, the code stops working and the link is the way in. */
export function wrongCodeMessage(left: number): string {
  if (left <= 0) return `That code is not right. ${CODE_MESSAGES.code_blocked}`;
  return `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`;
}

export function EmailCodeForm({ request }: { request: string }) {
  const id = useId();
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    const digits = code.replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setProblem(CODE_MESSAGES.code_shape);
      return;
    }
    setSending(true);
    setProblem("");
    try {
      const response = await fetch("/api/auth/email-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, code: digits }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const data: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (response.ok && data.ok === true && typeof data.next === "string" && data.next.startsWith("/")) {
        window.location.assign(data.next);
        return;
      }
      if (data.error === "code_wrong" && typeof data.left === "number") setProblem(wrongCodeMessage(data.left));
      else setProblem(typeof data.error === "string" && Object.hasOwn(CODE_MESSAGES, data.error) ? CODE_MESSAGES[data.error] : CODE_MESSAGES.server_error);
    } catch {
      setProblem(CODE_MESSAGES.server_error);
    }
    setSending(false);
  }

  return (
    <form onSubmit={submit} aria-busy={sending} className="mt-6 space-y-3 text-left" noValidate>
      <div>
        <label htmlFor={`${id}-code`} className="field-label">
          Enter the 6-digit code
        </label>
        <p id={`${id}-hint`} className="field-hint">
          It is in the same email as the link. Use it if you opened the email on another device, and type it here without reloading this page.
        </p>
        <input
          id={`${id}-code`}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={9}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            if (problem) setProblem("");
          }}
          aria-describedby={problem ? `${id}-hint ${id}-problem` : `${id}-hint`}
          aria-invalid={problem ? true : undefined}
          className="field mt-2 min-h-11 w-full tracking-widest"
        />
        <p id={`${id}-problem`} role="alert" className="mt-2 text-sm text-danger-text">
          {problem}
        </p>
      </div>
      <button type="submit" disabled={sending} className="btn btn-primary inline-flex min-h-11 w-full items-center justify-center">
        {sending ? "Checking the code…" : "Log in with the code"}
      </button>
    </form>
  );
}
