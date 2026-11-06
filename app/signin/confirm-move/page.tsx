import { MorningLogo } from "@/components/morning-header";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Confirm the move — Marktmorgen",
  description: "One tap to move your Marktmorgen account to this address.",
  robots: { index: false, follow: false },
};

/** The last step of moving the sign-in address. Landing here spends nothing. */
export default async function ConfirmMovePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)) redirect("/signin?status=expired");

  return (
    <div className="relative min-h-screen overflow-hidden">

      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <MorningLogo />

        <h1 className="t-h1 mt-6">
          Move your account here
        </h1>
        <p className="mt-4 text-lg text-ink-soft">
          Your store, your address and your products come with you. From then
          on, this is the inbox that logs you in.
        </p>

        <div className="card mt-8 p-6 sm:p-8">
          <form method="post" action="/api/auth/move">
            <input type="hidden" name="token" value={token} />
            <button
              type="submit"
              className="btn btn-primary btn-lg btn-block"
            >
              Move my account here
            </button>
          </form>
          <p className="mt-4 text-sm text-ink-soft">
            Every session your old address had open is closed the moment this
            finishes, on every device. Files already attached to your products
            keep working.
          </p>
        </div>
      </main>
    </div>
  );
}
