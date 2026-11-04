import type { Metadata } from "next";
import { PipelineAccessEditor } from "@/components/pipeline-access-editor";
import { readPipelinesExact } from "@/lib/crm";
import { type AccessChange, accessLogNamer, accessLogWords } from "@/lib/pipeline-access-rules";
import { readAllPipelineAccess } from "@/lib/pipeline-access";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { TeamManager } from "@/components/team-manager";
import { studioPath, studioView } from "@/lib/studio-route";
import { MAX_TEAM, readLog, readTeam } from "@/lib/team";
import { ROLE_NAMES, can } from "@/lib/team-roles";

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
  const [team, log, pipelines, access] = await Promise.all([
    readTeam(store.sid),
    readLog(store.sid),
    // A pipelines record that cannot be read shows the notice, never the default pipeline in its place.
    readPipelinesExact(store.statsId).catch(() => null),
    readAllPipelineAccess(store.statsId).catch(() => null),
  ]);
  // Only a role that opens Deals and is not Admin can be restricted (639 [GL7](7)): the owner and Admins always see and change every pipeline, and a role without Deals (Editor) sees none.
  // A pipeline-access line in the log names each pipeline as it is named now (accessLogNamer).
  const nameOf = accessLogNamer(pipelines);
  // Who is never restricted is said only for the roles this team has: the owner always, Admins and Editors when there are some.
  const hasAdmin = team.members.some((m) => m.role === "admin");
  const hasEditor = team.members.some((m) => m.role === "editor");
  const restrictable = team.members.flatMap((m) => ((m.role === "editor" || m.role === "support") && can(m.role, "orders") ? [{ email: m.email, role: m.role }] : []));

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

          <section className="card mt-8 p-6 sm:p-8" aria-labelledby="pipeline-access-title">
            <h2 id="pipeline-access-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
              Who sees each sales pipeline
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-ink-soft">
              Under Deals, each Support person can change every pipeline unless you choose otherwise here. Can only see shows its deals without changing them; No access hides it.
              {` ${hasAdmin ? "Admins and you always see" : "You always see"} and change every pipeline${hasEditor ? "; Editors do not open Deals at all" : ""}.`}
            </p>
            {pipelines && access ? (
              <PipelineAccessEditor members={restrictable} pipelines={pipelines.map(({ id, name }) => ({ id, name }))} initial={Object.fromEntries(restrictable.map((m) => [m.email, access[m.email] === undefined ? {} : access[m.email]]))} />
            ) : (
              <p className="notice notice-warn mt-4">Your pipelines or your team&apos;s access could not be read just now. Nothing was changed. Try again in a moment.</p>
            )}
          </section>

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
                <LogList lines={log.slice(0, FIRST_LINES)} nameOf={nameOf} />
                {log.length > FIRST_LINES ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm font-bold text-ink underline underline-offset-2">
                      {`Show ${log.length - FIRST_LINES} older`}
                    </summary>
                    <LogList lines={log.slice(FIRST_LINES)} nameOf={nameOf} />
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

function LogList({ lines, nameOf }: { lines: Awaited<ReturnType<typeof readLog>>; nameOf: (change: AccessChange) => string }) {
  return (
    <ol className="mt-4 divide-y divide-line">
      {lines.map((line, i) => (
        <li key={`${line.at}-${i}`} className="grid gap-x-4 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
          <span className="whitespace-nowrap text-ink-mute tabular-nums">{when(line.at)}</span>
          <span className="min-w-0">
            <span className="break-all font-semibold text-ink">{line.who}</span>
            <span className="text-ink-mute">{` · ${ROLE_NAMES[line.role]}`}</span>
            <span className="block break-words text-ink-soft">{line.access ? accessLogWords(line.access, nameOf) : line.what}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
