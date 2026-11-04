import { EmailField } from "@/components/email-field";
import type { Store } from "@/lib/store";
import { joinWords } from "@/lib/buyer-words/join";
import { speech } from "@/lib/buyer-words";
import { canWrite } from "@/lib/mail";
import { ClicksBox } from "@/components/store-product";

/**
 * The sign-up box on the store page (lib/store-join.ts). A plain form, so it
 * works without JavaScript; the creator's own heading and line when they
 * wrote one, the store language's words when not.
 */
export function StoreJoinBox({ store }: { store: Store }) {
  const w = joinWords(store.language);
  const said = speech(store);
  return (
    <section aria-labelledby="join-heading" className="st-card st-join mt-8 p-6 sm:p-7">
      <h2 id="join-heading" className="font-display text-xl font-semibold leading-snug">
        {store.join.heading || w.heading}
      </h2>
      <p className="st-muted mt-2">{store.join.line || w.line(store.name)}</p>
      <form action="/api/store/join" method="post" className="mt-5">
        <input type="hidden" name="handle" value={store.handle} />
        {/* Left empty by a person; filled in by something that fills in every field. */}
        <div aria-hidden="true" className="hidden">
          <label>
            {said.w.leaveEmpty}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <label htmlFor="join-email" className="sr-only">
          {w.label}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <EmailField id="join-email" name="email" className="st-field w-full" wrapClassName="min-w-0 flex-1" required autoComplete="email" placeholder={said.w.emailPlaceholder} language={store.language} />
          <button type="submit" className="btn st-btn shrink-0">
            {w.button}
          </button>
        </div>
        {/* Joining is the yes to the list; this one is its own, and starts empty. */}
        {canWrite(store) ? <ClicksBox id="join-clicks" label={said.w.alsoClicks(store.mail?.fromName || store.name)} className="mt-3" always /> : null}
      </form>
    </section>
  );
}
