import { PendingSubmit } from "@/components/pending-submit";
import Link from "next/link";
import { Logo } from "@/components/logo";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Back into your account — Marktmorgen",
  description: "One tap to log in through your recovery address.",
  robots: { index: false, follow: false },
};

/**
 * Where the link sent to a recovery address lands (lib/recovery-address.ts).
 * Landing spends nothing, because mail filters open links to check them; the
 * tap below, a POST, is what logs in.
 */
export default async function LostConfirmPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)) redirect("/signin?status=expired");
  return (
    <div className="relative min-h-screen overflow-hidden bg-paper text-ink">
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <Link href="/" className="inline-flex min-h-11 w-fit items-center rounded-[10px]" aria-label="Marktmorgen, home">
          <Logo />
        </Link>
        <h1 className="t-h1 mt-6">One tap and you are in</h1>
        <p className="mt-4 text-lg text-ink-soft">Your recovery address worked. Tap the button to log in.</p>
        <div className="card mt-8 p-6 sm:p-8">
          <form method="post" action="/api/auth/lost/confirm">
            <input type="hidden" name="token" value={token} />
            <PendingSubmit label="Log me in" pending="Logging you in…" className="btn btn-primary btn-lg btn-block" />
          </form>
          <p className="mt-4 text-sm text-ink-soft">The link works once, for 15 minutes. Your sign-in address is told that it was used.</p>
        </div>
      </main>
    </div>
  );
}
