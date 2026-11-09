import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { CREATOR, directory, directorySize } from "@/lib/community";
import { communityVisitor } from "@/lib/community-page";
import { mayMessage, pairOf } from "@/lib/community-dm";
import { DIRECTORY_PAGE } from "@/lib/community-text";
import { CommunityBar, CreatorBadge, Face, LevelBadge } from "@/components/community-parts";
import { levelOf, pointsOf } from "@/lib/community-points";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { NamesUnread } from "@/components/community-names-unread";
import { listedPrivacy } from "@/lib/buyer-words/community-names-unread";

type Params = { params: Promise<{ handle: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).tabMembers} — Marktmorgen`, robots: { index: false, follow: false } };
}

function joined(seconds: number, locale: string): string {
  return new Date(seconds * 1000).toLocaleDateString(locale, { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Who is here: the creator, then every member who chose to be listed, by the
 * name they chose, newest first. Never an address: the directory has none to
 * show, because a member's record is read for their name and nothing else.
 */
export default async function CommunityMembersPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);
  const id = store.community.id;
  const w = communityWords(store.language);
  const locale = LANGUAGES[store.language].locale;
  const query = await searchParams;
  const beforeRaw = typeof query.before === "string" ? Number(query.before) : NaN;
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : null;
  // A page of the directory that could not be read (rules 24 and 30) is said so, never drawn as nobody listed.
  const [read, total] = await Promise.all([
    directory(id, before, DIRECTORY_PAGE).catch((error: unknown) => {
      console.error("the community directory could not be read", error);
      return null;
    }),
    // The count too (rules 24 and 30): unread, no number is shown, and the page says the list could not be loaded.
    directorySize(id).catch((error: unknown) => {
      console.error("the community directory size could not be read", error);
      return null;
    }),
  ]);
  const page = read ?? { members: [], next: null };
  const listed = viewer.member?.dir && viewer.member.n;
  const points = await pointsOf(id, page.members.map((m) => m.k));
  const { config, key } = viewer;
  // The link to write to somebody, where writing to them is allowed at all.
  // Nothing is drawn for yourself, and nothing where the answer would be no:
  // an offer that leads to a refusal is worse than no offer.
  const writeTo = (who: string) => {
    if (who === key || mayMessage(config.dm, key, who)) return null;
    return (
      <p className="mt-1">
        <Link href={`${home}/messages/${pairOf(key, who)}`} className="cm-quiet-link cm-mini text-xs font-semibold">
          {w.messageLink}
        </Link>
      </p>
    );
  };

  return (
    <div lang={locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={viewer.config} tab="members" signedIn />
      <main id="content" className="mx-auto max-w-3xl px-4 pb-16 pt-6">
        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">{w.tabMembers}</h1>
        {/* The privacy promise is true whatever the count: an unread count hides its number, never the promise. */}
        <p className="st-muted mt-2">
          {total !== null ? w.listedTotal(total) : listedPrivacy(store.language)}
        </p>
        {!viewer.owner ? (
          <p className="st-muted mt-1 text-sm">
            {listed ? w.youListed : w.youNotListed}{" "}
            <Link href={`${home}/you`} className="font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
              {listed ? w.changeThat : w.chooseNameListed}
            </Link>
          </p>
        ) : null}

        {read === null || total === null ? <NamesUnread language={store.language} what="membersList" className="mt-6" /> : null}
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {!before ? (
            <li className="st-card flex items-center gap-3 p-4">
              <Face store={store} author={CREATOR} name={store.name} size={44} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-bold">
                  <span className="break-words">{store.name}</span>
                  <CreatorBadge store={store} />
                </p>
                <p className="st-muted text-sm">{w.runsCommunity}</p>
                {writeTo(CREATOR)}
              </div>
            </li>
          ) : null}
          {page.members.map((m) => (
            <li key={m.k} className="st-card flex items-center gap-3 p-4">
              <Face store={store} author={m.k} name={m.n} size={44} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-bold">
                  <span className="break-words">{m.n}</span>
                  <LevelBadge level={levelOf(points.get(m.k) ?? 0)} store={store} />
                </p>
                <p className="st-muted text-sm">{w.joined(joined(m.at, locale))}</p>
                {writeTo(m.k)}
              </div>
            </li>
          ))}
        </ul>
        {page.next ? (
          <p className="mt-6 text-center">
            <Link href={`${home}/members?before=${page.next}`} className="cm-pill cm-pill-wide">{w.moreMembers}</Link>
          </p>
        ) : null}
      </main>
    </div>
  );
}
