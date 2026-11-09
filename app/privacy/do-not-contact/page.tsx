import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { CONTACT_MAX_LENGTH, NAME_MAX_LENGTH } from "@/lib/research-do-not-contact";

export const metadata: Metadata = {
  title: "Don't contact me for research — Marktmorgen",
  description: "Ask Marktmorgen never to contact you again about its research with creators. No account needed.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const STATUS: Record<string, { tone: "ok" | "error"; text: string }> = {
  done: { tone: "ok", text: "Done. That contact detail is on our do-not-contact list, and we will not contact it again for our research." },
  contact: { tone: "error", text: "That is not an email address or a link we can use. Type an email address, like you@example.com, or a link to your site or profile, like instagram.com/yourname." },
  limited: { tone: "error", text: "Too many tries from your connection for now. Nothing was added. Wait an hour and try again." },
  full: { tone: "error", text: "Our do-not-contact list is full right now, so nothing was added." },
  error: { tone: "error", text: "That could not be saved just now, so nothing was added. Try again in a moment." },
};

/**
 * Asking Marktmorgen never to contact you for its research
 * (lib/research-do-not-contact.ts): one form, no account. It keeps only the
 * contact detail typed and, if given, the name, as the privacy policy says.
 */
export default async function DoNotContactPage({ searchParams }: Params) {
  const query = await searchParams;
  const statusKey = typeof query.status === "string" ? query.status : "";
  const status = STATUS[statusKey];
  const wrongContact = statusKey === "contact";

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <SiteNav />
      <main id="content" className="flex-1">
        <section className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <nav aria-label="Breadcrumb" className="text-sm">
              <ol className="flex flex-wrap gap-2 text-ink-soft">
                <li>
                  <Link href="/privacy" className="link">Privacy policy</Link>
                  <span aria-hidden="true"> /</span>
                </li>
                <li aria-current="page">Don&apos;t contact me</li>
              </ol>
            </nav>
            <h1 className="t-h1 balance mt-4 max-w-3xl">Don&apos;t contact me for research</h1>
            <p className="mt-4 max-w-2xl text-lg text-ink-soft">
              If we wrote to you to ask about your work as a creator, you can tell us to stop here. No account is needed. We will never contact you again for our research.
            </p>
          </div>
        </section>
        <section className="container-page py-12 sm:py-16">
          <div className="max-w-xl">
            {status ? (
              <p className={`notice ${status.tone === "ok" ? "notice-success" : "notice-error"} mb-6`} role={status.tone === "ok" ? "status" : "alert"} id="dnc-status">
                {status.text}
                {statusKey === "full" || statusKey === "error" ? (
                  <>
                    {" "}You can also email{" "}
                    <a href="mailto:support@marktmorgen.com" className="underline underline-offset-4">support@marktmorgen.com</a>{" "}
                    and ask us to stop. We will add you ourselves.
                  </>
                ) : null}
              </p>
            ) : null}
            <form action="/api/privacy/do-not-contact" method="post" className="card p-6 sm:p-8">
              <div aria-hidden="true" className="hidden">
                <label>
                  Leave this empty
                  <input type="text" name="website" tabIndex={-1} autoComplete="off" />
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
                aria-describedby={wrongContact ? "dnc-contact-hint dnc-status" : "dnc-contact-hint"}
                aria-invalid={wrongContact ? true : undefined}
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
                aria-describedby="dnc-name-hint"
                className="field mt-2"
              />
              <button type="submit" className="btn btn-primary mt-5">
                Don&apos;t contact me
              </button>
              <p className="mt-4 text-sm text-ink-soft">
                We keep only what you type here, on our do-not-contact list, so that we can respect your request. We check that list before any research message.
              </p>
            </form>
            <p className="mt-6 text-sm text-ink-soft">
              You can also email{" "}
              <a href="mailto:support@marktmorgen.com" className="underline underline-offset-4">support@marktmorgen.com</a>{" "}
              and ask us to stop. <Link href="/privacy#research-outreach" className="underline underline-offset-4">How we use research contacts</Link>.
            </p>
          </div>
        </section>
      </main>
      <SiteFooter variant="slim" />
    </div>
  );
}
