import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MorningLogo } from "@/components/morning-header";
import { peekInvite } from "@/lib/team";
import { ROLE_NAMES, ROLE_SUMMARIES } from "@/lib/team-roles";

export const metadata: Metadata = {
  title: "Join a store's team — Marktmorgen",
  description: "One tap to join a store's team on Marktmorgen.",
  robots: { index: false, follow: false },
};

/**
 * Where an invitation to a store's team lands.
 *
 * Landing here spends nothing, for the reason the login link works that way:
 * mail filters open every link in a message. The page says which store and
 * which role the invitation is for, and only the tap — a POST — takes it
 * (app/api/auth/join).
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  if (!/^[0-9a-f]{64}$/.test(token)) redirect("/signin?status=invite-expired");
  const invite = await peekInvite(token).catch(() => null);
  if (!invite) redirect("/signin?status=invite-expired");
  const role = ROLE_NAMES[invite.role];

  return (
    <div className="relative min-h-screen overflow-hidden">
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <MorningLogo />

        <h1 className="t-h1 mt-6 break-words">{`Join ${invite.store.name}`}</h1>
        <p className="mt-4 text-lg text-ink-soft">
          {`You were invited to help run marktmorgen.com/@${invite.store.handle} as ${role}.`}
        </p>

        <div className="card mt-8 p-6 sm:p-8">
          <dl className="space-y-3 text-[0.9375rem]">
            <div>
              <dt className="font-semibold text-ink">{role}</dt>
              <dd className="mt-0.5 text-ink-soft">{ROLE_SUMMARIES[invite.role]}</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">You log in as</dt>
              <dd className="mt-0.5 break-all text-ink-soft">{invite.email}</dd>
            </div>
          </dl>
          <form method="post" action="/api/auth/join" className="mt-6">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="btn btn-primary btn-lg btn-block">
              Join the team
            </button>
          </form>
          <p className="mt-4 text-sm text-ink-soft">
            Joining puts this address on the team and opens the store in its studio. If the address has no account here
            yet, joining also logs you in; if it already has one, you log in the usual way afterward. There is no
            password: log in with a link sent to this address, or a passkey if you add one. The invitation works once,
            and only for this address.
          </p>
        </div>
      </main>
    </div>
  );
}
