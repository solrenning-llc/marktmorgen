"use client";

import { ELSEWHERE_NOTE, MAX_REVIEW_URL, parseReviewElsewhere } from "@/lib/review-elsewhere";
import { UrlField } from "@/components/url-field";
import { checkWith } from "@/lib/url-check";
import { useContext, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { Stars } from "@/components/review-stars";
import { toast } from "@/components/toast";
import { HIDE_REASONS, MAX_REPLY_TEXT, hideReasonLabel } from "@/lib/review-summary";
import { AiOn } from "@/components/ai-assist";
import { DEFAULT_ASK_DAYS, MAX_AGAIN_DAYS, MAX_ASK_DAYS, MIN_AGAIN_DAYS, MIN_ASK_DAYS } from "@/lib/review-ask";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  days: `Pick between ${MIN_ASK_DAYS} and ${MAX_ASK_DAYS} days.`,
  again: `Pick no reminder, or one ${MIN_AGAIN_DAYS} to ${MAX_AGAIN_DAYS} days after the first email.`,
  elsewhere: "That is not a review page on Google, Trustpilot or Facebook. Paste the https address of your page there.",
  email: "Review requests are email, so they need Pro with your email set up (the sender name and postal address). Set that up in Email first.",
  busy: "Someone else changed this review at the same moment. Try again.",
  missing: "That review is not there anymore: its buyer may have deleted it. Reload the page.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "Stores are not switched on yet, so nothing was saved.",
  server_error: "Something went wrong on our side. Try again in a moment.",
};

// The review page, checked when its field is left by the reading the server keeps (lib/review-elsewhere.ts). Optional.
const ELSEWHERE_CHECK = checkWith((raw) => parseReviewElsewhere(raw)?.url ?? null, MESSAGES.elsewhere, MAX_REVIEW_URL);

async function post(body: Record<string, unknown>): Promise<string | null> {
  try {
    const response = await fetch("/api/store/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return data.ok ? null : MESSAGES[data.error ?? ""] ?? MESSAGES.server_error;
  } catch {
    return MESSAGES.server_error;
  }
}

/** The review-request email: off, or on some days after buying, with one reminder or none (636 [GL4](a)). */
export function ReviewAskEditor({ days, canEmail, elsewhere = "", again = 0 }: { days: number; canEmail: boolean; elsewhere?: string; again?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(days > 0);
  const [value, setValue] = useState(days > 0 ? days : DEFAULT_ASK_DAYS);
  const [page, setPage] = useState(elsewhere);
  const [reminder, setReminder] = useState(again);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = on !== days > 0 || (on && value !== days) || page.trim() !== elsewhere || (on && reminder !== again);

  async function save() {
    setError(null);
    // The same rule the server holds (lib/review-elsewhere.ts), said before anything is sent.
    if (page.trim() && !parseReviewElsewhere(page)) {
      // The field says it beside itself (components/url-field.tsx); the focus goes there, so it is not said twice.
      const field = document.getElementById("ask-elsewhere");
      if (field) field.focus();
      else setError(MESSAGES.elsewhere);
      return;
    }
    setBusy(true);
    const problem = await post({ action: "ask", days: on ? value : 0, elsewhere: page.trim(), again: reminder });
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    toast(on ? "Review requests saved." : "Review requests switched off.");
    router.refresh();
  }

  return (
    <div>
      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 font-semibold text-ink">
        <input type="checkbox" className="h-5 w-5" checked={on} disabled={!canEmail && !on} onChange={(e) => setOn(e.target.checked)} />
        Email buyers to ask for a review
      </label>
      {on ? (
        <label htmlFor="ask-days" className="mt-2 block max-w-xs">
          <span className="field-label">Days after buying</span>
          <select id="ask-days" className="field" value={value} onChange={(e) => setValue(Number(e.target.value))}>
            {Array.from({ length: MAX_ASK_DAYS - MIN_ASK_DAYS + 1 }, (_, i) => i + MIN_ASK_DAYS).map((d) => (
              <option key={d} value={d}>{`${d} days`}</option>
            ))}
          </select>
        </label>
      ) : null}
      {on ? (
        <label htmlFor="ask-again" className="mt-3 block max-w-xs">
          <span className="field-label">One reminder (optional)</span>
          <select id="ask-again" className="field" value={reminder} onChange={(e) => setReminder(Number(e.target.value))} aria-describedby="ask-again-note">
            <option value={0}>No reminder</option>
            {Array.from({ length: MAX_AGAIN_DAYS - MIN_AGAIN_DAYS + 1 }, (_, i) => i + MIN_AGAIN_DAYS).map((d) => (
              <option key={d} value={d}>{`${d} days after the first email`}</option>
            ))}
          </select>
          <span id="ask-again-note" className="mt-1 block text-xs text-ink-soft">
            Only to buyers who have not reviewed yet, and never more than one. The first email says it will come; the reminder says it is the last.
          </span>
        </label>
      ) : null}
      {on ? (
        <div className="mt-3 block max-w-xl">
          <label htmlFor="ask-elsewhere" className="field-label">Your public review page (optional)</label>
          <UrlField
            id="ask-elsewhere"
            className="field"
            placeholder="https://g.page/r/…/review"
            value={page}
            onChange={setPage}
            check={ELSEWHERE_CHECK}
            describedBy="ask-elsewhere-note"
          />
          <span id="ask-elsewhere-note" className="mt-1 block text-xs text-ink-soft">{ELSEWHERE_NOTE}</span>
        </div>
      ) : null}
      <p className="mt-2 text-sm text-ink-soft">
        {canEmail
          ? `${reminder ? "One email per order, and one reminder if you chose it" : "One email per order"}, from your name, only for orders paid while this is on and not refunded, and never to someone who already reviewed it, left your list or pressed stop. It counts in your month's emails and carries your postal address and a one-click way to stop. It asks for an honest review and offers nothing in return.`
          : "Review requests are email, so they need Pro with your email set up: the sender name and postal address every email carries. Buyers can still review from their thank-you page and their list of purchases on every plan."}
      </p>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      {dirty ? (
        <button type="button" onClick={save} disabled={busy} aria-busy={busy} className="btn btn-primary mt-3">
          {busy ? "Saving…" : "Save"}
        </button>
      ) : null}
    </div>
  );
}

export type StudioReview = {
  id: string;
  productId: string;
  productTitle: string;
  reference: string;
  rating: number;
  text: string;
  name: string;
  date: string;
  edited: string;
  hidden: boolean;
  /** The review rule it was hidden for (HIDE_REASONS); empty when none was kept. */
  hiddenReason: string;
  refunded: boolean;
  reply: string;
  unseen: boolean;
  /** The buyer's photo, by its address; null when there is none. */
  photo: string | null;
};

/** One review in the studio: what the buyer wrote, and what the creator may do about it. */
export function ReviewRow({ review }: { review: StudioReview }) {
  const router = useRouter();
  const ai = useContext(AiOn);
  const [drafting, setDrafting] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);

  /** A reply drafted from the review as it is kept (lib/ai.ts, replyToReview), into the box, for the creator to change. */
  async function draft() {
    setDrafting(true);
    setAiNote(null);
    try {
      const response = await fetch("/api/store/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "reply", product: review.productId, id: review.id }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; value?: string; error?: string };
      if (data.ok && typeof data.value === "string") {
        setReply(data.value.slice(0, MAX_REPLY_TEXT));
        setAiNote("Drafted. Read it, make it yours, then post it.");
        return;
      }
      setAiNote(data.error === "used" ? "This month's writing help is used up. It starts again with your next billing month." : "The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.");
    } catch {
      setAiNote("The writing help did not answer just now. Your content was not changed. Started attempts count toward the monthly allowance.");
    } finally {
      setDrafting(false);
    }
  }
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState(review.reply);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which reason picker is open: to hide the review, or to take its photo off. */
  const [picking, setPicking] = useState<"hide" | "photo" | null>(null);
  const hiding = picking !== null;
  const setHiding = (open: boolean) => setPicking(open ? "hide" : null);
  const [reason, setReason] = useState("");
  /** The button that opened the reasons, where focus goes back when they close. */
  const opener = useRef<HTMLButtonElement>(null);
  const closeReasons = () => {
    setHiding(false);
    setReason("");
    opener.current?.focus();
  };
  /** Hidden before reasons were kept: the creator is asked to name the rule, or to show it again. */
  const noReason = review.hidden && !hideReasonLabel(review.hiddenReason);

  async function act(kind: string, body: Record<string, unknown>, done: string): Promise<boolean> {
    setBusy(kind);
    setError(null);
    const problem = await post({ product: review.productId, id: review.id, ...body });
    setBusy(null);
    if (problem) {
      setError(problem);
      return false;
    }
    toast(done);
    setReplying(false);
    router.refresh();
    return true;
  }

  const base = `rv-${review.id}`;
  return (
    <li className={`rounded-2xl border bg-white p-4 sm:p-5 ${review.unseen ? "border-violet-brand/40" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-violet-deep">
          <Stars value={review.rating} size={16} label={`${review.rating} out of 5 stars`} />
        </span>
        <span className="font-semibold text-ink">{review.name || "Verified buyer"}</span>
        {review.unseen ? <span className="tag tag-brand">New</span> : null}
        {review.hidden ? <span className="tag">{hideReasonLabel(review.hiddenReason) ? `Hidden: ${hideReasonLabel(review.hiddenReason)}` : "Hidden"}</span> : null}
        {review.refunded ? <span className="tag">Refunded, not counted</span> : null}
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        {`${review.productTitle} · ${review.date}${review.edited ? ` · edited ${review.edited}` : ""}`}
      </p>
      {review.text ? (
        <p className="mt-3 whitespace-pre-line leading-relaxed text-ink [overflow-wrap:anywhere]">{review.text}</p>
      ) : (
        <p className="mt-3 text-sm italic text-ink-soft">Stars only, no words.</p>
      )}
      {review.photo ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <a href={review.photo} target="_blank" rel="noopener">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={review.photo} alt="The buyer's photo" className="h-24 w-24 rounded-xl object-cover ring-1 ring-line" loading="lazy" />
          <NewTab /></a>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            aria-expanded={picking === "photo"}
            aria-controls={picking === "photo" ? `${base}-hide` : undefined}
            onClick={(event) => { opener.current = event.currentTarget; setPicking(picking === "photo" ? null : "photo"); setReason(""); }}
          >
            <Icon name="trash" size={15} />
            {busy === "photo" ? "Taking it off…" : "Take the photo off"}
          </button>
        </div>
      ) : null}
      <p className="mt-3 break-all font-mono text-xs text-ink-mute">{`Order ${review.reference}`}</p>

      {review.reply && !replying ? (
        <div className="mt-3 rounded-xl bg-paper p-3 ring-1 ring-line">
          <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">Your public reply</p>
          <p className="mt-1 whitespace-pre-line text-sm text-ink [overflow-wrap:anywhere]">{review.reply}</p>
        </div>
      ) : null}

      {replying ? (
        <div className="mt-3">
          <label htmlFor={`${base}-reply`} className="field-label">
            Your reply, shown under the review
          </label>
          <textarea id={`${base}-reply`} className="field" rows={3} maxLength={MAX_REPLY_TEXT} value={reply} onChange={(e) => setReply(e.target.value)} />
          {ai.on ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className="btn btn-ghost btn-sm ring-1 ring-line" onClick={() => void draft()} disabled={drafting || busy !== null} aria-busy={drafting}>
                <Icon name="sparkle" size={15} />
                {drafting ? "Writing…" : reply.trim() ? "Draft another with AI" : "Draft it with AI"}
              </button>
              {aiNote ? (
                <span className="text-xs text-ink-soft" role="status">
                  {aiNote}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null || !reply.trim()}
              onClick={() => act("reply", { action: "reply", text: reply }, "Reply posted.")}
            >
              {busy === "reply" ? "Posting…" : "Post the reply"}
            </button>
            {review.reply ? (
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => act("reply", { action: "reply", text: "" }, "Reply removed.")}>
                Remove the reply
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setReplying(false); setReply(review.reply); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {!replying ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReplying(true)}>
            <Icon name="chat" size={15} />
            {review.reply ? "Edit your reply" : "Reply"}
          </button>
        ) : null}
        {review.hidden ? (
          <button
            type="button"
            ref={noReason ? undefined : opener}
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() => act("hide", { action: "hide", hidden: false }, "Review shown again.")}
          >
            <Icon name="eye" size={15} />
            Show it again
          </button>
        ) : (
          <button
            type="button"
            ref={opener}
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            aria-expanded={hiding}
            aria-controls={hiding ? `${base}-hide` : undefined}
            onClick={() => { setHiding(!hiding); setReason(""); }}
          >
            <Icon name="ban" size={15} />
            Hide from the page
          </button>
        )}
        {noReason ? (
          <button
            type="button"
            ref={opener}
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            aria-expanded={hiding}
            aria-controls={hiding ? `${base}-hide` : undefined}
            onClick={() => { setHiding(!hiding); setReason(""); }}
          >
            <Icon name="ban" size={15} />
            Name the rule it breaks
          </button>
        ) : null}
        {review.unseen ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy !== null}
            onClick={() => act("seen", { action: "seen", items: [`${review.productId}|${review.id}`] }, "Marked as seen.")}
          >
            <Icon name="check" size={15} />
            Mark as seen
          </button>
        ) : null}
      </div>

      {noReason ? (
        <p className="mt-2 text-sm text-ink-soft">
          This review was hidden before a reason was kept. Name the review rule it breaks, or show it again.
        </p>
      ) : null}

      {picking === "photo" || (picking === "hide" && (!review.hidden || noReason)) ? (
        <fieldset id={`${base}-hide`} className="mt-3 rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-ink">{picking === "photo" ? "Which review rule does the photo break?" : "Which review rule does it break?"}</legend>
          <p className="text-sm text-ink-soft">
            {picking === "photo"
              ? "A buyer's photo is taken off only for one of these rules, the same for every rating. A photo that shows a problem with the product is not a reason to take it off."
              : "A review is hidden only for one of these rules, the same for every rating. A low star rating or criticism is not a reason to hide a review. Its stars stay in your average either way."}
          </p>
          <div className="mt-2 space-y-2">
            {HIDE_REASONS.map((option, index) => (
              <label key={option.id} className="flex min-h-11 cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name={`${base}-reason`}
                  value={option.id}
                  checked={reason === option.id}
                  onChange={() => setReason(option.id)}
                  className="mt-1 h-5 w-5 shrink-0"
                  autoFocus={index === 0}
                />
                <span>
                  <span className="font-semibold text-ink">{option.label}</span>
                  <span className="block text-ink-soft">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy !== null || !reason}
              onClick={() => {
                const done = picking === "photo"
                  ? act("photo", { action: "photo", reason }, "Photo taken off the review.")
                  : act("hide", { action: "hide", hidden: true, reason }, "Review hidden.");
                void done.then((ok) => { if (ok) closeReasons(); });
              }}
            >
              {busy === "hide" ? "Hiding…" : busy === "photo" ? "Taking it off…" : picking === "photo" ? "Take the photo off for this reason" : "Hide for this reason"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={closeReasons}>
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
    </li>
  );
}

/** Empties the queue of new reviews in one press. */
export function SeenAllButton({ count }: { count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const problem = await post({ action: "seen", all: true });
        setBusy(false);
        if (!problem) {
          toast("All marked as seen.");
          router.refresh();
        }
      }}
    >
      <Icon name="check" size={15} />
      {`Mark all ${count} as seen`}
    </button>
  );
}
