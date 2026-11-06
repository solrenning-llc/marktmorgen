import { PendingSubmit } from "@/components/pending-submit";
import { MorningLogo } from "@/components/morning-header";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Back into your account — Marktmorgen",
  description: "Turn two-step login off with your recovery address, and log in.",
  robots: { index: false, follow: false },
};

/**
 * Where the link sent to a recovery address lands (lib/two-step.ts
 * sendRescue). Landing spends nothing, because mail filters open links to
 * check them; the tap below, a POST, is what turns two-step login off and
 * opens the session.
 */
export default async function RescuePage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)) redirect("/signin?status=expired");

  return (
    <div className="relative min-h-screen overflow-hidden">
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <MorningLogo />
        <h1 className="t-h1 mt-6">Back into your account</h1>
        <p className="mt-4 text-lg text-ink-soft">One tap turns two-step login off and logs you in. Turn it on again in your studio once you have your phone.</p>
        <div className="card mt-8 p-6 sm:p-8">
          <form method="post" action="/api/auth/rescue">
            <input type="hidden" name="token" value={token} />
            <PendingSubmit label="Turn it off and log me in" pending="Logging you in…" className="btn btn-primary btn-lg btn-block" />
          </form>
          <p className="mt-4 text-sm text-ink-soft">The link works once, for 15 minutes. Your sign-in address is told that it was used.</p>
        </div>
      </main>
    </div>
  );
}
