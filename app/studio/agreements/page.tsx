import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { AgreementsStudio } from "@/components/agreements-studio";
import { can } from "@/lib/team-roles";
import { formatMoney } from "@/lib/money";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { agreementsAllowed } from "@/lib/agreement-rules";
import { listAgreements } from "@/lib/agreement-store";
import { agreementLink } from "@/lib/agreements";
import { listRequests } from "@/lib/payment-request-store";
import { statusOf as requestStatus } from "@/lib/payment-request-rules";

export const metadata: Metadata = {
  title: "Agreements — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A store's proposals and agreements (lib/agreement-rules.ts), for a role
 * that may read orders with buyers' addresses ("orders"); sending, new
 * versions, withdrawing and deleting are for a role that may email people
 * for the store ("send").
 */
export default async function StudioAgreementsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const now = new Date().getTime();
  const [rows, used, requests] = await Promise.all([listAgreements(store), allowanceUsedExact(store, "email", now), listRequests(store, now)]);
  const payChoices = (requests ?? [])
    .filter((r) => requestStatus(r, now) === "open")
    .slice(0, 50)
    .map((r) => ({ id: r.id, label: `${r.name || r.email}: ${formatMoney(r.total, r.currency)}` }));

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
          <StudioTrail store={store} here="Agreements" />
          <h1 className="t-h2 mt-3">Proposals and agreements, signed with a link</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Write the terms in plain text, with lines and amounts if you want them, and send them to one person to sign. Marktmorgen records the
            exact text, its SHA-256 fingerprint, the version, the name they type, the time, and a one-way code made from their internet address.
            It is not a law firm and gives no legal advice: whether an agreement can be enforced depends on the law where you and they are, and on
            what it says.
          </p>
          {rows === null || requests === null ? (
            <p className="notice mt-8" role="status">Agreements or payment requests could not be verified. Reload to check them; an unavailable list does not mean there are none.</p>
          ) : <AgreementsStudio
            rows={rows.map((r) => ({ ...r, link: agreementLink(store, r) }))}
            now={now}
            currency={store.currency}
            canSend={can(view.role, "send")}
            open={agreementsAllowed(store, now / 1000)}
            emails={{ used, limit: allowanceFor(store, "email", now / 1000) }}
            payChoices={payChoices}
          />}
        </main>
      </StudioStorePin>
    </div>
  );
}
