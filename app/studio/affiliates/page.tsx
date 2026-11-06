import type { Metadata } from "next";
import { idsOfKind, readTitles } from "@/lib/catalog";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { affiliateLink, readBook } from "@/lib/affiliates";
import { isSenderConfigured } from "@/lib/email";
import { canSell } from "@/lib/store-checkout";
import { AffiliateStudio } from "@/components/affiliate-studio";
import { PayPalPayouts } from "@/components/paypal-payouts";
import { onTheirWay, payableLines, paypalChecks, readPayPal, settlePayPal } from "@/lib/paypal-payouts";
import { batchTotal } from "@/lib/affiliate-payouts";
import { codeOwners } from "@/lib/affiliate-codes";
import { offerWords, waitingFor } from "@/lib/partner-invites";
import { PartnerOffers } from "@/components/affiliate-studio";
import { listCodes, offLabel } from "@/lib/discount";
import type { LeadStatus } from "@/lib/affiliate-lead-rules";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export const metadata: Metadata = {
  title: "Affiliates — Marktmorgen",
  robots: { index: false, follow: false },
};

/**
 * The creator's affiliate programme: its terms, who applied, who is owed
 * what, and a record of what the creator paid them. On every plan. The money
 * never passes through Marktmorgen: the creator pays their affiliates themselves.
 */
export default async function StudioAffiliatesPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "settings" (lib/studio-route.ts).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  // What PayPal paid since the last look is written into the book first (lib/paypal-payouts.ts).
  await settlePayPal(store).catch((error) => console.error("settling PayPal payouts failed", error));
  const [paypal, away, owners, codeList, checks] = await Promise.all([
    // Not known is never shown as "not connected" (rule 24): undefined, and the panel says it could not be read.
    readPayPal(store).catch((error) => {
      console.error("reading the PayPal link failed", error);
      return undefined;
    }),
    onTheirWay(store).catch(() => null),
    codeOwners(store).catch(() => new Map<string, string>()),
    // The creator's own codes, so one of them can be given to an affiliate
    // (lib/affiliate-codes.ts). Only worth asking Stripe when they have made any.
    store.hasDiscounts && store.stripeAccountId
      ? listCodes(store.stripeAccountId).catch(() => ({ state: "error" as const }))
      : Promise.resolve({ state: "unavailable" as const }),
    // Payments whose answer from PayPal is not known (lib/paypal-payouts.ts): counted, never guessed.
    paypalChecks(store).catch(() => null),
  ]);
  // Partnerships other creators here have offered this one, waiting to be
  // accepted or declined (lib/partner-invites.ts). Read for the person signed
  // in, not for the store, because the offer was made to an address.
  const offers = (await waitingFor(view.email ?? store.email).catch(() => [])).map((invite) => ({
    id: invite.id,
    words: offerWords(invite),
    storeName: invite.storeName,
    percent: invite.share.percent,
  }));
  const codes =
    codeList.state === "ok"
      ? codeList.codes
          .filter((code) => code.active && code.off !== null)
          .map((code) => ({ id: code.id, code: code.code, label: offLabel(code.off as NonNullable<typeof code.off>) }))
      : [];
  const book = await readBook(store).catch((error) => {
    console.error("reading the affiliate book failed", error);
    return null;
  });
  // Every card, read once for the lists on this page.
  // Names only, which is one command rather than one per product. Which of
  // them are paid, and which are one-off rather than a membership, is already
  // in the store's own index — no product record is read here at all.
  const titles = await readTitles(store);
  const paid = new Set(idsOfKind(store, "paid"));
  const recurring = new Set(idsOfKind(store, "recurring"));

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
        <p className="eyebrow">Affiliates</p>
        <h1 className="t-h2 mt-3">People who sell for you</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Anyone can apply on your affiliate page and you decide who is in, or you let everyone who buys from you take a link
          without applying. Each affiliate gets their own link, and a one-time
          purchase made through it within your window earns them the share you set, worked out from what the buyer paid
          before tax and taken back if you refund the sale.
        </p>

        {!canSell(store) ? (
          <div className="notice notice-warn mt-6">
            <p className="font-bold text-ink">Your store is not selling yet</p>
            <p className="mt-1 text-sm text-ink-soft">
              You can set the program up now. Sales are credited to affiliates once your Stripe account is connected and
              your plan is running.
            </p>
          </div>
        ) : null}
        {!isSenderConfigured() ? (
          <div className="notice notice-warn mt-6">
            <p className="font-bold text-ink">Applications are closed on this deployment</p>
            <p className="mt-1 text-sm text-ink-soft">Email is not switched on here, and applying works through an emailed link.</p>
          </div>
        ) : null}
        {book === null ? (
          <p className="notice notice-error mt-6" role="alert">
            We could not read your affiliates just now. Nothing was changed. Try again in a moment.
          </p>
        ) : null}

        {offers.length ? (
          <div className="mt-8">
            <PartnerOffers offers={offers} />
          </div>
        ) : null}

        <AffiliateStudio
          handle={store.handle}
          setting={store.affiliates}
          products={[...titles]
            .filter(([id]) => paid.has(id))
            .map(([id, title]) => ({ id, title, credited: !recurring.has(id) || store.affiliates.recurring > 0, recurring: recurring.has(id) }))}
          rows={(book?.rows ?? []).map((row) => ({
            ...row,
            link: affiliateLink(store, row.affiliate.code),
          }))}
          lines={(book?.lines ?? []).filter((line) => line.how !== "lead").slice(0, 100).map((line) => ({
            ref: line.ref,
            at: line.at,
            title: line.title || titles.get(line.product) || "A product that is no longer listed",
            aff: line.aff,
            base: line.base,
            refunded: line.refunded,
            rate: line.rate,
            commission: line.commission,
            currency: line.currency,
            status: line.status,
            how: line.how,
            promotion: line.promotion ?? null,
          }))}
          linesTotal={book ? book.lines.filter((line) => line.how !== "lead").length : null}
          leads={(book?.lines ?? []).filter((line) => line.how === "lead" && line.lead).slice(0, 200).map((line) => ({
            id: line.lead!.id,
            aff: line.aff,
            kind: line.lead!.kind,
            email: line.lead!.email,
            title: line.title,
            at: line.at,
            status: line.status as LeadStatus,
            commission: line.commission,
            currency: line.currency,
            readyAt: line.lead!.readyAt,
            why: line.lead!.why,
          }))}
          leadsTotal={book ? book.lines.filter((line) => line.how === "lead").length : 0}
          payouts={book?.payouts ?? []}
          refundsChecked={book?.refundsChecked ?? true}
          invoicesChecked={book?.invoicesChecked ?? true}
          today={new Date().toISOString().slice(0, 10)}
          currency={store.currency}
          elsewhere={book?.elsewhere ?? 0}
          away={away ? [...away] : []}
          pendingPayoutsChecked={away !== null}
          codes={codes}
          codeOwners={Object.fromEntries(owners)}
          payPanel={
            paypal === undefined ? (
              <p className="notice notice-warn mt-5" role="alert">Your PayPal connection could not be read just now, so paying from PayPal is unavailable here. Nothing was changed. Reload the page to try again.</p>
            ) : book && away !== null && checks !== null ? (
              <PayPalPayouts
                initial={paypal}
                people={payableLines(book, away).length}
                cents={batchTotal(payableLines(book, away))}
                currency={store.currency}
                onTheirWay={away.size}
                checking={checks.checking}
                manualCheck={checks.manual}
                payday={store.affiliates.payday}
              />
            ) : null
          }
        />
      </main>
      </StudioStorePin>
    </div>
  );
}
