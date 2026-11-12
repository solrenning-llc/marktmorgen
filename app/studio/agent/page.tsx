import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { readBook } from "@/lib/agent-book";
import { readListingsExact } from "@/lib/catalog";
import { proposalLabel } from "@/lib/agent-proposal-label";
import { AgentProposals, type DoneRow, type ProposalRow } from "@/components/agent-proposals";
import type { Json } from "@/lib/agent-proposal-rules";

export const metadata: Metadata = {
  title: "What the AI proposes — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const text = (value: Json) => (typeof value === "string" ? value : value === null ? "" : JSON.stringify(value, null, 2));
const day = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";

/**
 * What the AI agent prepared and what it did (631 [AA1] (c)): each proposal
 * beside what the store holds now, confirmed or declined here and only here;
 * the history with undo. For a role that may change the store's settings.
 */
export default async function StudioAgentPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const book = store.statsId ? await readBook(store.statsId).catch(() => null) : { waiting: [], history: [] };
  const targets = book ? [...new Set([...book.waiting, ...book.history].map((p) => p.target).filter(Boolean))] : [];
  // Null when the titles could not be read (rule 24): the labels say so, never that the product was removed.
  const listed = targets.length ? await readListingsExact(store, targets).catch(() => null) : [];
  const titles = listed ? new Map(listed.map((p) => [p.id, p.title])) : null;
  const label = (kind: string, target: string) => proposalLabel(kind, target, titles);
  const asked = (by: string) => (by === "mcp" ? "your AI assistant, with an API key" : by === "cli" ? "the command line" : "the assistant in your studio");
  const waiting: ProposalRow[] = (book?.waiting ?? []).map((p) => ({ id: p.id, label: label(p.kind, p.target), asked: asked(p.asked.by), at: day(p.at), before: text(p.before), after: text(p.after) }));
  const history: DoneRow[] = (book?.history ?? []).map((d) => ({ id: d.id, label: label(d.kind, d.target), confirmed: `confirmed ${day(d.confirmed.at)}`, undo: d.undo, undone: d.undone ? day(d.undone.at) : null }));

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">AI assistant</p>
          <h1 className="t-h2 mt-3">What the AI proposes</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Your AI assistant never changes your store by itself. What it prepares waits here, beside what is there now, until you
            confirm it; declined, nothing changes. Proposals wait seven days. Every change you confirm is listed below, and most can
            be put back for thirty days.
          </p>
          {book ? (
            <AgentProposals waiting={waiting} history={history} />
          ) : (
            <p className="notice notice-error mt-6" role="alert">The proposals could not be read just now. Reload the page; nothing was changed.</p>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
