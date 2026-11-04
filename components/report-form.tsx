"use client";

import { useState } from "react";
import { UrlField } from "@/components/url-field";
import { type LinkCheck, checkWith } from "@/lib/url-check";
import { reportAnswer } from "@/lib/report-response";
import { MAX_REPORT_CONTACT, MAX_REPORT_NAME, MAX_REPORT_TEXT, MAX_REPORT_URL, REPORT_PROBLEMS, type ReportKind } from "@/lib/takedown-rules";

// The page's address, checked when its field is left by the reading the notice is held to (lib/takedown-rules.ts), and required.
const URL_SHAPE = checkWith((raw) => (/^https?:\/\/\S+$/i.test(raw) ? raw : null), REPORT_PROBLEMS.url, MAX_REPORT_URL);
const REPORT_URL_CHECK: LinkCheck = (raw) => (raw.trim() ? URL_SHAPE(raw) : { problem: REPORT_PROBLEMS.url, fix: null });

/**
 * The notice form (app/report, lib/takedown.ts): each thing a copyright
 * notice must say, asked for by name, and checked before it is sent; what is
 * missing is said beside the form, and nothing typed is lost.
 */
export function ReportForm({ url: given }: { url: string }) {
  const [kind, setKind] = useState<ReportKind>("copyright");
  const [fields, setFields] = useState({ url: given, work: "", original: "", name: "", email: "", contact: "", signature: "" });
  const [goodFaith, setGoodFaith] = useState(false);
  const [accurate, setAccurate] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const set = (name: keyof typeof fields) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setFields({ ...fields, [name]: event.target.value });
  const copyright = kind === "copyright";

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (state === "sending") return;
    // An address the notice would refuse, or one too long to keep whole, is not sent: the field says why.
    if (REPORT_URL_CHECK(fields.url).problem) {
      document.getElementById("report-url")?.focus();
      return;
    }
    setState("sending");
    setError("");
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ...fields, goodFaith, accurate }),
      });
      const raw: unknown = await response.json().catch(() => null);
      const answer = reportAnswer(response.ok, raw);
      if (answer.ok) {
        setState("sent");
        return;
      }
      setState("idle");
      setError(answer.message);
    } catch {
      setState("idle");
      setError("It could not be sent just now. Try again in a moment, or email support@marktmorgen.com.");
    }
  }

  if (state === "sent") {
    return (
      <div role="status" className="card p-6 sm:p-8">
        <p className="text-lg font-semibold text-ink">Your notice was sent</p>
        <p className="mt-2 text-ink-soft">
          We read it and act on it as our Copyright and Takedown Policy says. If we need anything else, we write to the
          email address you gave. No copy is emailed to you.
        </p>
      </div>
    );
  }

  const field = "field mt-2";
  return (
    <form onSubmit={send} noValidate className="card space-y-5 p-6 sm:p-8">
      <div aria-hidden="true" className="hidden">
        <label>
          Leave this empty
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <fieldset>
        <legend className="field-label">What is the notice about?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {([["copyright", "Copyright infringement"], ["other", "Other illegal content"]] as const).map(([value, label]) => (
            <label key={value} className="flex items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3 text-ink">
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} className="size-5 accent-violet-brand" />
              <span className="font-semibold">{label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="report-url" className="field-label">The page on Marktmorgen</label>
        <UrlField id="report-url" value={fields.url} onChange={(url) => setFields({ ...fields, url })} check={REPORT_URL_CHECK} describedBy="report-url-help" placeholder="https://marktmorgen.com/@store/p/…" className={field} />
        <p id="report-url-help" className="mt-1 text-sm text-ink-soft">The store page or the product page, and in what you write below, which part of it.</p>
      </div>
      <div>
        <label htmlFor="report-work" className="field-label">{copyright ? "The work that was copied, and what on the page copies it" : "What the content is, and why it is illegal"}</label>
        <textarea id="report-work" required rows={5} maxLength={MAX_REPORT_TEXT} value={fields.work} onChange={set("work")} className={field} />
      </div>
      {copyright ? (
        <div>
          <label htmlFor="report-original" className="field-label">Where the original can be seen (optional)</label>
          <input id="report-original" type="url" maxLength={MAX_REPORT_URL} value={fields.original} onChange={set("original")} placeholder="https://" className={field} />
        </div>
      ) : null}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="report-name" className="field-label">Your full name</label>
          <input id="report-name" required maxLength={MAX_REPORT_NAME} autoComplete="name" value={fields.name} onChange={set("name")} className={field} />
        </div>
        <div>
          <label htmlFor="report-email" className="field-label">Your email</label>
          <input id="report-email" type="email" required maxLength={MAX_REPORT_CONTACT} autoComplete="email" value={fields.email} onChange={set("email")} className={field} />
        </div>
      </div>
      <div>
        <label htmlFor="report-contact" className="field-label">{copyright ? "Your postal address or telephone number" : "Your postal address or telephone number (optional)"}</label>
        <input id="report-contact" maxLength={MAX_REPORT_CONTACT} value={fields.contact} onChange={set("contact")} className={field} />
      </div>
      <fieldset className="space-y-3">
        <legend className="field-label">Your statements</legend>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-violet-brand" />
          <span>
            {copyright
              ? "I believe in good faith that the use described above is not authorized by the copyright owner, its agent or the law."
              : "I believe in good faith that the content described above is illegal, for the reasons I gave."}
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" checked={accurate} onChange={(e) => setAccurate(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-violet-brand" />
          <span>
            {copyright
              ? "The information in this notice is accurate, and, under penalty of perjury, I am the owner of the copyright or authorized to act on the owner's behalf."
              : "The information in this notice is accurate and complete to the best of my knowledge."}
          </span>
        </label>
      </fieldset>
      <div>
        <label htmlFor="report-signature" className="field-label">Your signature: type your full name</label>
        <input id="report-signature" required maxLength={MAX_REPORT_NAME} value={fields.signature} onChange={set("signature")} className={field} />
      </div>
      {error ? (
        <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-3 text-sm font-semibold text-ink">{error}</p>
      ) : null}
      <button type="submit" disabled={state === "sending"} aria-busy={state === "sending"} className="btn btn-primary">
        {state === "sending" ? "Sending…" : "Send the notice"}
      </button>
    </form>
  );
}
