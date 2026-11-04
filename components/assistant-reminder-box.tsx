import { EmailField } from "@/components/email-field";
import { assistReminderWords } from "@/lib/buyer-words/assistant-reminder";
import { ASSIST_REMIND_VERSION } from "@/lib/assistant-reminder-rules";

/**
 * The Store assistant's box at checkout (lib/assistant-reminder-rules.ts):
 * unchecked, saying exactly what the buyer gets, with the address it is for
 * asked only once it is checked (app/globals.css, .ask-remind). The form
 * sends the sentence's version, which is kept with the yes. No hooks, so
 * the product's buy box and the cart both draw it.
 */
export function AssistReminderBox({ id, lang, store, className = "" }: { id: string; lang: string; store: string; className?: string }) {
  const r = assistReminderWords(lang);
  return (
    <div className={`text-sm ${className}`}>
      <label htmlFor={id} className="st-muted flex cursor-pointer items-start gap-3">
        <input id={id} type="checkbox" name="remind" value="yes" data-remind="" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {r.box}
          <span className="mt-0.5 block text-xs">{r.boxNote(store)}</span>
        </span>
      </label>
      <input type="hidden" name="remind_v" value={ASSIST_REMIND_VERSION} />
      <div className="ask-remind mt-2">
        <label htmlFor={`${id}-email`} className="st-label">
          {r.emailLabel}
        </label>
        <EmailField id={`${id}-email`} name="remind_email" className="st-field" autoComplete="email" language={lang} />
      </div>
    </div>
  );
}
