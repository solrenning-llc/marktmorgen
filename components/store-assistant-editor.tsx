"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/toast";
import {
  ASSISTANT_MESSAGES_MONTHLY,
  ASSISTANT_NAME,
  type AssistantPlan,
  type AssistantSetting,
  MAX_ASSISTANT_NOTES,
  assistantAllowanceWords,
  assistantPriceWords,
} from "@/lib/store-assistant-rules";
import type { NextOfferSetting } from "@/lib/next-offer-rules";
import type { AssistReminderSetting } from "@/lib/assistant-reminder-rules";
import { ASSIST_REMIND_KEEP_SECONDS } from "@/lib/assistant-reminder-rules";
import { assistReminderWords } from "@/lib/buyer-words/assistant-reminder";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const FAILED = "It could not be saved just now. Try again in a moment.";
/** The route compared what this page read with what is saved (lib/setting-expect.ts). */
const CHANGED = "Nothing was changed. This was changed in another tab or by someone else after this page loaded. Reload this page to see it before trying again.";

/** What the way back from Stripe, or a refusal, says (app/api/billing/assistant). */
const NOTICES: Record<string, string> = {
  on: "The Store assistant is on. Its chat shows on your store's pages while it is switched on below.",
  pending: "Stripe has not confirmed the payment yet. This page shows it as soon as it does.",
  unfinished: "Nothing was started, and nothing was charged.",
  unconfirmed: "Stripe did not answer just now. If you paid, it shows here within a day.",
  "not-open": "The Store assistant is not on sale yet: it opens with Marktmorgen's plans.",
  plan: "The Store assistant is for a store whose plan is paid, after its free trial.",
  already: "This store already has the Store assistant.",
  disputed: "A payment for the Store assistant on this store was disputed, so it cannot be started again. Write to support@marktmorgen.com.",
  customer: "Start your store's plan first: the assistant is charged to the same card.",
  stopping: "It stops at the end of the month already paid. Nothing more is charged.",
  resumed: "It renews again each month.",
  unavailable: "Billing is not set up on this deployment.",
  canceled: "Nothing was started, and nothing was charged.",
  error: "Something went wrong. Nothing was changed.",
};

/** A notice's words, read only from NOTICES' own keys: ?assistant=constructor or toString is none of them. */
const noticeOf = (key: string | null) => (key !== null && Object.hasOwn(NOTICES, key) ? NOTICES[key] : undefined);

/**
 * The Store assistant in the studio (lib/store-assistant-rules.ts): what it
 * is and costs, the add-on's state and this month's replies, the switch and
 * the creator's notes, and the questions it could not answer. The numbers
 * here are the code's own.
 */
export function StoreAssistantEditor({
  setting,
  next,
  remind,
  postal,
  plan,
  onSale,
  canBill,
  refusal,
  usage,
  missed,
  notice,
  pin,
}: {
  setting: AssistantSetting;
  next: NextOfferSetting;
  remind: AssistReminderSetting;
  /** Whether the store gave the postal address its reminders carry (components/recovery-editor.tsx). */
  postal: boolean;
  plan: AssistantPlan | null;
  onSale: boolean;
  canBill: boolean;
  refusal: string | null;
  usage: { left: number; answered: number } | null;
  missed: { question: string; at: number }[];
  notice: string;
  pin: string;
}) {
  const router = useRouter();
  const noticeText = noticeOf(notice);
  const refusalText = noticeOf(refusal);
  const [on, setOn] = useState(setting.on);
  const [notes, setNotes] = useState(setting.notes);
  const [nextOn, setNextOn] = useState(next.on);
  const [nextEmail, setNextEmail] = useState(next.email);
  const [remindOn, setRemindOn] = useState(remind.on);
  const [busy, setBusy] = useState<"save" | "clear" | "next" | "remind" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = on !== setting.on || notes.trim() !== setting.notes;
  const active = Boolean(plan?.active && plan.period);

  const nextChanged = nextOn !== next.on || (nextOn && nextEmail) !== next.email;

  async function post(body: Record<string, unknown>, what: "save" | "clear" | "next" | "remind", said: string) {
    setBusy(what);
    setError(null);
    try {
      const response = await fetch("/api/store/assistant-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: unknown };
      if (!data.ok) {
        setError(data.error === "changed" ? CHANGED : FAILED);
        return;
      }
      toast(said);
      router.refresh();
    } catch {
      setError(FAILED);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div id="assistant" className="card scroll-mt-32 p-6 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-lg font-semibold tracking-[-0.02em] text-ink">{ASSISTANT_NAME}</p>
        <span className="text-sm font-semibold text-ink-soft">{`Add-on · ${assistantPriceWords()}`}</span>
      </div>
      <p className="mt-2 text-ink-soft">
        A chat in the corner of every page of your store that answers buyers at any hour, in their language, only from what you published: your
        products, their prices and how each is delivered, the questions and refund promises on their pages, your store&apos;s questions and answers,
        and your notes below. Every reply is labeled as AI. When it does not know, or the question is a complaint, a refund request or a payment problem,
        it says so and passes the question to your inbox with the buyer&apos;s email, for you to answer.
      </p>
      <p className="mt-2 text-sm text-ink-soft">{assistantAllowanceWords()}</p>

      {noticeText ? (
        <p className="notice mt-4" role="status">
          {noticeText}
        </p>
      ) : null}

      <div className="mt-5 rounded-xl bg-paper px-4 py-3 ring-1 ring-line">
        {active && plan?.period ? (
          <>
            <p className="font-semibold text-ink">{plan.cancelsAtEnd ? `On until ${DATE.format(new Date(plan.period.end * 1000))}, then it stops` : `On. Renews ${DATE.format(new Date(plan.period.end * 1000))}`}</p>
            {usage ? (
              <p className="mt-1 text-sm text-ink-soft">{`${usage.answered.toLocaleString("en-US")} replies this month; room for at least ${usage.left.toLocaleString("en-US")} more of the ${ASSISTANT_MESSAGES_MONTHLY.toLocaleString("en-US")}.`}</p>
            ) : null}
            {canBill ? (
              <form method="post" action={`/api/billing/assistant${pin}`} className="mt-3">
                <input type="hidden" name="action" value={plan.cancelsAtEnd ? "resume" : "stop"} />
                <button type="submit" className="btn btn-ghost btn-sm">
                  {plan.cancelsAtEnd ? "Keep it after this month" : "Stop at the end of this month"}
                </button>
              </form>
            ) : null}
          </>
        ) : (
          <>
            <p className="font-semibold text-ink">{onSale ? "Not started on this store" : "Not on sale yet"}</p>
            <p className="mt-1 text-sm text-ink-soft">
              {onSale
                ? "Charged each month on the card your plan is paid with, as a subscription of its own. Stop it at any time; it stays on until the end of the month paid. Payments are not refunded, except where the law requires it."
                : "It opens with Marktmorgen's plans. You can switch it on and write your notes now; the chat shows on your store once the add-on is paid for."}
            </p>
            {canBill && onSale ? (
              <form method="post" action={`/api/billing/assistant${pin}`} className="mt-3">
                <input type="hidden" name="action" value="start" />
                <button type="submit" className="btn btn-primary btn-sm" disabled={refusal !== null}>
                  {`Start the ${ASSISTANT_NAME}`}
                </button>
                {refusalText ? <p className="mt-2 text-xs text-ink-soft">{refusalText}</p> : null}
              </form>
            ) : null}
          </>
        )}
      </div>

      <label className="mt-5 flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
        <input type="checkbox" checked={on} onChange={(event) => setOn(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" />
        <span>
          Show the assistant on my store&apos;s pages
          <span className="block font-normal text-ink-soft">
            It takes the place of the store&apos;s chat while it is on; questions it passes on arrive in the same inbox. It never states a price, a deal,
            a code, a deadline or a result you did not publish: a reply that would is never shown.
          </span>
        </span>
      </label>

      <div className="mt-4">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="assistant-notes" className="field-label">
            What buyers should know (optional)
          </label>
          <span className="text-xs tabular-nums text-ink-mute">{`${notes.length}/${MAX_ASSISTANT_NOTES}`}</span>
        </div>
        <textarea
          id="assistant-notes"
          className="field mt-1"
          rows={4}
          maxLength={MAX_ASSISTANT_NOTES}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="For example: Every file is a PDF. I answer email within two working days. Courses can be watched on a phone."
        />
        <p className="mt-1 text-xs text-ink-soft">Write only what you will stand behind: buyers read the assistant&apos;s answers as true of your store.</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void post({ on, notes: notes.trim() }, "save", on ? "Saved. The assistant shows while the add-on is paid for." : "Saved. The assistant is off.")}
          disabled={busy !== null || !changed}
          aria-busy={busy === "save"}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-7 border-t border-line pt-6">
        <p className="font-semibold text-ink">After a purchase: one next product</p>
        <p className="mt-1 text-sm text-ink-soft">
          On the page after paying, one more of your own products, at its published price, with its own description, and a &ldquo;No thanks&rdquo;.
          Never what the buyer just bought or already owns from you, never something they turned down after paying, and never while one of your
          offers after paying is waiting on their answer. Your own choices come first, in this order: what you said goes well with the product,
          what it offers after paying, what it offers at checkout, the rest of a collection it is in. Only when you set none does an AI choose among
          your products, labeled &ldquo;AI suggestion&rdquo;; each such choice is one reply of the month, and once the month&apos;s replies are used
          your store&apos;s own order decides, at no AI cost.
        </p>
        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
          <input type="checkbox" checked={nextOn} onChange={(event) => setNextOn(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" />
          <span>Suggest one next product after a purchase</span>
        </label>
        <label className={`mt-1 flex min-h-11 items-start gap-3 text-sm font-semibold ${nextOn ? "cursor-pointer text-ink" : "text-ink-mute"}`}>
          <input
            type="checkbox"
            checked={nextOn && nextEmail}
            disabled={!nextOn}
            onChange={(event) => setNextEmail(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand"
          />
          <span>
            Also in the order&apos;s confirmation email
            <span className="block font-normal text-ink-soft">
              The same product, as a few lines in the email the buyer already gets, never an email of its own; only to buyers who checked the box to
              hear from you at checkout.
            </span>
          </span>
        </label>
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void post({ next: { on: nextOn, email: nextOn && nextEmail }, expect: { on: next.on, email: next.email } }, "next", nextOn ? "Saved. It shows after purchases while the add-on is paid for." : "Saved. No next product is suggested.")}
            disabled={busy !== null || !nextChanged}
            aria-busy={busy === "next"}
          >
            {busy === "next" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div id="assistant-reminder" className="mt-7 scroll-mt-32 border-t border-line pt-6">
        <p className="font-semibold text-ink">After a checkout left unpaid: one reminder, only when asked for</p>
        <p className="mt-1 text-sm text-ink-soft">
          Your checkout shows an unchecked box, &ldquo;{assistReminderWords("en").box}&rdquo; (in your store&apos;s language), with a place for the
          buyer&apos;s email once it is checked. Only a buyer who checks it and types an address gets one email from you, about an hour after
          that checkout closes unpaid: what they left, its link and today&apos;s price, the sentence they checked and the day, your postal
          address and a link that stops your reminders at once. Never when they paid, paid for it since, or stopped or left your emails, and
          never twice for one checkout. An AI adds one short, neutral line about those products from your own descriptions, labeled as
          written by AI, with no price, deal, deadline or claim; each line is one reply of the month, and once those are used the same email
          goes without it. The email is one of your store&apos;s own emails for the month, and is not sent when those are used. What the buyer
          typed is deleted {ASSIST_REMIND_KEEP_SECONDS / 86_400} days after the checkout opened.
        </p>
        {!postal ? (
          <p className="notice mt-3" role="status">
            Add the postal address your reminders carry, under{" "}
            <a href="#checkout-reminders" className="underline">
              Checkout reminders
            </a>
            , first: US law asks every email about buying something to include one. Until you do, the box is not shown and nothing is sent.
          </p>
        ) : null}
        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm font-semibold text-ink">
          <input type="checkbox" checked={remindOn} onChange={(event) => setRemindOn(event.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-violet-brand" />
          <span>
            Offer one reminder at checkout
            <span className="block font-normal text-ink-soft">Shown while the add-on is paid for and your postal address is given.</span>
          </span>
        </label>
        <div className="mt-3">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void post({ remind: { on: remindOn } }, "remind", remindOn ? (postal ? "Saved. The box shows at checkout while the add-on is paid for." : "Saved. Add your postal address and the box shows at checkout.") : "Saved. No reminder is offered at checkout.")}
            disabled={busy !== null || remindOn === remind.on}
            aria-busy={busy === "remind"}
          >
            {busy === "remind" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {missed.length > 0 ? (
        <div className="mt-7 border-t border-line pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-semibold text-ink">Questions the assistant could not answer</p>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post({ clear: true }, "clear", "List cleared.")} disabled={busy !== null} aria-busy={busy === "clear"}>
              Clear the list
            </button>
          </div>
          <p className="mt-1 text-sm text-ink-soft">Newest first, with nothing about who asked. Answer them on a product&apos;s page, in your store&apos;s questions or in your notes, and the next buyer gets the answer.</p>
          <ul className="mt-3 space-y-2">
            {missed.map((row, index) => (
              <li key={index} className="rounded-xl bg-paper px-4 py-3 ring-1 ring-line">
                <p className="text-sm text-ink">{row.question}</p>
                {row.at ? <p className="mt-0.5 text-xs text-ink-mute">{DATE.format(new Date(row.at * 1000))}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
