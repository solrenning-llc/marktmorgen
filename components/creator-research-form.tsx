"use client";

import { Icon } from "@/components/icons";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { EmailField } from "@/components/email-field";
import {
  CONSENT_FOLLOWUP_TEXT,
  CONSENT_RESEARCH_TEXT,
  CONSENT_UPDATES_TEXT,
  LIMITS,
  isSavedCreatorAnswer,
  PLATFORMS,
  PROBLEM_MIN_LENGTH,
  SUPPORT_EMAIL,
} from "@/lib/creator-research";

type Status = "idle" | "sending" | "sent" | "error";

const FIELD_MESSAGES: Record<string, string> = {
  name: "Please add your name.",
  email: "Please add a valid email address.",
  platform: "Please choose where you sell today.",
  link: "That link is too long.",
  country: "Please add your country.",
  problem: `Please describe the problem in at least ${PROBLEM_MIN_LENGTH} characters.`,
  tools: "That answer is too long.",
  cost: "That answer is too long.",
  consentResearch: "Please check the first box so we can store your answers.",
};

const inputClass = "field";
const fieldClass = inputClass;
const labelClass = "field-label mb-2";
const hintClass = "font-normal text-ink-mute";

export function CreatorResearchForm() {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [emailNote, setEmailNote] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const consentFollowUp = data.get("consentFollowUp") === "on";
    const consentUpdates = data.get("consentUpdates") === "on";

    setStatus("sending");
    setMessage("");

    try {
      const response = await fetch("/api/creators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          platform: data.get("platform"),
          link: data.get("link"),
          country: data.get("country"),
          problem: data.get("problem"),
          tools: data.get("tools"),
          cost: data.get("cost"),
          consentResearch: data.get("consentResearch") === "on",
          consentFollowUp,
          consentUpdates,
          website: data.get("website"),
        }),
      });

      const result: unknown = await response.json().catch(() => null);
      if (isSavedCreatorAnswer(response.ok, result)) {
        form.reset();
        setEmailNote(
          consentFollowUp
            ? "If a follow-up question would help, I'll email you."
            : consentUpdates
              ? "I'll email you only when Marktmorgen adds something for creators."
              : "You won't get any email from us about it.",
        );
        setStatus("sent");
        return;
      }

      const errorField = result && typeof result === "object" && !Array.isArray(result) &&
        Object.hasOwn(result, "field") ? (result as Record<string, unknown>).field : undefined;

      setStatus("error");
      if (response.status === 429) {
        setMessage(
          "Too many submissions from this connection. Please try again in an hour.",
        );
      } else if (typeof errorField === "string" && Object.hasOwn(FIELD_MESSAGES, errorField)) {
        setMessage(FIELD_MESSAGES[errorField]);
      } else {
        setMessage(
          `We could not confirm that your answers were saved. Please try again, or email ${SUPPORT_EMAIL}.`,
        );
      }
    } catch {
      setStatus("error");
      setMessage(
        `We could not confirm that your answers were saved. Please try again, or email ${SUPPORT_EMAIL}.`,
      );
    }
  }

  if (status === "sent") {
    return (
      <div role="status" className="nb-pop py-6 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-mint-soft text-mint-deep">
          <Icon name="check" size={28} strokeWidth={2.2} />
        </span>
        <p className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-ink">Thank you. Your answers were saved.</p>
        <p className="mx-auto mt-2 max-w-md text-ink-soft">I read every answer myself. {emailNote}</p>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={handleSubmit} className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className={labelClass}>
            Your name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            maxLength={LIMITS.name}
            autoComplete="name"
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <EmailField id="email" name="email" required autoComplete="email" maxLength={LIMITS.email} className={fieldClass} store={false} />
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="platform" className={labelClass}>
            Where do you sell today?
          </label>
          <select
            id="platform"
            name="platform"
            required
            defaultValue=""
            className={fieldClass}
          >
            <option value="" disabled>
              Choose one
            </option>
            {PLATFORMS.map((platform) => (
              <option key={platform} value={platform}>
                {platform}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="country" className={labelClass}>
            Country
          </label>
          <input
            id="country"
            name="country"
            type="text"
            required
            maxLength={LIMITS.country}
            autoComplete="country-name"
            className={fieldClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="link" className={labelClass}>
          Link to your store or profile{" "}
          <span className={hintClass}>(optional)</span>
        </label>
        <input
          id="link"
          name="link"
          type="text"
          maxLength={LIMITS.link}
          placeholder="stan.store/yourname or @yourname"
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="problem" className={labelClass}>
          What is the most annoying part of selling online right now?
        </label>
        <textarea
          id="problem"
          name="problem"
          required
          minLength={PROBLEM_MIN_LENGTH}
          maxLength={LIMITS.problem}
          rows={5}
          placeholder="The last time it happened, what went wrong?"
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="tools" className={labelClass}>
          Do you pay for any other tool to make your store work? Which one,
          and what for? <span className={hintClass}>(optional)</span>
        </label>
        <textarea
          id="tools"
          name="tools"
          maxLength={LIMITS.tools}
          rows={3}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="cost" className={labelClass}>
          Roughly how much time or money does that cost you in a normal month?{" "}
          <span className={hintClass}>(optional)</span>
        </label>
        <input
          id="cost"
          name="cost"
          type="text"
          maxLength={LIMITS.cost}
          placeholder="e.g. 3 hours, or $20"
          className={fieldClass}
        />
      </div>

      {/* Honeypot for bots. Hidden from people and screen readers. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      <div className="space-y-1 rounded-[var(--r-md)] border border-line bg-paper p-3">
        <label className="flex cursor-pointer gap-3 rounded-[10px] p-2.5 text-[15px] leading-6 text-ink transition-colors hover:bg-white">
          <input
            name="consentResearch"
            type="checkbox"
            required
            className="mt-1 h-5 w-5 shrink-0 accent-[color:var(--violet)]"
          />
          <span>{CONSENT_RESEARCH_TEXT}</span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-[10px] p-2.5 text-[15px] leading-6 text-ink transition-colors hover:bg-white">
          <input
            name="consentFollowUp"
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0 accent-[color:var(--violet)]"
          />
          <span>
            {CONSENT_FOLLOWUP_TEXT}{" "}
            <span className={hintClass}>(optional)</span>
          </span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-[10px] p-2.5 text-[15px] leading-6 text-ink transition-colors hover:bg-white">
          <input
            name="consentUpdates"
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0 accent-[color:var(--violet)]"
          />
          <span>
            {CONSENT_UPDATES_TEXT}{" "}
            <span className={hintClass}>(optional)</span>
          </span>
        </label>
      </div>

      {status === "error" && (
        <p
          role="alert"
          className="notice notice-error "
        >
          {message}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="submit"
          disabled={status === "sending"}
          className="btn btn-primary btn-lg"
        >
          {status === "sending" ? "Sending…" : "Send my answers"}
        </button>
        <p className="text-sm text-ink-soft">
          We never sell your answers.{" "}
          <Link
            href="/privacy"
            className="link"
          >
            Privacy Policy
          </Link>
        </p>
      </div>
    </form>
  );
}
