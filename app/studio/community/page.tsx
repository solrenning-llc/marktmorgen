import type { Metadata } from "next";
import { type Reward, pointsOf, readLessonPoints, readRewards } from "@/lib/community-points";
import { idsOfKind, readCards } from "@/lib/catalog";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { formatMoney } from "@/lib/money";
import { SITE_URL } from "@/lib/site-url";
import {
  type Member,
  directorySize,
  memberPage,
  postCount,
  readConfig,
  readMembers,
  readReportedTarget,
  reportQueue,
} from "@/lib/community";
import { announcementReach, canAnnounceByEmail } from "@/lib/community-mail";
import { can } from "@/lib/team-roles";
import { CommunityStudio, type QueueRow, type StudioMember } from "@/components/community-studio";
import { CommunityEventsStudio, type StudioEvent } from "@/components/community-events-studio";
import { CommunityChallengesStudio, type StudioChallenge } from "@/components/community-challenges-studio";
import { challengeCounts, keptChallenges } from "@/lib/community-challenges";
import { challengeWindowState, CHALLENGE_DAY_MS } from "@/lib/community-challenge-rules";
import { challengeDate } from "@/lib/buyer-words/challenges";
import { VIDEO_ROOM_NOTE } from "@/lib/call-rooms";
import { configuredProviders } from "@/lib/meet-providers";
import { meetView } from "@/lib/meet-connect";
import { eventMeetings } from "@/lib/event-meetings";
import type { MeetAccount } from "@/components/call-editor";
import { videoAddress } from "@/lib/sales-page";
import {
  type CommunityEvent,
  eventClock,
  eventFields,
  eventTime,
  isOver,
  lengthWords,
  pastEvents,
  rsvpList,
  upcomingEvents,
} from "@/lib/community-events";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export const metadata: Metadata = {
  title: "Community — Marktmorgen",
  robots: { index: false, follow: false },
};

/** How many members the studio lists, most recently seen first. */
const MEMBERS_SHOWN = 500;
/** Past events the studio lists, and people it names per event. */
const PAST_SHOWN = 20;
const PEOPLE_SHOWN = 200;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

/** Where a creator runs their community: on or off, who gets in, spaces, reports, members. */
export default async function StudioCommunityPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "community" (lib/studio-route.ts).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "community");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  const id = store.community?.id ?? null;
  const config = id ? await readConfig(id) : null;

  let queue: QueueRow[] | null = [];
  let members: StudioMember[] = [];
  let totals = { members: 0, listed: 0, posts: 0, reach: 0 };
  let rewards: Reward[] = [];
  // The points a finished lesson gives (lib/lesson-points.ts); null when it could not be read (rule 24), said so.
  let lessonPoints: number | null = 0;
  let coming: StudioEvent[] = [];
  let over: StudioEvent[] = [];
  let challenges: StudioChallenge[] | null = [];
  // Google Calendar and Zoom (lib/meet-connect.ts): which accounts an event
  // can have a meeting made on, for the form. Nothing is read when the
  // deployment has neither.
  const meetOn = configuredProviders().length > 0;
  const meet = id && meetOn && can(view.role, "events") ? await meetView(store.statsId, store).catch(() => null) : null;
  const meetAccounts: MeetAccount[] = meet
    ? meet.providers.flatMap((p) => {
        const c = meet.connected[p];
        return c && !c.broken ? [{ provider: p, account: c.account }] : [];
      })
    : [];
  if (id && config) {
    // The live events, with who is coming (lib/community-events.ts): read by
    // everyone with "community"; changed only with "events".
    const now = eventClock();
    const [soon, past] = await Promise.all([upcomingEvents(id, now), pastEvents(id, null, PAST_SHOWN, now)]);
    const shownEvents = [...soon, ...past.events];
    // Who is coming is everyone or not known (rsvpList, rule 30): a list that
    // does not read is null for its event alone, shown as not known, never as
    // 0 or a short list, and the rest of the page is drawn as usual.
    const lists = await Promise.all(shownEvents.map((e) => rsvpList(id, e.id).catch(() => null)));
    const people = await readMembers(id, lists.flatMap((l) => (l ?? []).slice(0, PEOPLE_SHOWN).map((r) => r.key)));
    // What was made on Google or Zoom for the events that use them (lib/event-meetings.ts).
    const meetings = await eventMeetings(store, shownEvents).catch(() => null);
    const shape = (e: CommunityEvent, i: number): StudioEvent => ({
      id: e.id,
      title: e.title,
      about: e.about,
      ...eventFields(e),
      tz: e.tz,
      minutes: e.minutes,
      cap: e.cap,
      where: e.where,
      link: e.link,
      meet: e.meet,
      meeting: (() => {
        const record = meetings?.get(e.id);
        return record
          ? { link: record.link, made: record.made && !record.gone, error: record.error, retrying: record.todo !== "", scope: record.scope }
          : null;
      })(),
      room: e.room,
      only: e.only,
      replayUrl: e.replay ? videoAddress(e.replay) : "",
      cancelled: e.cancelled,
      over: isOver(e, now),
      started: e.start <= now,
      when: eventTime(e),
      length: lengthWords(e.minutes),
      going: lists[i]?.length ?? null,
      people: (lists[i] ?? []).slice(0, PEOPLE_SHOWN).flatMap((r) => {
        const m = people.get(r.key);
        return m ? [{ name: m.n, email: m.e, at: r.at }] : [];
      }),
      post: e.post,
    });
    // The challenges (lib/community-challenges.ts), with their counts: counts
    // that do not read are shown as not known, never as 0 (rule 30).
    // A list that does not read is said to be unreadable, never shown as none (rule 24).
    const kept = await keptChallenges(id, now).catch(() => null);
    const counted = kept ? await challengeCounts(id, kept, now).catch(() => null) : null;
    challenges = kept === null ? null : kept.map((c) => {
      const state = challengeWindowState(c.start, c.end, now);
      const n = counted?.get(c.id) ?? null;
      return {
        id: c.id,
        title: c.title,
        task: c.task,
        from: challengeDate("en-US", c.start),
        to: challengeDate("en-US", c.end - CHALLENGE_DAY_MS),
        state: state === "invalid" ? "ended" : state,
        joined: n?.joined ?? null,
        checkIns: n?.checkIns ?? null,
        today: n?.today ?? null,
      };
    });
    coming = soon.map((e, i) => shape(e, i));
    over = past.events.map((e, i) => shape(e, soon.length + i));

    const [reports, first, listed, posts, reach] = await Promise.all([
      reportQueue(id, 100).catch(() => null),
      memberPage(id, "0", 1000),
      directorySize(id),
      postCount(id),
      announcementReach(id),
    ]);
    // Everyone, when the community is small; the most recently seen when it is not.
    let all: Member[] = first.members;
    let cursor = first.next;
    for (let page = 0; cursor !== "0" && page < 60; page += 1) {
      const next = await memberPage(id, cursor, 1000);
      all = all.concat(next.members);
      cursor = next.next;
    }
    all.sort((a, b) => b.seen - a.seen);
    const points = await pointsOf(id, all.slice(0, MEMBERS_SHOWN).map((m) => m.k));
    rewards = await readRewards(id);
    lessonPoints = await readLessonPoints(id).catch(() => null);
    members = all.slice(0, MEMBERS_SHOWN).map((m) => ({
      key: m.k,
      email: m.e,
      name: m.n,
      joined: m.at,
      seen: m.seen,
      muted: m.muted,
      removed: m.removed,
      listed: m.dir && Boolean(m.n),
      mail: m.mail,
      points: points.get(m.k) ?? 0,
      answers: m.qa ? m.qq.map((q, i) => ({ q, a: m.q[i] ?? "" })) : [],
    }));
    totals = { members: first.total, listed, posts, reach };

    queue = reports === null ? null : await (async () => {
      const rows = await Promise.all(
        reports.map(async (r) => {
          const target = await readReportedTarget(id, r.target);
          if (!target) return null;
          const { post, comment } = target;
          return { r, post, comment, author: comment ? comment.a : post.a };
        }),
      );
      const found = rows.filter((x): x is NonNullable<typeof x> => x !== null);
      const names = await readMembers(id, found.map((x) => x.author));
      return found.map(({ r, post, comment, author }) => ({
        key: r.key,
        kind: r.target.kind,
        count: r.count,
        at: r.at,
        text: excerpt(comment ? comment.text : [post.title, post.text].filter(Boolean).join(" — ") || "(a picture)"),
        author: author === "creator" ? store.name : names.get(author)?.n || "A member",
        authorEmail: author === "creator" ? "" : names.get(author)?.e ?? "",
        hidden: comment ? comment.hid : post.hid,
        href: `/@${store.handle}/community/post/${post.id}${comment ? `#comment-${comment.id}` : ""}`,
      }));
    })().catch(() => null);
  }

  // The name and the price come from the one card hash; what kind of thing
  // each product is comes from the store's own index. No product record is
  // read here at all — this used to read every one of them (lib/catalog.ts).
  const cards = await readCards(store);
  const free = new Set(idsOfKind(store, "free"));
  const recurring = new Set(idsOfKind(store, "recurring"));
  const course = new Set(idsOfKind(store, "course"));
  const call = new Set(idsOfKind(store, "call"));
  const products = [...cards.values()].map((p) => ({
    id: p.id,
    title: p.title,
    free: free.has(p.id),
    kind: free.has(p.id)
      ? "Free, for a confirmed address"
      : recurring.has(p.id)
        ? `Membership · ${formatMoney(p.priceCents, store.currency)} — while it is paid`
        : course.has(p.id)
          ? `Course · ${formatMoney(p.priceCents, store.currency)}`
          : call.has(p.id)
            ? `Call · ${formatMoney(p.priceCents, store.currency)}`
            : formatMoney(p.priceCents, store.currency),
  }));

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
        <p className="eyebrow">Community</p>
        <h1 className="t-h2 mt-3">A place for your buyers</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Posts, comments and likes in spaces you set up, live events members RSVP to and join from the page, a
          member directory people choose to join, and announcements you can also email. You choose which products let people in; each visit is checked against
          your own Stripe account (and the past buyers you brought over from another platform), so a membership that stops being paid stops opening it. Members get in with a
          link sent to their inbox, with no account or password to make.
        </p>

        <CommunityStudio
          handle={store.handle}
          address={`${SITE_URL}/@${store.handle}/community`}
          on={Boolean(store.community?.on)}
          config={config}
          products={products}
          queue={queue}
          members={members}
          totals={totals}
          canEmail={canAnnounceByEmail(store)}
          canSettings={can(view.role, "settings")}
          isOwner={view.role === "owner"}
          rewards={rewards}
          lessonPoints={lessonPoints}
          courses={[...course].flatMap((id) => {
            const card = cards.get(id);
            return card ? [{ id, title: card.title }] : [];
          })}
          events={
            config ? (
              <CommunityEventsStudio
                events={coming}
                past={over}
                products={config.access.flatMap((pid) => {
                  const card = cards.get(pid);
                  return card ? [{ id: pid, title: card.title }] : [];
                })}
                spaces={config.spaces.map((s) => ({ id: s.id, name: s.name }))}
                canManage={can(view.role, "events")}
                handle={store.handle}
                roomNote={VIDEO_ROOM_NOTE}
                meetings={meetAccounts}
                hostStore={can(view.role, "settings") ? store.sid || "" : null}
              />
            ) : null
          }
        />
        {config ? <CommunityChallengesStudio challenges={challenges} canManage={can(view.role, "events")} /> : null}
      </main>
      </StudioStorePin>
    </div>
  );
}
