import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readTitles } from "@/lib/catalog";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { storeKey } from "@/lib/learn";
import { isDiscordConfigured, serverRoles } from "@/lib/discord";
import { CHECK_HOURS, MAX_DISCORD_PRODUCTS, MAX_PRODUCT_ROLES, assignable } from "@/lib/discord-rules";
import { membersOf, productRoles, readServer } from "@/lib/discord-store";
import { DiscordStudio } from "@/components/discord-studio";

export const metadata: Metadata = {
  title: "Discord — Marktmorgen",
  robots: { index: false, follow: false },
};

const NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  connected: { tone: "ok", text: "Your Discord server is connected. Now choose which products give which roles." },
  declined: { tone: "error", text: "Nothing was connected: the bot was not added on Discord's page." },
  error: { tone: "error", text: "The server could not be connected just now. Nothing was changed; try again in a moment." },
  limited: { tone: "error", text: "That is a lot of tries in a few minutes. Wait a little and try again." },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Discord access (lib/discord-rules.ts): the creator's own server, opened by
 * the products they choose, each giving the roles they pick. For the owner
 * and Admins ("settings"). Not there until the deployment has Discord's keys.
 */
export default async function StudioDiscordPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  if (!isDiscordConfigured()) redirect(studioPath(store));
  const room = storeKey(store);
  const server = await readServer(room);
  const [read, mapping, members, titles] = await Promise.all([
    server ? serverRoles(server.id).catch(() => null) : Promise.resolve(null),
    productRoles(room),
    server ? membersOf(room, 200) : Promise.resolve([]),
    readTitles(store),
  ]);
  const notice = typeof query.discord === "string" ? NOTICES[query.discord] ?? null : null;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Discord</p>
          <h1 className="t-h2 mt-3">Your Discord server, opened by what people buy</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`Choose which products give which roles in your server. A buyer presses “Join the Discord” after paying, says yes on Discord's own page, and is in with those roles. They keep them while they hold what they bought; when a membership ends or a purchase is refunded in full, the roles are taken back at the next check, which comes about every ${CHECK_HOURS} hours. While Stripe or Discord cannot be reached, or Discord will not let the bot remove a role, nothing is taken until it can be.`}
          </p>
          {notice ? (
            <p className={`notice ${notice.tone === "ok" ? "notice-success" : "notice-error"} mt-6`} role={notice.tone === "ok" ? "status" : "alert"}>
              {notice.text}
            </p>
          ) : null}
          <DiscordStudio
            connectAction={`/api/store/discord/connect${store.sid ? `?store=${store.sid}` : ""}`}
            server={server ? { name: server.name, kick: server.kick, reachable: read !== null } : null}
            roles={read && server ? assignable(read.roles, server.id, read.botTop) : []}
            allRoles={read ? read.roles.map((r) => ({ id: r.id, name: r.name })) : []}
            products={[...titles].map(([id, title]) => ({ id, title, roles: mapping.get(id) ?? [] }))}
            members={members.map(({ id, member }) => ({ id, name: member.n, email: member.e, roles: member.r.length, at: member.at }))}
            limits={{ roles: MAX_PRODUCT_ROLES, products: MAX_DISCORD_PRODUCTS, hours: CHECK_HOURS }}
          />
        </main>
      </StudioStorePin>
    </div>
  );
}
