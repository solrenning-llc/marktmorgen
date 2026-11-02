import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, emailForSession, isFreshSession } from "@/lib/auth";
import { PasskeyManager } from "@/components/passkey-manager";
import { TwoStepManager } from "@/components/two-step-manager";
import { RecoveryAddressManager } from "@/components/recovery-address-manager";
import { hideAddress, recoveryAddress } from "@/lib/recovery-address";
import { listPasskeys } from "@/lib/passkeys";
import { lockedUntil, twoStepStatus } from "@/lib/two-step";
import { STORE_ID_PATTERN, storeForId } from "@/lib/store";
import { roleIn, teamTwoStepBlocks } from "@/lib/team";

export const metadata: Metadata = {
  title: "Set up two-step sign-in — Marktmorgen",
  robots: { index: false, follow: false },
};

/**
 * Where a member of a team is sent when its owner requires two-step sign-in
 * and they have no second step yet (612 [WP11], unit 2). It says whose rule it
 * is and offers the two ways to meet it on this page: a passkey, or an
 * authenticator app (which asks for a recovery address first). Nothing about
 * the store is shown. Once either is set up, "Open the studio" opens it.
 * Reached without a reason to be here, it sends the person to the studio.
 */
export default async function SecondStepPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  const email = await emailForSession(session);
  if (!email) redirect("/signin");
  const sid = typeof params.store === "string" && STORE_ID_PATTERN.test(params.store) ? params.store : "";
  const store = sid ? await storeForId(sid) : null;
  const role = store ? await roleIn(store, email) : null;
  const blocked = store && role ? await teamTwoStepBlocks(store, email, role) : false;
  if (!store || !role) redirect("/studio");
  const studio = `/studio?store=${store.sid}`;

  const [passkeys, fresh, locked, twoStep, recoveryShown] = await Promise.all([
    listPasskeys(email).catch(() => []),
    isFreshSession(session).catch(() => false),
    lockedUntil(session).catch(() => 0),
    twoStepStatus(email).catch(() => ({ on: false, since: 0, codesLeft: 0, reset: 0, backup: "" })),
    recoveryAddress(email).then((a) => (a ? hideAddress(a) : "")).catch(() => ""),
  ]);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="container-page flex min-h-16 items-center justify-between gap-4 py-3">
        <Link href="/" className="font-display text-lg font-semibold">
          Marktmorgen
        </Link>
        <Link href="/studio" className="inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4">
          Your studio
        </Link>
      </header>
      <main id="content" className="container-page pb-20 pt-6 sm:pt-10">
        <p className="eyebrow">Your account</p>
        <h1 className="t-h2 mt-3">Set up two-step sign-in</h1>
        {blocked ? (
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`The owner of ${store.name} asks everyone on its team to sign in with a second step. Add a passkey, or turn on an authenticator app, below. Then open the studio again: nothing else changes, and your invitation and your role stay as they were.`}
          </p>
        ) : (
          <div className="mt-4 max-w-2xl rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line" role="status">
            <p className="font-semibold">{`You are all set for ${store.name}.`}</p>
            <Link href={studio} className="btn btn-primary mt-3 inline-flex min-h-11 items-center">
              Open the studio
            </Link>
          </div>
        )}

        <section className="card mt-8 max-w-2xl p-6 sm:p-8" aria-labelledby="passkey-title">
          <h2 id="passkey-title" className="text-lg font-semibold tracking-[-0.02em]">
            The quickest way: a passkey
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            Your phone or computer checks it is you, with your fingerprint, your face or its PIN. No code to type.
          </p>
          <div className="mt-4">
            <PasskeyManager initial={passkeys.map(({ id, name, createdAt, lastUsedAt, synced }) => ({ id, name, createdAt, lastUsedAt, synced }))} fresh={fresh} />
          </div>
        </section>

        <section className="card mt-6 max-w-2xl p-6 sm:p-8" aria-labelledby="app-title" id="two-step">
          <h2 id="app-title" className="text-lg font-semibold tracking-[-0.02em]">
            Or: an authenticator app
          </h2>
          <p className="mt-2 text-sm text-ink-soft">
            A six-digit code from an app on your phone after the emailed link. It asks for a second email address first, so you can always get back in.
          </p>
          <div className="mt-4 space-y-6">
            <RecoveryAddressManager shown={recoveryShown} />
            <TwoStepManager on={twoStep.on} codesLeft={twoStep.codesLeft} reset={locked > 0 ? 0 : twoStep.reset} backup={twoStep.backup || recoveryShown} fresh={fresh} locked={locked > 0} />
          </div>
        </section>

        {blocked ? (
          <p className="mt-8">
            <Link href={studio} className="inline-flex min-h-11 items-center text-sm font-bold underline underline-offset-4">
              Open the studio once it is set up
            </Link>
          </p>
        ) : null}
      </main>
    </div>
  );
}
