import { EmailField } from "@/components/email-field";
import type { Store } from "@/lib/store";
import { contactWords } from "@/lib/buyer-words/contact";
import { speech } from "@/lib/buyer-words";
import { MAX_MESSAGE, MAX_NAME, MIN_MESSAGE } from "@/lib/store-contact-rules";

/** The contact form on the store page (lib/store-contact.ts): a plain form, so it works without JavaScript. */
export function StoreContactBox({ store }: { store: Store }) {
  const w = contactWords(store.language);
  const said = speech(store);
  return (
    <section id="contact" aria-labelledby="contact-heading" className="st-card mt-8 scroll-mt-8 p-6 sm:p-7">
      <h2 id="contact-heading" className="font-display text-xl font-semibold leading-snug">
        {store.contact.heading || w.heading}
      </h2>
      <p className="st-muted mt-2">{store.contact.line || w.line(store.name)}</p>
      <form action="/api/store/contact" method="post" className="mt-5 space-y-3">
        <input type="hidden" name="handle" value={store.handle} />
        <div aria-hidden="true" className="hidden">
          <label>
            {said.w.leaveEmpty}
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="contact-name" className="st-label">{w.name}</label>
            <input id="contact-name" name="name" maxLength={MAX_NAME} autoComplete="name" className="st-field mt-1 w-full" />
          </div>
          <div>
            <label htmlFor="contact-email" className="st-label">{w.email}</label>
            <EmailField id="contact-email" name="email" className="st-field mt-1 w-full" required autoComplete="email" language={store.language} />
          </div>
        </div>
        <div>
          <label htmlFor="contact-message" className="st-label">{w.message}</label>
          <textarea id="contact-message" name="message" required minLength={MIN_MESSAGE} maxLength={MAX_MESSAGE} rows={4} className="st-field mt-1 w-full" />
        </div>
        <button type="submit" className="btn st-btn">{w.button}</button>
      </form>
    </section>
  );
}
