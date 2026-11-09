"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CONTACT_MAX_LENGTH, DO_NOT_CONTACT_TRAP, NAME_MAX_LENGTH, normalizeResearchContact } from "@/lib/research-contact";

const SUPPORT = "support@marktmorgen.com";

const STATUS: Record<string, { tone: "ok" | "error"; text: string; email?: string }> = {
  done: { tone: "ok", text: "Done. That contact detail is on our do-not-contact list, and we will not contact it again for our research." },
  contact: {
    tone: "error",
    text: "That is not an email address or a link we can use. Type an email address, like you@example.com, or a link to your site or profile, like instagram.com/yourname.",
  },
  confirm: { tone: "error", text: "Nothing was added. Check the box below to confirm, then send it again." },
  limited: { tone: "error", text: "Too many tries from your connection for now. Nothing was added. Wait an hour and try again." },
  full: {
    tone: "error",
    text: "We cannot take new requests on this page right now, so nothing new was saved here. If you asked us before, you are still on our list.",
    email: "We keep room on the list for requests sent by email, and we will add you ourselves.",
  },
  error: { tone: "error", text: "That could not be saved just now, so nothing was added. Try again in a moment.", email: "We will add you ourselves." },
  // The operator's look-up, when the page was sent without JavaScript (app/api/operator/do-not-contact/check).
  "check-listed": { tone: "ok", text: "That contact is on the do-not-contact list. Do not contact it for research." },
  "check-clear": { tone: "ok", text: "That contact is not on the do-not-contact list." },
  "check-unknown": { tone: "error", text: "The list could not be read just now. Do not contact anyone for research until it can." },
  "check-contact": { tone: "error", text: "That is not an email address or a link the list can check." },
};

/** Answers the server sends back after which what was typed is put back in the form (WCAG 3.3.7). */
const PUT_BACK = new Set(["contact", "confirm", "limited", "full", "error"]);
/** This tab's copy of what was typed, kept only until the list says done; never in a URL. */
const DRAFT = "dnc-draft";

function tabStorage(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** What this tab kept of what was typed, as it was kept ("" for nothing): read, never subscribed to, as nothing else writes it. */
function draftText(): string {
  try {
    return tabStorage()?.getItem(DRAFT) ?? "";
  } catch {
    return "";
  }
}
const noChanges = () => () => {};

function draftOf(text: string): { contact: string; name: string } {
  try {
    const kept = JSON.parse(text || "null") as { contact?: unknown; name?: unknown } | null;
    return {
      contact: kept && typeof kept.contact === "string" ? kept.contact.slice(0, CONTACT_MAX_LENGTH) : "",
      name: kept && typeof kept.name === "string" ? kept.name.slice(0, NAME_MAX_LENGTH) : "",
    };
  } catch {
    return { contact: "", name: "" };
  }
}

const LOOKUP_WORDS: Record<string, string> = {
  listed: STATUS["check-listed"].text,
  clear: STATUS["check-clear"].text,
  unknown: STATUS["check-unknown"].text,
  contact: STATUS["check-contact"].text,
};

/**
 * The form of /privacy/do-not-contact (lib/research-do-not-contact.ts). It
 * checks the contact detail in the browser the way the server does
 * (lib/research-contact.ts), so a wrong one is said at the field with what
 * was typed still in it (WCAG 3.3.7), and nothing typed goes in a URL; when
 * the server sends the page back without saving, what was typed comes back
 * from this tab's own storage, forgotten once the list says done. An entry
 * cannot be taken back from the page, so the person confirms it first in a
 * box with a 44 by 44 target (3.3.6, 2.5.5), marked when it was missed. A
 * notice, sent back by the server or found here, takes the focus once. The
 * operator's form posts to the operator's route, above the public ceiling
 * (app/api/operator/do-not-contact), and the operator can look a contact up
 * before writing to someone by hand (app/api/operator/do-not-contact/check).
 */
export function DoNotContactForm({ status, operator }: { status: string; operator: boolean }) {
  // After an answer that saved nothing, what was typed comes back from this tab; on the server, and otherwise, nothing.
  const kept = useSyncExternalStore(noChanges, () => (PUT_BACK.has(status) ? draftText() : ""), () => "");
  const draft = useMemo(() => draftOf(kept), [kept]);
  const [typedContact, setContact] = useState<string | null>(null);
  const [typedName, setName] = useState<string | null>(null);
  const contact = typedContact ?? draft.contact;
  const name = typedName ?? draft.name;
  const [wrong, setWrong] = useState(0);
  const [lookup, setLookup] = useState("");
  const [answer, setAnswer] = useState("");
  const notice = useRef<HTMLParagraphElement>(null);
  const shown = wrong > 0 ? STATUS.contact : Object.hasOwn(STATUS, status) ? STATUS[status] : undefined;
  const shownKey = wrong > 0 ? `contact-${wrong}` : status;
  const invalid = wrong > 0 || status === "contact";
  const unconfirmed = wrong === 0 && status === "confirm";

  useEffect(() => {
    if (shown) notice.current?.focus();
  }, [shown, shownKey]);

  useEffect(() => {
    if (status !== "done") return;
    try {
      tabStorage()?.removeItem(DRAFT);
    } catch {
      // Nothing kept to forget.
    }
  }, [status]);

  function send(event: FormEvent<HTMLFormElement>) {
    if (!normalizeResearchContact(contact)) {
      event.preventDefault();
      setWrong((times) => times + 1);
      return;
    }
    try {
      tabStorage()?.setItem(DRAFT, JSON.stringify({ contact, name }));
    } catch {
      // Not kept: only putting it back after a server error is lost.
    }
  }

  async function look(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAnswer("");
    try {
      const response = await fetch("/api/operator/do-not-contact/check", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ contact: lookup }),
      });
      const said = response.ok ? ((await response.json()) as { state?: unknown }).state : null;
      setAnswer(typeof said === "string" && Object.hasOwn(LOOKUP_WORDS, said) ? LOOKUP_WORDS[said] : LOOKUP_WORDS.unknown);
    } catch {
      setAnswer(LOOKUP_WORDS.unknown);
    }
  }

  return (
    <>
      {shown ? (
        <p
          ref={notice}
          tabIndex={-1}
          id="dnc-status"
          role={shown.tone === "ok" ? "status" : "alert"}
          className={`notice ${shown.tone === "ok" ? "notice-success" : "notice-error"} mb-6`}
        >
          {shown.text}
          {shown.email ? (
            <>
              {" "}You can also email{" "}
              <a href={`mailto:${SUPPORT}`} className="underline underline-offset-4">{SUPPORT}</a>{" "}
              and ask us to stop. {shown.email}
            </>
          ) : null}
        </p>
      ) : null}
      <form action={operator ? "/api/operator/do-not-contact" : "/api/privacy/do-not-contact"} method="post" onSubmit={send} className="card p-6 sm:p-8">
        {operator ? (
          <p className="notice mb-5">
            You are signed in as the person who runs Marktmorgen. This adds a request someone sent by email, outside this page&apos;s public limits.
          </p>
        ) : null}
        <div aria-hidden="true" className="hidden">
          <label>
            Leave this empty
            <input type="text" name={DO_NOT_CONTACT_TRAP} tabIndex={-1} autoComplete="off" data-1p-ignore="true" data-lpignore="true" />
          </label>
        </div>
        <label htmlFor="dnc-contact" className="field-label">
          Your email address or profile link
        </label>
        <p id="dnc-contact-hint" className="mt-1 text-sm text-ink-soft">
          The one we used to reach you. For example: you@example.com or instagram.com/yourname.
        </p>
        <input
          id="dnc-contact"
          name="contact"
          type="text"
          required
          maxLength={CONTACT_MAX_LENGTH}
          autoComplete="email"
          spellCheck={false}
          autoCapitalize="none"
          value={contact}
          onChange={(event) => {
            setContact(event.currentTarget.value);
          }}
          aria-describedby={invalid ? "dnc-contact-hint dnc-status" : "dnc-contact-hint"}
          aria-invalid={invalid ? true : undefined}
          className="field mt-2"
        />
        <label htmlFor="dnc-name" className="field-label mt-5 block">
          Your name (optional)
        </label>
        <p id="dnc-name-hint" className="mt-1 text-sm text-ink-soft">
          Only if you want us to know who asked. You can leave it empty.
        </p>
        <input
          id="dnc-name"
          name="name"
          type="text"
          maxLength={NAME_MAX_LENGTH}
          autoComplete="name"
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
          }}
          aria-describedby="dnc-name-hint"
          className="field mt-2"
        />
        <p id="dnc-confirm-hint" className="mt-5 text-sm text-ink-soft">
          Check the contact detail before you send it. If you typed one wrong, send the right one too: a wrong one only means we will not contact it.
        </p>
        <label htmlFor="dnc-confirm" className="mt-2 flex min-h-11 cursor-pointer items-start gap-3 py-2">
          <input
            id="dnc-confirm"
            name="confirm"
            type="checkbox"
            value="yes"
            required
            aria-describedby={unconfirmed ? "dnc-confirm-hint dnc-status" : "dnc-confirm-hint"}
            aria-invalid={unconfirmed ? true : undefined}
            className="mt-0.5 h-6 w-6 shrink-0"
          />
          <span>I checked it. This contact detail stays on our list, and this page cannot take it off.</span>
        </label>
        <button type="submit" className="btn btn-primary mt-5">
          Don&apos;t contact me
        </button>
        <p className="mt-4 text-sm text-ink-soft">
          We keep only what you type here, on our do-not-contact list, so that we can respect your request. Nothing on our site sends a research message without first checking that list.
        </p>
      </form>
      {operator ? (
        <form action="/api/operator/do-not-contact/check" method="post" onSubmit={look} className="card mt-6 p-6 sm:p-8">
          <h2 className="t-h3">Check a contact before you write</h2>
          <label htmlFor="dnc-lookup" className="field-label mt-3 block">
            Email address or profile link
          </label>
          <input
            id="dnc-lookup"
            name="contact"
            type="text"
            required
            maxLength={CONTACT_MAX_LENGTH}
            spellCheck={false}
            autoCapitalize="none"
            value={lookup}
            onChange={(event) => {
              setLookup(event.currentTarget.value);
            }}
            className="field mt-2"
          />
          <button type="submit" className="btn btn-secondary mt-4">
            Check the list
          </button>
          <p role="status" className="mt-4 text-sm">
            {answer}
          </p>
        </form>
      ) : null}
    </>
  );
}
