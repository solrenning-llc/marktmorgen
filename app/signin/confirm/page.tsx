import { PendingSubmit } from "@/components/pending-submit";
import { MorningLogo } from "@/components/morning-header";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { prefillHandle } from "@/lib/handle-prefill";

export const metadata: Metadata = {
  title: "Confirm login — Marktmorgen",
  description: "One tap to finish logging in to Marktmorgen.",
  robots: { index: false, follow: false },
};

/**
 * The last step of the emailed link.
 *
 * The link in the email lands here, and landing here spends nothing. Mail
 * filters open every link in a message to inspect it, and a sign-in link that
 * a filter could spend would be gone before the creator ever tapped it. So the
 * page asks for one tap, and only that tap — a POST, which no filter makes —
 * opens the session.
 */
export default async function ConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)) redirect("/signin?status=expired");
  // The store address typed on the home page, when the link carries a valid
  // one; carried on to the address step, never reserved (lib/handle-prefill.ts).
  const handle = prefillHandle(params.handle);

  return (
    <div className="relative min-h-screen overflow-hidden">

      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <MorningLogo />

        <h1 className="t-h1 mt-6">
          One tap and you are in
        </h1>
        <p className="mt-4 text-lg text-ink-soft">
          Your link is good. Tap the button and the session opens.
        </p>

        <div className="card mt-8 p-6 sm:p-8">
          <form method="post" action="/api/auth/callback">
            <input type="hidden" name="token" value={token} />
            {handle ? <input type="hidden" name="handle" value={handle} /> : null}
            <PendingSubmit label="Log me in" pending="Logging you in…" className="btn btn-primary btn-lg btn-block" />
          </form>
          <p className="mt-4 text-sm text-ink-soft">
            We ask for this tap because mail filters open the links in a message
            to check them. Your link works once, and we would rather a filter
            never spent it for you.
          </p>
        </div>
      </main>
    </div>
  );
}
