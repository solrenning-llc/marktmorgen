import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { TeamManager } from "@/components/team-manager";
import { studioPath, studioView } from "@/lib/studio-route";
import { MAX_TEAM, hasSecondStep, readLog, readTeam } from "@/lib/team";
import { TeamTwoStepSwitch } from "@/components/team-two-step-switch";
import { ROLE_NAMES } from "@/lib/team-roles";

export const metadata: Metadata = {
  title: "Team — Marktmorgen",
  robots: { index: false, follow: false },
};

/** Lines of the log shown at once; the rest open underneath. */
const FIRST_LINES = 50;

function when(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}, ${date.toISOString().slice(11, 16)} UTC`;
}

/**
 * The people who help run a store, and what they did: the owner's page
 * alone (lib/team-roles.ts, "team").
 */
export default async function StudioTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const found = await studioView(await cookies(), typeof params.store === "string" ? params.store : undefined, "team");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const [team, log] = await Promise.all([readTeam(store.sid), readLog(store.sid)]);
  // Who has a second step now (612 [WP11]): read only for the owner, who alone sees the switch.
  const owner = view.role === "owner";
  const [ownerReady, ready] = owner
    ? await Promise.all([hasSecondStep(view.email).catch(() => false), Promise.all(team.members.map((m) => hasSecondStep(m.email).catch(() => false)))])
    : [false, [] as boolean[]];

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Team</p>
          <h1 className="t-h2 mt-3">People who help run {store.name}</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`Up to ${MAX_TEAM} people, each with a role that decides what they can do here. They log in with their own email, never yours, and every change they make is written in the activity log below.`}
          </p>

          <div className="mt-8">
            <TeamManager
              owner={store.email}
              members={team.members}
              invites={team.invites.map(({ id, email, role, expiresAt }) => ({ id, email, role, expiresAt }))}
              max={MAX_TEAM}
            />
          </div>

          {owner ? (
            <section className="card mt-8 p-6 sm:p-8" aria-labelledby="two-step-title">
              <h2 id="two-step-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                Two-step sign-in for the team
              </h2>
              <div className="mt-3">
                <TeamTwoStepSwitch on={team.requireTwoStep === true} ownerReady={ownerReady} members={team.members.map((m, i) => ({ email: m.email, ready: ready[i] === true }))} />
              </div>
            </section>
          ) : null}

          <section className="card mt-8 p-6 sm:p-8" aria-labelledby="log-title">
            <h2 id="log-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Activity
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              Every change a team member sends from the studio, every download of buyers&apos; data they make, and every
              change to the team, newest first. The last 500 are kept.
            </p>
            {log.length === 0 ? (
              <p className="mt-4 rounded-[12px] bg-paper px-4 py-3 text-sm text-ink-soft ring-1 ring-line">Nothing yet.</p>
            ) : (
              <>
                <LogList lines={log.slice(0, FIRST_LINES)} />
                {log.length > FIRST_LINES ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                      {`Show ${log.length - FIRST_LINES} older`}
                    </summary>
                    <LogList lines={log.slice(FIRST_LINES)} />
                  </details>
                ) : null}
              </>
            )}
          </section>
        </main>
      </StudioStorePin>
    </div>
  );
}

function LogList({ lines }: { lines: Awaited<ReturnType<typeof readLog>> }) {
  return (
    <ol className="mt-4 divide-y divide-line">
      {lines.map((line, i) => (
        <li key={`${line.at}-${i}`} className="grid gap-x-4 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
          <span className="whitespace-nowrap text-ink-mute tabular-nums">{when(line.at)}</span>
          <span className="min-w-0">
            <span className="break-all font-semibold text-ink">{line.who}</span>
            <span className="text-ink-mute">{` · ${ROLE_NAMES[line.role]}`}</span>
            <span className="block break-words text-ink-soft">{line.what}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
