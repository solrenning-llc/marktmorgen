import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ensureDemoStore } from "@/lib/demo-seed";
import { HOUSE_HANDLE } from "@/lib/house-store";

export const metadata: Metadata = {
  title: "Live demo store — Marktmorgen",
  description: "The demo store: a real store on Marktmorgen, with a checkout in Stripe's test mode and a real file to download.",
  robots: { index: false, follow: true },
};

/**
 * No longer than the demo store's lock (lib/demo-seed.ts, 120 s): a visit that has to build the store stops its
 * work inside the lock, and is never left running beside the next visit's build.
 */
export const maxDuration = 120;

/**
 * The address everybody has for the demo, and has had from the first day:
 * marktmorgen.com/demo. It is not a page of its own any more.
 *
 * The demo is a store like any creator's (lib/house-store.ts) and lives where
 * stores live, at /@harborkitchen. This makes sure it is there and is what
 * the code says it should be (lib/demo-seed.ts) — one read on any ordinary
 * visit — and sends the visitor to it. Every link that says /demo keeps
 * working, and none of them leads to anything but the real thing.
 *
 * The few sentences below are only ever read if the store could not be made:
 * a visitor is told so, instead of being sent to an address with nothing on it.
 */
export default async function DemoPage() {
  // Asked on each visit, never when the site is built.
  await connection();
  const seed = await ensureDemoStore().catch((error: unknown) => {
    console.error("the demo store could not be checked", error);
    return { ok: false, pending: ["run"], ran: false };
  });
  if (seed.ok) redirect(`/@${HOUSE_HANDLE}`);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-4 text-center text-ink">
      <main id="content" className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-[-0.02em]">The demo store is being set up</h1>
        <p className="mt-3 text-ink-soft">
          It could not be opened just now. Nothing is wrong on your side. Try again in a few minutes.
        </p>
        <p className="mt-6">
          <Link href="/" className="btn btn-primary">
            Back to Marktmorgen
          </Link>
        </p>
      </main>
    </div>
  );
}
