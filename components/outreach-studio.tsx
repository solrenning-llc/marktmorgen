"use client";

import type { AiOff } from "@/lib/ai";

import { useState } from "react";
import { toast } from "@/components/toast";
import { MAX_AI_NOTES } from "@/lib/ai-rules";
import {
  type FoundAddress,
  MAX_PITCH_BODY,
  MAX_PITCH_SUBJECT,
  MAX_SENDER_ADDRESS,
  MAX_SENDER_NAME,
  OTHER_COUNTRY,
  OUTREACH_COUNTRIES,
  OUTREACH_GOALS,
  type OutreachGoal,
  PITCH_PROBLEMS,
  PITCHES_PER_DAY,
  type Pitch,
  type PitchProblem,
  type PitchStatus,
  type Sender,
  countryRule,
  countryWords,
  draftLinks,
  pitchText,
} from "@/lib/outreach-rules";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

type Site = { domain: string; home: string; company: string; about: string; found: (FoundAddress & { refuses: boolean })[] };

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  ...PITCH_PROBLEMS,
  address: "That does not look like a website address. Type it like brand.com.",
  unreadable: "Their website could not be read just now, or it asks not to be read. Try again, or try the address of their contact page.",
  unpublished: "That address is not printed on that page of their own website any more, so it is not written to.",
  notes: "Say in a sentence or two what you would offer them.",
  used: "This month's writing help is used up. It starts again on the first of the month.",
  off: "Writing help is not switched on for this store yet.",
  failed: "The email could not be written just now. Nothing was counted. Try again in a moment.",
  full: "Your list of pitches is full. Mark the old ones as answered or delete old drafts first.",
  room: STUDIO_MESSAGES.store_full,
  busy: "This can't be saved right now. Nothing was counted. Try again in a minute.",
  slow: "That was a lot in a short time. Wait a minute, then try again.",
  day: "That is today's limit of site reads. Try again tomorrow.",
  signed_out: "Your session ended. Log in again.",
  unknown: "That pitch is no longer here. Reload the page.",
  server_error: "Something went wrong on our side. Nothing was changed. Try again in a moment.",
};

const STATUS_WORDS: Record<PitchStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  replied: "They replied",
  deal: "It became a deal",
  stopped: "They asked you to stop",
};

async function post(payload: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/store/outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.ok === true) return { ok: true, data };
    // The server's own words first, where it gave them (a figure used, no place this month: lib/metered-limits.ts).
    if (typeof data.message === "string" && data.message) return { ok: false, error: data.message };
    return { ok: false, error: MESSAGES[typeof data.error === "string" ? data.error : ""] ?? MESSAGES.server_error };
  } catch {
    return { ok: false, error: MESSAGES.server_error };
  }
}

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

/** One pitch: the draft to read, change and open in the creator's own mailbox, or what became of it. */
function PitchCard({ pitch, onChange, onGone }: { pitch: Pitch; onChange: (next: Pitch) => void; onGone: (id: string) => void }) {
  const [subject, setSubject] = useState(pitch.subject);
  const [body, setBody] = useState(pitch.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = pitch.status === "draft";
  const text = pitchText(body, pitch.footer);
  const links = draftLinks(pitch.to, subject, text);
  const changed = subject.trim() !== pitch.subject || body.trim() !== pitch.body;

  async function run(payload: Record<string, unknown>, done: string, gone = false) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = await post({ id: pitch.id, ...payload });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.error);
      return;
    }
    toast(done);
    if (gone) onGone(pitch.id);
    else if (answer.data.pitch) onChange(answer.data.pitch as Pitch);
  }

  // What was opened is what is kept: a change is saved before the draft leaves the page.
  async function saveThen(open: () => void) {
    if (changed) {
      const answer = await post({ action: "edit", id: pitch.id, subject, body });
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      if (answer.data.pitch) onChange(answer.data.pitch as Pitch);
    }
    open();
  }

  return (
    <li className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-ink">{pitch.company}</h3>
          <p className="break-all text-sm text-ink-soft">{pitch.to}</p>
        </div>
        <span className={`tag ${pitch.status === "deal" || pitch.status === "replied" ? "tag-live" : ""}`}>{STATUS_WORDS[pitch.status]}</span>
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        {`Address printed on their own website, read ${day(pitch.foundAt)}: `}
        <a href={pitch.page} target="_blank" rel="noopener noreferrer nofollow" className="link break-all">
          {pitch.page}
        <NewTab /></a>
      </p>

      {draft ? (
        <>
          <label htmlFor={`subject-${pitch.id}`} className="field-label mt-4 block">
            Subject
          </label>
          <input id={`subject-${pitch.id}`} className="field mt-1" maxLength={MAX_PITCH_SUBJECT} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <label htmlFor={`body-${pitch.id}`} className="field-label mt-4 block">
            Your email. Read it and make it yours before you send it
          </label>
          <textarea id={`body-${pitch.id}`} className="field mt-1" rows={8} maxLength={MAX_PITCH_BODY} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="field-label mt-4">Added under it on every email, as the law asks</p>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-sand p-3 font-sans text-sm text-ink-soft">{pitch.footer}</pre>

          <div className="mt-4 flex flex-wrap gap-2">
            {links ? (
              <>
                <button type="button" disabled={busy} className="btn btn-primary btn-sm" onClick={() => saveThen(() => window.open(links.gmail, "_blank", "noopener"))}>
                  Open it in Gmail
                </button>
                <button type="button" disabled={busy} className="btn btn-secondary btn-sm" onClick={() => saveThen(() => (window.location.href = links.mailto))}>
                  Open it in my mail app
                </button>
              </>
            ) : null}
            <button
              type="button"
              disabled={busy}
              className="btn btn-secondary btn-sm"
              onClick={() =>
                saveThen(() => {
                  void navigator.clipboard?.writeText(`To: ${pitch.to}\nSubject: ${subject}\n\n${text}`);
                  toast("Copied. Paste it into a new email.");
                })
              }
            >
              Copy it
            </button>
          </div>
          <p className="field-hint mt-2">
            Each of these opens a draft in your own mailbox. Nothing is sent until you press Send there, and nothing is ever sent from here.
          </p>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
            <button type="button" disabled={busy} className="btn btn-secondary btn-sm" onClick={() => run({ action: "status", status: "sent" }, "Marked as sent.")}>
              I sent it
            </button>
            <button type="button" disabled={busy} className="btn btn-ghost btn-sm" onClick={() => run({ action: "drop" }, "Draft deleted.", true)}>
              Delete this draft
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-4 text-sm font-semibold text-ink">{pitch.subject}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{pitch.body}</p>
          {pitch.status !== "stopped" ? (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
              {pitch.status === "sent" ? (
                <button type="button" disabled={busy} className="btn btn-secondary btn-sm" onClick={() => run({ action: "status", status: "replied" }, "Marked as answered.")}>
                  They replied
                </button>
              ) : null}
              {pitch.status !== "deal" ? (
                <button type="button" disabled={busy} className="btn btn-secondary btn-sm" onClick={() => run({ action: "status", status: "deal" }, "Marked as a deal.")}>
                  It became a deal
                </button>
              ) : null}
              <button type="button" disabled={busy} className="btn btn-ghost btn-sm" onClick={() => run({ action: "status", status: "stopped" }, "Noted. Nothing more can be written to them from here.")}>
                They asked me to stop
              </button>
            </div>
          ) : (
            <p className="field-hint mt-3">Nothing more can be written to {pitch.domain} from this store.</p>
          )}
        </>
      )}
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** Why a pitch cannot be written here (lib/ai.ts, aiOffReason), in words true for that case only. */
const OFF_WORDS: Record<AiOff, string> = {
  plan: "Writing help comes with the Studio and Scale plans (Studio is labeled Pro in your studio) while the plan is paid up. This store is not on one of them now, so a pitch cannot be written here.",
  trial: "Writing help is not part of the free trial. It needs the plan to be paid up, so a pitch cannot be written here yet.",
  renewal_unpaid: "Your plan's renewal payment did not go through, so writing help is paused. Check the notice at the top of your studio to pay it.",
  plan_disputed: "A payment for your plan is disputed with your bank, so writing help is paused. Check the notice at the top of your studio for what happens next.",
  setup: "Writing help is not switched on for this store yet, so a pitch cannot be written here.",
};

export function OutreachStudio({ sender: saved, pitches: first, left, on, off = "setup", storeUrl }: { sender: Sender; pitches: Pitch[]; left: number; on: boolean; off?: AiOff | null; storeUrl: string }) {
  const [sender, setSender] = useState(saved);
  const [name, setName] = useState(saved.name);
  const [address, setAddress] = useState(saved.address);
  const [pitches, setPitches] = useState(first);
  const [goal, setGoal] = useState<OutreachGoal>("sponsor");
  const [site, setSite] = useState("");
  const [country, setCountry] = useState("US");
  const [isCompany, setIsCompany] = useState(false);
  const [notes, setNotes] = useState("");
  const [found, setFound] = useState<Site | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState<"sender" | "find" | "draft" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState(left);

  const rule = countryRule(country);
  const senderReady = sender.name !== "" && sender.address !== "";
  const why = (a: FoundAddress & { refuses: boolean }): PitchProblem | null => (a.refuses ? "refuses" : rule.roleOnly && !a.role ? "person" : null);

  async function saveSender(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("sender");
    setError(null);
    const answer = await post({ action: "sender", name, address });
    setBusy(null);
    if (!answer.ok) return setError(answer.error);
    setSender(answer.data.sender as Sender);
    toast("Saved. It goes under every pitch.");
  }

  async function find(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy("find");
    setError(null);
    setFound(null);
    setChosen("");
    const answer = await post({ action: "find", site });
    setBusy(null);
    if (!answer.ok) return setError(answer.error);
    const read = answer.data.site as Site;
    setFound(read);
    setChosen(read.found.find((a) => why(a) === null)?.email ?? "");
  }

  async function write() {
    if (busy || !found) return;
    const address = found.found.find((a) => a.email === chosen);
    if (!address) return;
    setBusy("draft");
    setError(null);
    const answer = await post({ action: "draft", goal, country, isCompany, page: address.page, email: address.email, company: found.company, about: found.about, notes });
    setBusy(null);
    if (!answer.ok) return setError(answer.error);
    // A new draft takes the place of an older one to the same business.
    const gone = Array.isArray(answer.data.replaced) ? (answer.data.replaced as string[]) : [];
    setPitches((all) => [answer.data.pitch as Pitch, ...all.filter((p) => !gone.includes(p.id))]);
    setJobs(typeof answer.data.left === "number" ? answer.data.left : jobs);
    setFound(null);
    setSite("");
    toast("Written. Read it below, then open it in your own mailbox.");
  }

  return (
    <div className="mt-8 grid gap-6">
      <section className="card p-6 sm:p-8" aria-labelledby="who-title">
        <h2 id="who-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Who is writing
        </h2>
        <p className="mt-1 text-sm text-ink-soft">
          Your name and a postal address go under every pitch. An email to a business that does not say who sent it, or where they can be reached, is
          against the law in most places this writes to. A P.O. box or a registered business address is fine.
        </p>
        <form onSubmit={saveSender} className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="out-name" className="field-label">
              Your name
            </label>
            <input id="out-name" className="field mt-1" maxLength={MAX_SENDER_NAME} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="out-address" className="field-label">
              Your postal address
            </label>
            <input id="out-address" className="field mt-1" maxLength={MAX_SENDER_ADDRESS} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city, postal code, country" required />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" aria-busy={busy === "sender"} disabled={busy !== null || (name.trim() === sender.name && address.trim() === sender.address)} className="btn btn-secondary btn-sm">
              {busy === "sender" ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </section>

      <section className="card p-6 sm:p-8" aria-labelledby="new-title">
        <h2 id="new-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Write to a business
        </h2>
        {!on ? (
          <p className="notice notice-warn mt-4">
            {OFF_WORDS[off ?? "setup"]}
          </p>
        ) : !senderReady ? (
          <p className="notice notice-info mt-4">Save your name and postal address above first.</p>
        ) : (
          <form onSubmit={find} className="mt-4">
            <fieldset>
              <legend className="field-label">What you are looking for</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                {OUTREACH_GOALS.map((g) => (
                  <label key={g.id} className={`flex min-h-[44px] cursor-pointer flex-col gap-1 rounded-xl border-2 p-3 focus-within:ring-2 focus-within:ring-violet-brand ${goal === g.id ? "border-violet-brand bg-violet-brand/5" : "border-line hover:border-violet-brand/50"}`}>
                    <input type="radio" name="goal" value={g.id} checked={goal === g.id} onChange={() => setGoal(g.id)} className="sr-only" />
                    <span className="text-sm font-bold text-ink">{g.label}</span>
                    <span className="text-xs leading-snug text-ink-soft">{g.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="out-site" className="field-label">
                  Their website
                </label>
                <input id="out-site" className="field mt-1" value={site} onChange={(e) => setSite(e.target.value)} placeholder="brand.com" inputMode="url" autoCapitalize="none" required />
              </div>
              <div>
                <label htmlFor="out-country" className="field-label">
                  The country the business is in
                </label>
                <select id="out-country" className="field mt-1" value={country} onChange={(e) => setCountry(e.target.value)}>
                  {OUTREACH_COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.allowed ? c.name : `${c.name} (not from here)`}
                    </option>
                  ))}
                  <option value={OTHER_COUNTRY.code}>{`${OTHER_COUNTRY.name} (not from here yet)`}</option>
                </select>
              </div>
            </div>
            {!rule.allowed ? (
              <p className="notice notice-warn mt-4" role="status">
                {rule.why}
              </p>
            ) : (
              <>
                {rule.companiesOnly ? (
                  <label className="mt-4 flex min-h-[44px] cursor-pointer items-start gap-3 text-sm text-ink">
                    <input type="checkbox" className="mt-1 h-5 w-5 flex-none" checked={isCompany} onChange={(e) => setIsCompany(e.target.checked)} />
                    <span>{`This is a company (a limited company, an LLP or the like), not one person trading under their own name. In ${countryWords(rule)}, a sole trader may only be written to after they agree.`}</span>
                  </label>
                ) : null}
                <label htmlFor="out-notes" className="field-label mt-5 block">
                  What you would offer them, and anything true about the people who follow you
                </label>
                <textarea id="out-notes" className="field mt-1" rows={4} maxLength={MAX_AI_NOTES} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="I post three recipes a week for families cooking on a budget. I would feature their pans in a recipe video and link them on my store." required />
                <p className="field-hint mt-1">Only what you type here is used. No number of followers or buyers is written unless you give it.</p>
                <button type="submit" aria-busy={busy === "find"} disabled={busy !== null || (rule.companiesOnly === true && !isCompany)} className="btn btn-primary mt-5">
                  {busy === "find" ? "Reading their website…" : "Find where they ask to be written"}
                </button>
              </>
            )}
          </form>
        )}

        {found ? (
          <div className="mt-6 border-t border-line pt-6" aria-live="polite">
            <h3 className="font-semibold text-ink">{found.company}</h3>
            {found.about ? <p className="mt-1 text-sm text-ink-soft">{found.about}</p> : null}
            {found.found.length === 0 ? (
              <p className="notice notice-info mt-4">
                {`No address at ${found.domain} is printed on the pages we read. Many businesses use a contact form instead: `}
                <a href={found.home} target="_blank" rel="noopener noreferrer nofollow" className="link">
                  open their site
                <NewTab /></a>
                {" and look for it. Nothing is written to an address that the business did not publish itself."}
              </p>
            ) : (
              <fieldset className="mt-4">
                <legend className="field-label">Addresses printed on their own website</legend>
                <div className="mt-2 grid gap-2">
                  {found.found.map((a) => {
                    const problem = why(a);
                    return (
                      <label key={a.email} className={`flex min-h-[44px] items-start gap-3 rounded-xl border-2 p-3 ${problem ? "border-line opacity-70" : chosen === a.email ? "cursor-pointer border-violet-brand bg-violet-brand/5" : "cursor-pointer border-line hover:border-violet-brand/50"}`}>
                        <input type="radio" name="address" className="mt-1 h-5 w-5 flex-none" value={a.email} disabled={problem !== null} checked={chosen === a.email} onChange={() => setChosen(a.email)} />
                        <span className="min-w-0">
                          <span className="block break-all text-sm font-bold text-ink">{a.email}</span>
                          <span className="block text-xs text-ink-soft">
                            {"Printed on "}
                            <a href={a.page} target="_blank" rel="noopener noreferrer nofollow" className="link break-all">
                              {a.page}
                            <NewTab /></a>
                          </span>
                          {problem ? <span className="mt-1 block text-xs font-semibold text-ink">{PITCH_PROBLEMS[problem]}</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <button type="button" onClick={write} aria-busy={busy === "draft"} disabled={busy !== null || chosen === ""} className="btn btn-primary mt-5">
                  {busy === "draft" ? "Writing…" : "Write the email"}
                </button>
                <p className="field-hint mt-2">{`Uses one of this month's writing jobs (${jobs} left). At most ${PITCHES_PER_DAY} pitches a day.`}</p>
              </fieldset>
            )}
          </div>
        ) : null}
        {error ? (
          <p className="notice notice-error mt-4" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="list-title">
        <h2 id="list-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Your pitches
        </h2>
        {pitches.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">{`None yet. Each one ends with your name, ${storeUrl} and your postal address.`}</p>
        ) : (
          <ul className="mt-4 grid gap-4">
            {pitches.map((pitch) => (
              <PitchCard key={pitch.id} pitch={pitch} onChange={(next) => setPitches((all) => all.map((p) => (p.id === next.id ? next : p)))} onGone={(id) => setPitches((all) => all.filter((p) => p.id !== id))} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
