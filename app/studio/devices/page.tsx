import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";

export const metadata: Metadata = {
  title: "Log out of other devices — Marktmorgen",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** What the route answered (app/api/auth/signout-others): done, or not known, never "done" when it is not known. */
const RESULT: Record<string, { tone: "notice-success" | "notice-warn"; words: string }> = {
  "out-others": {
    tone: "notice-success",
    words: "Done. Every other device that was logged in is now logged out. This browser is still logged in. A login finished at that very moment may stay open, so if you still see one, press the button again.",
  },
  "out-others-reauth": {
    tone: "notice-warn",
    words: "For your safety, log in again to log out your other devices. Nothing was logged out. This needs a login from the last 15 minutes.",
  },
  "out-others-unknown": {
    tone: "notice-warn",
    words: "We could not log out your other devices just now, so none of them is known to be logged out. Try again in a moment. If it keeps failing, use “Log out of all devices” in your studio.",
  },
};

/**
 * Asks before it logs out every other device of this account (757 [STN4], unit 1; AX274 3.3.6): opening this
 * page closes nothing, and it has no time limit. The sessions belong to the person, not to a store, so anyone on
 * a store's team may use it for their own login.
 */
export default async function StudioDevicesPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, null);
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store) : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const result = typeof query.status === "string" ? RESULT[query.status] : undefined;
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Your login</p>
          <h1 className="t-h2 mt-3">Log out of other devices</h1>
          <div role="status" aria-live="polite">
            {result ? <p className={`notice ${result.tone} mt-6`}>{result.words}</p> : null}
            {query.status === "out-others-reauth" ? (
              <Link href="/signin?to=login" className="btn btn-secondary mt-3">
                Log in again
              </Link>
            ) : null}
          </div>
          <p className="mt-6 max-w-2xl text-ink-soft">
            This logs you out on every other computer, phone or browser where you are logged in with this email address. You stay logged in here.
          </p>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Use it if you left your account open on a device that is not yours, or one that was lost. To get back in there, someone needs a new login link sent to your email.
          </p>
          <p className="mt-3 max-w-2xl text-ink-soft">
            API keys are not affected. If a script or app on that device holds one of your store&apos;s API keys, it keeps working until you revoke the key in the API section of your studio.
          </p>
          <p className="mt-8 font-semibold text-ink">Log out of your other devices now?</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <form action="/api/auth/signout-others" method="post">
              <button type="submit" className="btn btn-primary">
                Yes, log out the other devices
              </button>
            </form>
            <Link href={studioPath(store)} className="btn btn-secondary">
              Keep them logged in
            </Link>
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
