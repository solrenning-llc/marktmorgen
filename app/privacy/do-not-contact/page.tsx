import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { SiteFooter } from "@/components/site-footer";
import { cookies } from "next/headers";
import { DoNotContactForm } from "@/components/do-not-contact-form";
import { researchOperator } from "@/lib/research-operator";

export const metadata: Metadata = {
  title: "Don't contact me for research — Marktmorgen",
  description: "Ask Marktmorgen never to contact you again about its research with creators. No account needed.",
  robots: { index: false, follow: true },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Asking Marktmorgen never to contact you for its research
 * (lib/research-do-not-contact.ts): one form, no account
 * (components/do-not-contact-form.tsx). It keeps only the contact detail typed
 * and, if given, the name, as the privacy policy says.
 */
export default async function DoNotContactPage({ searchParams }: Params) {
  const query = await searchParams;
  const statusKey = typeof query.status === "string" ? query.status : "";
  // Read only when an operator is configured and a session cookie was sent, so everyone else costs nothing here.
  const operator = await researchOperator(await cookies());

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
            <DoNotContactForm status={statusKey} operator={operator} />
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
