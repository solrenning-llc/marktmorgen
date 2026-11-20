import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { InboxStudio } from "@/components/inbox-studio";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { isSenderConfigured } from "@/lib/email";
import { isHouseStore } from "@/lib/house-store";
import { openConversation, readInbox } from "@/lib/inbox";
import { CONVERSATION_ID } from "@/lib/inbox-rules";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { MAX_FAQ } from "@/lib/store-faq";

export const metadata: Metadata = {
  title: "Inbox — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The store's inbox (lib/inbox.ts): the chat on its pages and its contact
 * form, answered in one place by whoever may answer buyers ("orders": the
 * owner, an Admin, Support).
 */
export default async function StudioInboxPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const conversations = await readInbox(store.statsId);
  // When the list on the page was read: the inbox says it as its first check (484 [IT1]).
  const readAt = readNow();
  const asked = typeof query.c === "string" && CONVERSATION_ID.test(query.c) ? query.c : "";
  const first = asked && store.statsId ? await openConversation(store.statsId, asked, store) : null;
  const team = store.sid ? await readTeam(store.sid) : { members: [] };
  const people = [store.email, ...team.members.filter((m) => can(m.role, "orders")).map((m) => m.email)];
  let ai = { on: false, left: 0 };
  let balanceUnknown = false;
  if (aiAvailableFor(store)) {
    try {
      ai = { on: true, left: await aiLeft(store) };
    } catch {
      // Keep the inbox available without claiming a known writing balance.
      balanceUnknown = true;
    }
  }
  // Why the chat cannot be turned on, when it cannot: the demo store takes no messages, and a store needs its address and our sender.
  const chatBlock = isHouseStore(store) ? "demo" : store.statsId && store.email && !store.suspended && isSenderConfigured() ? "" : "setup";

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
          <StudioTrail store={store} here="Inbox" />
          <h1 className="t-h2 mt-3">What people write to you</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Your store&apos;s chat and its contact form, in one place. Answer here: it shows in their chat and goes to their email, and the conversation stays
            together for whoever on your team picks it up.
          </p>
          <div className="mt-8">
            {balanceUnknown ? (
              <p role="status" className="mb-4 text-sm text-ink-soft">Writing allowance couldn&apos;t be checked. Reload to try again.</p>
            ) : null}
            <InboxStudio
              me={view.email}
              initial={first ? conversations.map((c) => (c.id === first.conversation.id ? first.conversation : c)) : conversations}
              first={first}
              people={people}
              setting={store.inbox}
              ai={ai}
              canSettings={can(view.role, "settings")}
              readAt={readAt}
              chatBlock={chatBlock}
              faq={can(view.role, "page") ? { room: MAX_FAQ - store.faq.length, href: studioPath(store) } : null}
            />
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}

/** Now, in milliseconds: when the list on the page was read. */
function readNow(): number {
  return Date.now();
}
