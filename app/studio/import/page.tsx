import type { Metadata } from "next";
import { IMPORT_DATE } from "@/lib/import-words";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { Icon, type IconName } from "@/components/icons";
import { type ImportJob, IMPORT_LIMITS, storeImports } from "@/lib/imports";
import { ImportProgress, ImportTool, type ImportKind, type ImportView } from "@/components/import-tool";
import { isPaidUp } from "@/lib/billing";
import { isSenderConfigured } from "@/lib/email";
import { listCounts } from "@/lib/contacts";
import { KIND, productCount, readCards } from "@/lib/catalog";
import { MAX_PRODUCTS } from "@/lib/store";
import { moveCounts } from "@/lib/move-members";
import { formatMoney } from "@/lib/money";
import { can } from "@/lib/team-roles";
import { MAX_SITE_PAGES } from "@/lib/site-page-rules";
import { ClickFunnelsFunnel, type FunnelProduct } from "@/components/clickfunnels-funnel";
import { importAllowanceFor } from "@/lib/import-limits";

export const metadata: Metadata = {
  title: "Moving from another platform — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const TABS: { kind: ImportKind; title: string; text: string; icon: IconName }[] = [
  {
    kind: "contacts",
    title: "Your email list",
    text: `Up to ${IMPORT_LIMITS.contacts.toLocaleString("en-US")} people who agreed to hear from you.`,
    icon: "mail",
  },
  {
    kind: "products",
    title: "Your products",
    text: `Up to ${IMPORT_LIMITS.products.toLocaleString("en-US")} at once, as drafts to check and publish.`,
    icon: "tag",
  },
  {
    kind: "purchases",
    title: "Your past buyers",
    text: `Up to ${IMPORT_LIMITS.purchases.toLocaleString("en-US")} rows: they keep their courses and files.`,
    icon: "users",
  },
  {
    kind: "members",
    title: "Your members",
    text: `Up to ${IMPORT_LIMITS.members.toLocaleString("en-US")}: each keeps their membership here, first paying on its renewal date.`,
    icon: "repeat",
  },
];

/** Moving from ClickFunnels, in the order it goes best: products first, because buyers and funnels name them. */
const CLICKFUNNELS_STEPS: { step: "products" | "contacts" | "purchases" | "funnel"; title: string; text: string; icon: IconName }[] = [
  { step: "products", title: "1. Products", text: "Your Products export, as drafts.", icon: "tag" },
  { step: "contacts", title: "2. Contacts", text: "Your Contacts export, with each one's Status.", icon: "mail" },
  { step: "purchases", title: "3. Past buyers", text: "Your Orders export: paid orders only.", icon: "users" },
  { step: "funnel", title: "4. Funnel pages", text: "Your saved pages, made into a funnel.", icon: "layout" },
];

const DATE = IMPORT_DATE;

function view(job: ImportJob): ImportView {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    file: job.file,
    at: job.at,
    finishedAt: job.finishedAt,
    expected: job.expected,
    total: job.total,
    done: job.done,
    counts: job.counts,
    email: job.options.email,
    source: job.options.source ?? "csv",
  };
}

/**
 * Moving from another platform: a creator's list, products and past buyers,
 * brought over from a spreadsheet the old platform exports (lib/imports.ts).
 * For the owner and admins (the "import" permission, lib/team-roles.ts).
 */
export default async function StudioImportPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "import");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const { store } = access;
  const clickFunnels = query.what === "clickfunnels";
  const cfStep = CLICKFUNNELS_STEPS.find((s) => s.step === query.step)?.step ?? "products";
  const kind: ImportKind = clickFunnels
    ? cfStep === "funnel"
      ? "products"
      : cfStep
    : query.what === "products" || query.what === "purchases" || query.what === "members"
      ? query.what
      : "contacts";
  const canFunnel = can(access.role, "page") && can(access.role, "products");
  const [jobs, counts, moved, listings] = await Promise.all([
    storeImports(store).catch(() => []),
    listCounts(store.listId).catch(() => null),
    kind === "members" ? moveCounts(store).catch(() => null) : Promise.resolve(null),
    // One read of every product's name and price; what kind each is, from the store's own index.
    clickFunnels && cfStep === "funnel" && canFunnel ? readCards(store).catch(() => null) : Promise.resolve(null),
  ]);
  const funnelProducts: FunnelProduct[] = listings
    ? store.catalog.items.flatMap((item) => {
        const card = listings.get(item.id);
        if (!card) return [];
        const is = (kind: keyof typeof KIND) => (item.kind & KIND[kind]) !== 0;
        return [
          {
            id: item.id,
            title: card.title,
            price: card.priceCents === 0 ? "free" : formatMoney(card.priceCents, store.currency),
            call: is("call"),
            // Could be offered at checkout or after paying: checked in full when the funnel is checked.
            bumpable: is("paid") && !is("call") && !is("recurring") && !is("limited") && item.options.length === 0,
            hidden: is("hidden"),
          },
        ];
      })
    : [];
  const running = jobs.find((job) => job.state === "receiving" || job.state === "queued" || job.state === "running" || job.state === "mailing") ?? null;
  const past = jobs.filter((job) => job.id !== running?.id);
  const tab = TABS.find((t) => t.kind === kind)!;
  const facts: Record<ImportKind, string> = {
    contacts: counts ? `Your list has ${counts.mailable.toLocaleString("en-US")} people you may email now.` : "",
    products: `Your store has ${productCount(store).toLocaleString("en-US")} of ${MAX_PRODUCTS.toLocaleString("en-US")} products.`,
    purchases: "Products are matched by their name or their id in your store, so bring your products over first.",
    members: moved && moved.invited
      ? `${moved.invited.toLocaleString("en-US")} ${moved.invited === 1 ? "member" : "members"} invited so far, and ${moved.kept.toLocaleString("en-US")} kept their membership here.`
      : "Make the membership in your store first, at the same price, then bring its members.",
  };

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
          <p className="eyebrow">Moving from another platform</p>
          <h1 className="t-h2 mt-3">Bring your store with you</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Export a spreadsheet from Stan, Gumroad, Kajabi, Patreon, Mailchimp or anywhere else, choose it here, and say which column is
            which. Every row is checked the way the studio checks what you type, and any row that could not be brought in is
            listed in a file you can download, with the reason.
          </p>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft">
            {(() => {
              const a = importAllowanceFor(store);
              return `This month your plan brings in up to ${a.rows.toLocaleString("en-US")} rows, all imports together, with ${a.checks.toLocaleString("en-US")} dry-run batches of contacts or products and ${a.buyerChecks.toLocaleString("en-US")} of past buyers. Moving funnels from ClickFunnels: ${a.pageReads.toLocaleString("en-US")} saved pages read, ${a.funnelChecks.toLocaleString("en-US")} funnel checks and ${a.funnelSaves.toLocaleString("en-US")} funnels made. ${a.movedEmails > 0 ? `Emails to people brought over: ${a.movedEmails.toLocaleString("en-US")} this month.` : "Emails to people brought over count in your plan\u2019s monthly emails."} Each figure starts again with your next billing month (for a store with no plan, on the 1st, UTC).`;
            })()}
          </p>

          <Link
            href={studioPath(store, "what=clickfunnels", "import")}
            aria-current={clickFunnels ? "page" : undefined}
            className={`mt-6 flex min-h-[44px] items-center gap-3 rounded-2xl p-4 ring-1 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand sm:max-w-xl ${
              clickFunnels ? "bg-lilac ring-violet-brand/40" : "bg-white ring-line hover:ring-violet-brand/40"
            }`}
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep">
              <Icon name="door" size={18} />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-ink">Move from ClickFunnels</span>
              <span className="mt-0.5 block text-sm leading-snug text-ink-soft">
                Contacts with their consent status, products, past buyers and your funnel&apos;s pages, each checked in a dry run first.
              </span>
            </span>
          </Link>

          {clickFunnels ? (
            <section className="mt-8" aria-labelledby="cf-title">
              <h2 id="cf-title" className="t-h3">Move from ClickFunnels</h2>
              <p className="mt-2 max-w-2xl text-sm text-ink-soft">
                In ClickFunnels, export your Products, Contacts and Orders from their own pages (choose the fields to include, then download the
                file). Bring them in the order below. Each file is checked first in a dry run that saves nothing, then imported; importing the
                same file again makes nothing twice.{" "}
                <Link href="/platform/move-from-clickfunnels" className="font-bold text-violet-deep underline underline-offset-4">
                  How a move from ClickFunnels works
                </Link>
              </p>
              <nav aria-label="Steps of a move from ClickFunnels" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {CLICKFUNNELS_STEPS.map((s) => {
                  const on = s.step === cfStep;
                  return (
                    <Link
                      key={s.step}
                      href={studioPath(store, `what=clickfunnels&step=${s.step}`, "import")}
                      aria-current={on ? "step" : undefined}
                      className={`flex min-h-[44px] items-start gap-3 rounded-2xl p-4 ring-1 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand ${
                        on ? "bg-lilac ring-violet-brand/40" : "bg-white ring-line hover:ring-violet-brand/40"
                      }`}
                    >
                      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${on ? "bg-white text-violet-deep" : "bg-lilac text-violet-deep"}`}>
                        <Icon name={s.icon} size={18} />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-semibold text-ink">{s.title}</span>
                        <span className="mt-0.5 block text-sm leading-snug text-ink-soft">{s.text}</span>
                      </span>
                    </Link>
                  );
                })}
              </nav>
              <div className="mt-6 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
                <section className="card min-w-0 p-5 sm:p-7" aria-labelledby="cf-step-title">
                  <h3 id="cf-step-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                    {CLICKFUNNELS_STEPS.find((s) => s.step === cfStep)!.title}
                  </h3>
                  {cfStep === "funnel" ? (
                    <div className="mt-5">
                      {canFunnel ? (
                        <ClickFunnelsFunnel
                          products={funnelProducts}
                          pagesLeft={Math.max(0, MAX_SITE_PAGES - store.sitePages.length)}
                          funnelsHref={studioPath(store, "", "funnels")}
                          pagesHref={studioPath(store, "", "pages")}
                        />
                      ) : (
                        <p className="notice notice-warn text-sm">Only the store&apos;s owner and Admins can make pages and funnels.</p>
                      )}
                    </div>
                  ) : (
                    <>
                      {facts[kind] ? <p className="mt-1 text-sm text-ink-soft">{facts[kind]}</p> : null}
                      <div className="mt-5">
                        <ImportTool
                          key={`cf-${kind}`}
                          kind={kind}
                          source="clickfunnels"
                          active={running ? view(running) : null}
                          canEmail={isPaidUp(store) && isSenderConfigured()}
                          storeName={store.name}
                        />
                      </div>
                    </>
                  )}
                </section>
                <PastImports past={past} />
              </div>
            </section>
          ) : null}

          {!clickFunnels ? (
            <>
          <nav aria-label="What to import" className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {TABS.map((t) => {
              const on = t.kind === kind;
              return (
                <Link
                  key={t.kind}
                  href={studioPath(store, `what=${t.kind}`, "import")}
                  aria-current={on ? "page" : undefined}
                  className={`flex min-h-[44px] items-start gap-3 rounded-2xl p-4 ring-1 transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-brand ${
                    on ? "bg-lilac ring-violet-brand/40" : "bg-white ring-line hover:ring-violet-brand/40"
                  }`}
                >
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${on ? "bg-white text-violet-deep" : "bg-lilac text-violet-deep"}`}>
                    <Icon name={t.icon} size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">{t.title}</span>
                    <span className="mt-0.5 block text-sm leading-snug text-ink-soft">{t.text}</span>
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="mt-6 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
            <section className="card min-w-0 p-5 sm:p-7" aria-labelledby="import-title">
              <h2 id="import-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                {tab.title}
              </h2>
              {facts[kind] ? <p className="mt-1 text-sm text-ink-soft">{facts[kind]}</p> : null}
              <div className="mt-5">
                <ImportTool
                  key={kind}
                  kind={kind}
                  active={running ? view(running) : null}
                  canEmail={isPaidUp(store) && isSenderConfigured()}
                  storeName={store.name}
                />
              </div>
            </section>

            <PastImports past={past} />
          </div>
            </>
          ) : null}
        </main>
      </StudioStorePin>
    </div>
  );
}

/** The store's last imports, each with its counts and report. */
function PastImports({ past }: { past: ImportJob[] }) {
  return (
    <aside className="card min-w-0 p-5 sm:p-6" aria-labelledby="past-title">
      <h2 id="past-title" className="text-base font-semibold text-ink">
        Your last imports
      </h2>
      {past.length === 0 ? (
        <p className="mt-2 text-sm text-ink-soft">None yet. Each one is listed here for two weeks, with its report.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {past.map((job) => (
            <li key={job.id}>
              <p className="text-sm font-semibold text-ink">{`${TABS.find((t) => t.kind === job.kind)?.title ?? job.kind}${job.options.source === "clickfunnels" ? " from ClickFunnels" : ""}${job.file ? `: ${job.file}` : ""}`}</p>
              <p className="mb-2 text-xs text-ink-soft">{`${DATE.format(new Date(job.at))} UTC · ${job.total.toLocaleString("en-US")} rows`}</p>
              <ImportProgress job={view(job)} compact />
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
