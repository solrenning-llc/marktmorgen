import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { Icon } from "@/components/icons";
import { NewTab } from "@/components/new-tab";
import { type TaxRegistration, placeOf, readTaxRegistrations } from "@/lib/tax-registrations";
import { sellsThroughPayPal } from "@/lib/paypal-sales";

export const metadata: Metadata = { title: "Where you collect tax — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

/** Stripe's kinds of registration, in plain words (https://docs.stripe.com/tax/registering, read 6 November 2026). */
const KINDS: Record<string, string> = {
  state_sales_tax: "State sales tax",
  home_rule_tax: "Local sales tax (home rule city)",
  standard: "Standard registration",
  simplified: "Simplified registration",
  province_standard: "Provincial tax",
  oss_union: "EU One Stop Shop, Union scheme",
  oss_non_union: "EU One Stop Shop, non-Union scheme",
  ioss: "EU Import One Stop Shop",
};

const day = (seconds: number) =>
  new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(seconds * 1000));

function kindOf(registration: TaxRegistration): string {
  if (!registration.type) return "Registration";
  return KINDS[registration.type] ?? `Other (Stripe calls it “${registration.type.replaceAll("_", " ")}”)`;
}

/**
 * Where you collect tax (655 [WG15]): the tax registrations active on the
 * store's own Stripe account, read only, for a role that may see payments
 * (lib/team-roles.ts). Nothing here works out when tax starts, promises coverage
 * or changes Marktmorgen's own tax rules; the creator adds or corrects a
 * registration in Stripe.
 */
export default async function StudioTaxPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "payments");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  const registrations = await readTaxRegistrations(store);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Tax" />
          <h1 className="t-h2 mt-3">Where you collect tax</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            The tax registrations that are active on your Stripe account, as Stripe lists them.
            This is information from your Stripe account, not tax advice.
          </p>
          {/* What is true now (Claude 4 on #2735): the checkout asks Stripe for tax only while it is on (lib/tax.ts, applyTax). */}
          <p className="mt-3 max-w-2xl text-ink">
            {/* Claude 5 on #2735: with prices that include tax (tax_behavior inclusive) Stripe adds nothing on top; the tax comes out of the price. */}
            {store.tax.enabled ? (
              store.tax.included ? (
                "Tax is on in your checkout and your prices include it: where you have an active registration, Stripe takes the tax out of your price."
              ) : (
                "Tax is on in your checkout: Stripe adds it only where you have an active registration."
              )
            ) : (
              <>
                Tax is off in your checkout, so Stripe adds none now, even where you are registered.{" "}
                <Link href={`${studioPath(store)}#tax-title`} className="font-semibold underline underline-offset-4">
                  Turn on tax in your studio
                </Link>
                .
              </>
            )}
            {/* Revisor 1 on #2735: a sale paid with PayPal adds no tax (lib/paypal-sales.ts reads no store.tax). */}
            {sellsThroughPayPal(store) ? " Sales paid with PayPal have no tax added." : null}
          </p>

          <section aria-labelledby="registrations-title" className="mt-8 max-w-3xl">
            <h2 id="registrations-title" className="text-lg font-semibold text-ink">Your active registrations</h2>
            {registrations.state === "none" ? (
              <p className="mt-3 text-ink-soft">This store has no Stripe account connected yet, so there is nothing to show.</p>
            ) : registrations.state === "unknown" ? (
              <div role="status" className="mt-3 rounded-2xl border border-line bg-white p-4">
                <p className="font-semibold text-ink">We could not read this.</p>
                <p className="mt-1 text-ink-soft">
                  Stripe did not answer the way we expected just now, so we are not showing a list that might be wrong
                  or cut short. Open this page again in a few minutes, or see your registrations in Stripe.
                </p>
              </div>
            ) : registrations.list.length === 0 ? (
              <p className="mt-3 text-ink-soft">Stripe lists no active tax registrations on your account.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Tax registrations active on your Stripe account</caption>
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="py-2 pr-4 font-semibold">Where</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Kind</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Since</th>
                      <th scope="col" className="py-2 font-semibold">Ends</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registrations.list.map((registration) => (
                      <tr key={registration.id} className="border-b border-line">
                        <th scope="row" className="py-2 pr-4 font-semibold">{placeOf(registration)}</th>
                        <td className="py-2 pr-4">{kindOf(registration)}</td>
                        <td className="py-2 pr-4">{day(registration.activeFrom)}</td>
                        <td className="py-2">{registration.expiresAt === null ? "No end date" : day(registration.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {registrations.state !== "none" ? (
              <>
                <a href={registrations.dashboard} target="_blank" rel="noopener noreferrer" className="btn btn-secondary mt-5">
                  Add or correct a registration in Stripe
                  <Icon name="arrow-up-right" size={16} />
                  <NewTab />
                </a>
                <p className="mt-2 max-w-2xl text-xs text-ink-soft">
                  Opens the Locations tab of the Tax page in your own Stripe dashboard. Marktmorgen never adds, changes or
                  ends a registration for you. What you change there shows here within half a day.
                </p>
              </>
            ) : null}
          </section>
        </main>
      </StudioStorePin>
    </div>
  );
}
