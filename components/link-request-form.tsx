import { EmailField } from "@/components/email-field";

/**
 * "Send me a link" on a store's page: a buyer types the address they used,
 * and a link that lets this device in is emailed to it. One form for every
 * door that proves an address this way (the community, an email kept for
 * members), so they look and behave the same.
 */
export function LinkRequestForm({
  action,
  hidden,
  id,
  label,
  explain,
  button,
  placeholder,
  language: lang,
}: {
  /** The route that sends the link. */
  action: string;
  /** What the route needs besides the address. */
  hidden: Record<string, string>;
  /** The address field's id, unique on the page. */
  id: string;
  label: string;
  explain: string;
  button: string;
  placeholder: string;
  language: string;
}) {
  return (
    <form action={action} method="post" className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label htmlFor={id} className="st-label">{label}</label>
      <p className="st-muted mt-1 text-sm">{explain}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
        <EmailField id={id} name="email" className="st-field w-full" wrapClassName="min-w-0 flex-1" required autoComplete="email" placeholder={placeholder} language={lang} />
        <button type="submit" className="btn st-btn">{button}</button>
      </div>
    </form>
  );
}
