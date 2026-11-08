import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { PaymentRequestsStudio, type Prefill } from "@/components/payment-requests-studio";
import { can } from "@/lib/team-roles";
import { readMoney, moneyField } from "@/lib/money";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsedExact } from "@/lib/store-allowance";
import { shareOfSaleWords } from "@/lib/fee-words";
import { MAX_LINE_TEXT, MAX_NAME, dueRange, requestLimitsFor } from "@/lib/payment-request-rules";
import { listRequests, openCount } from "@/lib/payment-request-store";
import { refreshRefunds, requestLink, requestsOpen } from "@/lib/payment-requests";

export const metadata: Metadata = {
  title: "Payment requests — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A store's payment requests and invoices (lib/payment-request-rules.ts), for
 * a role that may read orders with buyers' addresses ("orders"); sending,
 * reminding, canceling and deleting are for a role that may email people
 * for the store ("send"). A deal's "Request payment" opens this page with
 * its person and amount filled in (?email=&name=&for=&amount=).
 */
export default async function StudioRequestsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const now = new Date().getTime();
  const listed = await listRequests(store, now);
  const [requests, used, openNow] = await Promise.all([listed === null ? Promise.resolve([]) : refreshRefunds(store, listed, now), allowanceUsedExact(store, "email", now), openCount(store.sid, now).catch(() => null)]);
  const open = requestsOpen(store);
  const read = (name: string, max: number) => (typeof query[name] === "string" ? (query[name] as string).slice(0, max) : "");
  const typed = read("amount", 20);
  const cents = typed ? readMoney(typed, store.currency) : null;
  const prefill: Prefill = { email: read("email", 254), name: read("name", MAX_NAME), text: read("for", MAX_LINE_TEXT), amount: cents ? moneyField(cents, store.currency) : "" };
  const { first, last } = dueRange(now);
  const share = shareOfSaleWords(store.tier);

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
          <p className="eyebrow">Payment requests</p>
          <h1 className="t-h2 mt-3">Ask one person to pay you, with a link</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            A custom amount for work you agreed on, as an invoice with lines, a due date if you want one, and its receipt. Each is paid like any
            sale here: on your own Stripe account, listed with your sales, and refunded from Stripe the same way.
          </p>
          {can(view.role, "export") ? <p className="mt-6"><Link prefetch={false} href={studioPath(store, "", "disputes")} className="link inline-flex min-h-11 items-center">Review a disputed purchase</Link></p> : null}
          {listed === null || openNow === null ? <div role="status" className="notice mt-8">Payment requests and their open count could not be verified. Reload to check them; an unavailable list does not mean there are no requests.</div> : <PaymentRequestsStudio
            rows={requests.map((r) => ({ ...r, link: requestLink(store, r) }))}
            now={now}
            currency={store.currency}
            canSend={can(view.role, "send")}
            open={open}
            closedWhy="Payment requests can be sent once your Stripe account takes payments and your plan, or free trial, is running."
            limits={requestLimitsFor(store, now / 1000)}
            openNow={openNow}
            emails={{ used, limit: allowanceFor(store, "email", now / 1000) }}
            shareWords={share === "nothing from a sale" ? "Your plan takes nothing from a sale, and nothing from these." : `Your plan's share applies as on any sale: ${share}. These earn no affiliate or partner share.`}
            taxOn={store.tax.enabled}
            prefill={prefill}
            dueFirst={first}
            dueLast={last}
          />}
        </main>
      </StudioStorePin>
    </div>
  );
}
