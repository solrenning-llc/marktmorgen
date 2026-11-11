import { serviceAllowanceWords } from "@/lib/store-allowance";
import type { Metadata } from "next";
import { INTEGRATION_PAUSED_WORDS } from "@/lib/integration-pause";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureStatsId } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { HostCalendar } from "@/components/host-calendar";
import { ToastOnLoad } from "@/components/toast";
import { hostCalendarView } from "@/lib/host-calendar";
import { readTeams } from "@/lib/team-booking";
import { parseTeamSetup } from "@/lib/team-scheduling-rules";
import { readKind } from "@/lib/catalog";

export const metadata: Metadata = {
  title: "Your calendar — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** What the page says after a trip to Google, by the word the callback sent back. */
function outcome(word: string): { tone: "ok" | "warn" | "error"; text: string } | null {
  switch (word) {
    case "connected":
      return { tone: "ok", text: "Google Calendar connected." };
    case "declined":
      return { tone: "warn", text: "Google Calendar was not connected: the permission was not given. Nothing was changed." };
    case "scope":
      return { tone: "warn", text: "Google Calendar was not connected: the box that lets us add events to your calendar was left unchecked. Connect again and check it." };
    case "refused":
    case "account":
      return { tone: "error", text: "Google did not complete the connection. Nothing was changed; try again in a moment." };
    case "seal":
      return { tone: "error", text: "Access cannot be stored safely on this deployment yet, so nothing was connected." };
    case "expired":
      return { tone: "warn", text: "That connection attempt had expired or was started in another session. Start it again from this page." };
    case "limited":
      return { tone: "warn", text: "That is too many attempts in a few minutes. Wait a moment and try again." };
    // The paid period's resources could not be reserved (lib/contract-resource-window.ts): not a matter of tries.
    case "funding":
      return { tone: "warn", text: "Connections can't be made just now. Nothing was changed; try again later." };
    case "paused_unpaid":
    case "paused_disputed":
      return { tone: "warn", text: INTEGRATION_PAUSED_WORDS[word] };
    case "error":
      return { tone: "error", text: "Something went wrong on our side. Nothing was changed; try again in a moment." };
    default:
      return null;
  }
}

/**
 * A team host's own calendar for the store's team calls (lib/host-calendar.ts):
 * for whoever is signed in, as its owner or on its team, about themselves only.
 */
export default async function StudioCalendarPage({ searchParams }: Params) {
  const jar = await cookies();
  const query = await searchParams;
  const found = await studioView(jar, typeof query.store === "string" ? query.store : undefined, "member");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const loaded = access.store;
  const store = loaded.statsId ? loaded : ((await ensureStatsId(access.ref)) ?? loaded);
  const email = access.email.toLowerCase();

  // The team calls this person hosts here, and the time zone their week is written in.
  // Not read is not "none" (VR 2, rule 24): the section then says it could not be read, never "None yet".
  const calls = await readKind(store, "call").catch(() => null);
  const teams = await readTeams(store).catch(() => null);
  const hosting: string[] | null = calls && teams ? [] : null;
  let tz = "UTC";
  if (calls && teams && hosting) {
    for (const product of calls) {
      if (!product.call) continue;
      const team = parseTeamSetup(teams.get(product.id), product.call);
      const me = team?.hosts.find((h) => h.email === email);
      if (!me) continue;
      hosting.push(product.title);
      if (tz === "UTC") tz = me.tz;
    }
  }
  const view = await hostCalendarView(store, email, tz).catch((error) => {
    console.error("reading a host's calendar failed", error);
    return null;
  });
  // The store's calls to connected services used, no place this month, or not counted (lib/metered-limits.ts).
  const allowance = typeof query.cal === "string" ? serviceAllowanceWords(store, query.cal) : null;
  const said = allowance ? { tone: "warn" as const, text: allowance } : outcome(typeof query.cal === "string" ? query.cal : "");

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={access.role}
        stores={access.stores}
        owned={access.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Your calendar</p>
          <h1 className="t-h2 mt-3">Your busy times, kept out of your team calls</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`Signed in as ${email}. When you host a team call, on this store or any other, the times you are busy in your own calendar are not offered, and the bookings you host can be written into your Google Calendar with a Meet link.`}
          </p>
          {said?.tone === "ok" ? <ToastOnLoad message={said.text} param="cal" /> : null}
          {said && said.tone !== "ok" ? (
            <p className={`notice mt-6 max-w-3xl ${said.tone === "warn" ? "notice-warn" : "notice-error"}`} role={said.tone === "error" ? "alert" : "status"}>
              {said.text}
            </p>
          ) : null}
          {view ? (
            <HostCalendar view={view} pin={store.sid ? `?store=${store.sid}` : ""} tz={tz} hosting={hosting} />
          ) : (
            <p className="notice notice-error mt-6" role="alert">
              We could not read your calendar settings just now. Nothing was changed. Try again in a moment.
            </p>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
