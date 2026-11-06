import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { communityVisitor } from "@/lib/community-page";
import { canAnnounceByEmail } from "@/lib/community-mail";
import { MAX_ANSWER, MAX_DISPLAY_NAME } from "@/lib/community-text";
import { Carry, CommunityBar, communityNotices } from "@/components/community-parts";
import { communityWords } from "@/lib/buyer-words/community";
import { LANGUAGES } from "@/lib/store-language";
import { levelOf, pointsOf, toNextLevel } from "@/lib/community-points";
import { MAX_MEMBER_LINKS } from "@/lib/member-links";
import { MemberLinkBoxes } from "@/components/member-link-boxes";

type Params = { params: Promise<{ handle: string }>; searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${communityWords(store?.language).tabYou} — Marktmorgen`, robots: { index: false, follow: false } };
}

/** A member's own choices: the name they are seen by, the directory and their links in it, the emails. */
export default async function CommunityYouPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const viewer = await communityVisitor(store, await cookies());
  if (viewer.state === "off" || !store.community) redirect(`/@${store.handle}`);
  const home = `/@${store.handle}/community`;
  if (viewer.state !== "in") redirect(home);
  const query = await searchParams;
  const w = communityWords(store.language);
  const NOTICES = communityNotices(store.language);
  const notice = NOTICES[typeof query.n === "string" ? query.n : ""] ?? null;
  const member = viewer.member;
  const points = member ? (await pointsOf(store.community.id, [member.k])).get(member.k) ?? 0 : 0;
  const toNext = toNextLevel(points);

  return (
    <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <CommunityBar store={store} config={viewer.config} tab="you" signedIn />
      <main id="content" className="mx-auto max-w-xl px-4 pb-16 pt-6">
        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">{w.tabYou}</h1>
        {notice ? <p className={`cm-flash mt-4 ${notice.tone === "warn" ? "cm-flash-warn" : ""}`} role="status">{notice.text}</p> : null}

        {viewer.owner ? (
          <div className="st-card mt-6 p-6">
            <p className="font-bold">{w.youRun}</p>
            <p className="st-muted mt-2 text-sm">
              {w.youRunNote(store.name)}
            </p>
            <Link href="/studio/community" className="btn st-btn mt-4">{w.openStudio}</Link>
          </div>
        ) : !member ? (
          <p className="cm-flash cm-flash-warn mt-6">{NOTICES.full.text}</p>
        ) : (
          <form action="/api/store/community" method="post" className="st-card mt-6 space-y-5 p-6">
            <Carry store={store} action="profile" from="you" />
            <div>
              <label htmlFor="you-name" className="st-label">{w.nameLabel}</label>
              <input id="you-name" name="name" defaultValue={member.n} maxLength={MAX_DISPLAY_NAME} autoComplete="nickname" placeholder={w.namePlaceholder} className="st-field mt-2" />
              <p className="st-muted mt-1 text-sm">{w.nameNote}</p>
              {member.h ? (
                <p className="st-muted mt-1 text-sm">
                  {w.handleBefore}
                  <span className="font-semibold" style={{ color: "var(--st-text)" }}>{`@${member.h}`}</span>
                  {w.handleAfter}
                </p>
              ) : null}
            </div>
            {viewer.config.questions.length ? (
              <fieldset className="space-y-4">
                <legend className="st-label">{w.asksEveryone(store.name)}</legend>
                <p className="st-muted -mt-2 text-sm">
                  {w.asksNote(store.name)}
                </p>
                {viewer.config.questions.map((question, i) => (
                  <div key={i}>
                    <label htmlFor={`you-answer-${i}`} className="block text-sm font-semibold">{question}</label>
                    <textarea
                      id={`you-answer-${i}`}
                      name="answer"
                      rows={2}
                      maxLength={MAX_ANSWER}
                      defaultValue={member.q[i] ?? ""}
                      className="st-field mt-2 resize-y"
                    />
                  </div>
                ))}
              </fieldset>
            ) : null}
            <label className="flex min-h-11 items-start gap-3">
              <input type="checkbox" name="dir" value="1" defaultChecked={member.dir} className="mt-0.5 h-5 w-5 shrink-0" />
              <span>
                <span className="block font-semibold">{w.listMe}</span>
                <span className="st-muted block text-sm">{w.listMeNote}</span>
              </span>
            </label>
            <MemberLinkBoxes
              kept={member.s.map((link) => link.url)}
              words={{
                legend: w.linksLegend,
                note: w.linksNote,
                labels: Array.from({ length: MAX_MEMBER_LINKS }, (_, i) => w.linkLabel(i + 1)),
                refused: w.linkRefused,
              }}
            />
            <label className="flex min-h-11 items-start gap-3">
              <input type="checkbox" name="mail" value="1" defaultChecked={member.mail} className="mt-0.5 h-5 w-5 shrink-0" />
              <span>
                <span className="block font-semibold">{w.emailMe(store.name)}</span>
                <span className="st-muted block text-sm">
                  {canAnnounceByEmail(store)
                    ? w.emailMeAnnounces(store.name, viewer.email)
                    : w.emailMeReminders(store.name, viewer.email)}
                </span>
              </span>
            </label>
            <button type="submit" className="btn st-btn">{w.save}</button>
          </form>
        )}

        {member ? (
          <div className="st-card mt-6 p-6">
            <p className="font-bold">{w.levelBadge(levelOf(points))}</p>
            <p className="st-muted mt-2 text-sm">
              {w.myPoints(points)}
              {` ${toNext !== null ? w.myToNext(toNext, levelOf(points) + 1) : w.topLevel}`}
            </p>
            <Link href={`${home}/leaderboard`} className="cm-pill mt-4">{w.seeLeaderboard}</Link>
          </div>
        ) : null}

        <div className="st-card mt-6 p-6">
          <p className="font-bold">{w.thisDevice}</p>
          <p className="st-muted mt-2 text-sm">
            {viewer.owner
              ? w.ownerDevice
              : w.memberDevice(viewer.email, store.name)}
          </p>
          {!viewer.owner ? (
            <form action="/api/store/community" method="post" className="mt-4">
              <Carry store={store} action="signout" from="you" />
              <button type="submit" className="cm-pill">{w.signOutDevice}</button>
            </form>
          ) : null}
        </div>
      </main>
    </div>
  );
}
